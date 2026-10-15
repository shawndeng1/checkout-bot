import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import type {
  Command,
  Snapshot,
} from "../../../packages/shared-types/src/index";
import type { Engine } from "../../../packages/core/src/index";
interface Pending {
  resolve(value: unknown): void;
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
  constructor(
    workerPath: string,
    databasePath: string,
    credentials: Record<string, string> = {},
  ) {
    super();
    this.worker = new Worker(workerPath, {
      workerData: { databasePath, credentials },
    });
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
        if (message.type === "native-notification") {
          this.emit("native-notification", message.data);
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
        if (!this.closing) {
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
  private async request<T = Snapshot>(
    type:
      | "snapshot"
      | "command"
      | "shutdown"
      | "metrics"
      | "configure"
      | "validateIntegration",
    command?:
      | Command
      | {
          retailerId: string;
          config: Record<string, unknown>;
          credential?: string;
        },
  ): Promise<T> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.closing && type !== "shutdown")
      throw new Error("Backend is shutting down");
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.requests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ id, type, command });
    });
  }
  snapshot() {
    return this.request("snapshot");
  }
  command(command: Command) {
    return this.request("command", command);
  }
  configureIntegration(
    input: {
      retailerId: string;
      config: Record<string, unknown>;
      credential?: string;
    },
    validateOnly = false,
  ) {
    return this.request(
      validateOnly ? "validateIntegration" : "configure",
      input,
    );
  }
  metrics() {
    return this.request<ReturnType<Engine["diagnostics"]>>("metrics");
  }
  async shutdown() {
    if (this.closing) return;
    this.closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.request("shutdown"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Backend shutdown timed out; interrupted operations require recovery",
                ),
              ),
            10000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await this.worker.terminate();
      for (const pending of this.requests.values())
        pending.reject(new Error("Backend closed"));
      this.requests.clear();
    }
  }
}
