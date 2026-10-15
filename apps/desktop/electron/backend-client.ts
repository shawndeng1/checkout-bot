import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import type {
  Command,
  Snapshot,
} from "../../../packages/shared-types/src/index";
interface Pending {
  resolve(value: Snapshot): void;
  reject(error: Error): void;
}
/** Main-process transport only. No database or engine is loaded in this isolate. */
export class BackendClient extends EventEmitter {
  private worker: Worker;
  private requests = new Map<number, Pending>();
  private sequence = 0;
  private closing = false;
  private failure?: Error;
  readonly ready: Promise<void>;
  constructor(workerPath: string, databasePath: string) {
    super();
    this.worker = new Worker(workerPath, { workerData: { databasePath } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("message", (message) => {
        if (message.type === "ready") {
          resolve();
          return;
        }
        if (message.type === "fatal") {
          this.fail(new Error(message.error));
          reject(this.failure);
          return;
        }
        if (message.type === "snapshot") {
          this.emit("snapshot", message.data);
          return;
        }
        const pending = this.requests.get(message.id);
        if (!pending) return;
        this.requests.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.data);
      });
      this.worker.on("error", (error) => {
        this.fail(error);
        reject(error);
      });
      this.worker.on("exit", (code) => {
        if (!this.closing || code !== 0) {
          const error = new Error(`Backend worker exited (${code})`);
          this.fail(error);
          reject(error);
        }
      });
    });
  }
  private fail(error: Error) {
    this.failure = error;
    for (const pending of this.requests.values()) pending.reject(error);
    this.requests.clear();
    this.emit("failure", error);
  }
  private async request(
    type: "snapshot" | "command" | "shutdown",
    command?: Command,
  ): Promise<Snapshot> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.closing && type !== "shutdown")
      throw new Error("Backend is shutting down");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, command });
    });
  }
  snapshot() {
    return this.request("snapshot");
  }
  command(command: Command) {
    return this.request("command", command);
  }
  async shutdown() {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.request("shutdown");
    } finally {
      await this.worker.terminate();
    }
  }
}
