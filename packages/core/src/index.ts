import { EventEmitter } from "node:events";
import { Store } from "../../database/src/index";
import { MockAdapter } from "../../adapters/mock/src/index";
import {
  AdapterError,
  delay,
  type RetailerAdapter,
} from "../../retailer-sdk/src/index";
import {
  commandSchema,
  type Command,
  type TaskState,
  type Task,
} from "../../shared-types/src/index";
export const transitions: Record<TaskState, readonly TaskState[]> = {
  CREATED: ["MONITORING", "CANCELLED"],
  MONITORING: ["STOCK_DETECTED", "FAILED", "CANCELLED"],
  STOCK_DETECTED: ["CARTING", "FAILED", "CANCELLED"],
  CARTING: ["AWAITING_APPROVAL", "FAILED", "CANCELLED"],
  AWAITING_APPROVAL: ["CHECKING_OUT", "FAILED", "CANCELLED"],
  CHECKING_OUT: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: ["MONITORING"],
  FAILED: ["MONITORING"],
  CANCELLED: ["MONITORING"],
};
export function validateTransition(from: TaskState, to: TaskState) {
  if (!transitions[from].includes(to))
    throw new Error(`Invalid transition ${from} → ${to}`);
}
interface Active {
  controller: AbortController;
  promise: Promise<void>;
  approve?: () => void;
}
export class Engine extends EventEmitter {
  private active = new Map<string, Active>();
  private queue: string[] = [];
  private shuttingDown = false;
  constructor(
    readonly store: Store,
    private factory: () => RetailerAdapter = () => new MockAdapter(),
    private backoffMs = 300,
  ) {
    super();
    store.recover();
  }
  snapshot() {
    return { ...this.store.snapshot(), queued: [...this.queue] };
  }
  private publish() {
    this.emit("snapshot", this.snapshot());
  }
  private move(id: string, to: TaskState, message: string) {
    validateTransition(this.store.task(id).state, to);
    this.store.transition(id, to, message);
    this.publish();
  }
  isBusy(id: string) {
    return this.active.has(id) || this.queue.includes(id);
  }
  start(id: string) {
    if (this.shuttingDown) throw new Error("Engine is shutting down");
    const task = this.store.task(id);
    if (this.isBusy(id)) return;
    validateTransition(task.state, "MONITORING");
    this.queue.push(id);
    this.store.log(id, "Queued for execution");
    this.pump();
    this.publish();
  }
  private pump() {
    while (
      !this.shuttingDown &&
      this.queue.length &&
      this.active.size < this.store.snapshot().settings.concurrency
    ) {
      const id = this.queue.shift()!;
      const controller = new AbortController();
      const active: Active = { controller, promise: Promise.resolve() };
      this.active.set(id, active);
      active.promise = this.run(id, controller.signal).finally(() => {
        this.active.delete(id);
        this.pump();
        this.publish();
      });
    }
  }
  private async retry<T>(
    task: Task,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (
          signal.aborted ||
          !(error instanceof AdapterError) ||
          !error.retryable ||
          attempt >= task.maxRetries
        )
          throw error;
        const ms = Math.min(this.backoffMs * 2 ** attempt, 10000);
        this.store.log(
          task.id,
          `${error.message}; retry ${attempt + 1}/${task.maxRetries} in ${ms}ms`,
        );
        this.publish();
        await delay(ms, signal);
      }
    }
  }
  private async run(id: string, signal: AbortSignal) {
    try {
      this.store.begin(id);
      this.publish();
      const task = this.store.task(id);
      const adapter = this.factory();
      if (!adapter.capabilities.simulated)
        throw new Error("Only simulated adapters are enabled");
      while (
        !(await this.retry(task, signal, () => adapter.inventory(task, signal)))
      ) {
        if (this.store.snapshot().settings.logLevel === "debug") {
          this.store.log(id, "Product out of stock; monitoring continues");
          this.publish();
        }
      }
      if (signal.aborted) throw new Error("Cancelled");
      this.move(id, "STOCK_DETECTED", "Mock inventory available");
      this.move(id, "CARTING", "Creating simulated cart");
      const cart = await this.retry(task, signal, () =>
        adapter.cart(task, signal),
      );
      // Register approval before publishing the state to avoid a reentrant event race.
      const approval = new Promise<void>((resolve, reject) => {
        const aborted = () => {
          signal.removeEventListener("abort", aborted);
          reject(new Error("Cancelled"));
        };
        this.active.get(id)!.approve = () => {
          signal.removeEventListener("abort", aborted);
          resolve();
        };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
      this.move(
        id,
        "AWAITING_APPROVAL",
        "Simulated cart ready; approve to continue",
      );
      await approval;
      if (signal.aborted) throw new Error("Cancelled");
      this.move(id, "CHECKING_OUT", "Processing simulated checkout");
      // Checkout is deliberately not retried: future integrations must establish idempotency first.
      await adapter.checkout(task, cart, signal);
      if (signal.aborted) throw new Error("Cancelled");
      this.move(id, "COMPLETED", "Simulation completed; no purchase was made");
    } catch (error) {
      const state = signal.aborted ? "CANCELLED" : "FAILED";
      this.move(
        id,
        state,
        signal.aborted
          ? "Task stopped"
          : error instanceof Error
            ? error.message
            : "Execution failed",
      );
    }
  }
  async stop(id: string) {
    this.store.task(id);
    if (this.queue.includes(id)) {
      this.queue = this.queue.filter((item) => item !== id);
      if (this.store.task(id).state === "CREATED")
        this.move(id, "CANCELLED", "Queued task stopped");
      else {
        this.store.log(id, "Removed from queue");
        this.publish();
      }
    }
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.promise;
    }
  }
  approve(id: string) {
    if (this.store.task(id).state !== "AWAITING_APPROVAL")
      throw new Error("Task is not awaiting approval");
    const active = this.active.get(id);
    if (!active?.approve) throw new Error("No active approval");
    active.approve();
    active.approve = undefined;
  }
  async command(input: Command) {
    const cmd = commandSchema.parse(input);
    switch (cmd.type) {
      case "saveGroup":
        this.store.saveGroup(cmd.data);
        break;
      case "saveProfile":
        this.store.saveProfile(cmd.data);
        break;
      case "saveProxy":
        this.store.saveProxy(cmd.data);
        break;
      case "saveTask":
        if (cmd.data.id && this.isBusy(cmd.data.id))
          throw new Error("Stop the task before editing");
        this.store.saveTask(cmd.data);
        break;
      case "settings":
        this.store.settings(cmd.data);
        this.pump();
        break;
      case "start":
        this.start(cmd.id);
        break;
      case "stop":
        await this.stop(cmd.id);
        break;
      case "restart":
        await this.stop(cmd.id);
        this.start(cmd.id);
        break;
      case "approve":
        this.approve(cmd.id);
        break;
      case "duplicateTask": {
        const { id, state, runId, updatedAt, ...config } = this.store.task(
          cmd.id,
        );
        this.store.saveTask({ ...config, name: config.name + " copy" });
        break;
      }
      case "deleteTask":
        if (this.isBusy(cmd.id))
          throw new Error("Stop the task before deleting");
        this.store.delete("tasks", cmd.id);
        break;
      case "deleteGroup":
        if (
          this.store
            .snapshot()
            .tasks.some((t) => t.groupId === cmd.id && this.isBusy(t.id))
        )
          throw new Error("Stop tasks in this group before deleting");
        this.store.delete("groups", cmd.id);
        break;
      case "deleteProfile":
        this.store.delete("profiles", cmd.id);
        break;
      case "deleteProxy":
        this.store.delete("proxies", cmd.id);
        break;
    }
    this.publish();
    return this.snapshot();
  }
  async shutdown() {
    this.shuttingDown = true;
    this.queue = [];
    const active = [...this.active.values()];
    active.forEach((a) => a.controller.abort());
    await Promise.all(active.map((a) => a.promise));
  }
}
