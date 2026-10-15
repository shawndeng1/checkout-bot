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
  timer: ReturnType<typeof setTimeout>;
}
/** Main-process transport only. No database or engine is loaded in this isolate. */
export class BackendClient extends EventEmitter {
  private worker: Worker;
  private requests = new Map<number, Pending>();
  private sequence = 0;
  private closing = false;
  private available = false;
  private unresponsive = false;
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
      const bootTimer = setTimeout(() => {
        const error = new Error("Backend worker startup timed out");
        this.fail(error);
        reject(error);
        void this.worker.terminate();
      }, 10000);
      this.worker.on("message", (message) => {
        if (message.type === "ready") {
          clearTimeout(bootTimer);
          this.available = true;
          resolve();
          return;
        }
        if (message.type === "fatal") {
          clearTimeout(bootTimer);
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
        clearTimeout(pending.timer);
        this.requests.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.data);
      });
      this.worker.on("error", (error) => {
        clearTimeout(bootTimer);
        this.fail(error);
        reject(error);
      });
      this.worker.on("exit", (code) => {
        clearTimeout(bootTimer);
        if (!this.closing) {
          const error = new Error(`Backend worker exited (${code})`);
          this.fail(error);
          reject(error);
        }
      });
    });
  }
  private fail(error: Error) {
    this.available = false;
    this.failure = error;
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
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
      | "validateIntegration"
      | "discover"
      | "cancelDiscovery"
      | "history"
      | "suspendRetailer"
      | "clearCredential",
    command?: unknown,
  ): Promise<T> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (
      this.unresponsive &&
      !["metrics", "shutdown", "cancelDiscovery"].includes(type)
    )
      throw new Error(
        "Backend is unresponsive; wait for diagnostics or restart Orbit",
      );
    if (this.closing && type !== "shutdown")
      throw new Error("Backend is shutting down");
    if (this.requests.size >= 256)
      throw new Error("Backend request limit reached");
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.requests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer: setTimeout(
          () => {
            this.requests.delete(id);
            reject(new Error("Backend request timed out"));
          },
          type === "metrics" ? 2500 : 120000,
        ),
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
  discover(
    input: import("../../../packages/shared-types/src/index").DiscoveryInput,
  ) {
    return this.request<
      import("../../../packages/retailer-sdk/src/index").ProductPage
    >("discover", input);
  }
  cancelDiscovery(id: string) {
    return this.request<void>("cancelDiscovery", id);
  }
  history(
    input: import("../../../packages/shared-types/src/index").HistoryInput,
  ) {
    return this.request<
      import("../../../packages/shared-types/src/index").HistoryPage
    >("history", input);
  }
  suspendRetailer(id: string) {
    return this.request<void>("suspendRetailer", id);
  }
  clearCredential(id: string) {
    return this.request("clearCredential", id);
  }
  async diagnostics(): Promise<
    import("../../../packages/shared-types/src/index").Diagnostics
  > {
    if (this.available && !this.failure) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.metrics(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Diagnostics timed out")),
              3000,
            );
          }),
        ]);
        this.unresponsive = false;
        return result;
      } catch {
        this.unresponsive = true;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return {
      workerAvailable: false,
      sampledAt: new Date().toISOString(),
      activeTasks: 0,
      activeOperations: 0,
      peakOperations: 0,
      queued: 0,
      subscriptions: 0,
      subscribers: 0,
      inventoryPolls: 0,
      workerHeapBytes: 0,
      database: {
        available: false,
        journalMode: "unavailable",
        foreignKeys: 0,
      },
      eventLatency: { samples: 0, p50Ms: 0, p95Ms: 0 },
      recentErrors: [
        {
          at: new Date().toISOString(),
          code: this.failure ? "WORKER_EXIT" : "WORKER_UNRESPONSIVE",
        },
      ],
    };
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
      for (const pending of this.requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Backend closed"));
      }
      this.requests.clear();
    }
  }
}
