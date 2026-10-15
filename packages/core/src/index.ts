import { EventEmitter } from "node:events";
import { Store } from "../../database/src/index";
import {
  AdapterRegistry,
  RetailerError,
  delay,
  type RetailerAdapter,
  type CartResult,
} from "../../retailer-sdk/src/index";
import {
  commandSchema,
  type Command,
  type TaskState,
  type Task,
} from "../../shared-types/src/index";
import { RequestScheduler } from "./scheduler";
import { SharedInventory } from "./inventory";
export const transitions: Record<TaskState, readonly TaskState[]> = {
  CREATED: ["MONITORING", "CANCELLED"],
  MONITORING: ["STOCK_DETECTED", "FAILED", "CANCELLED"],
  STOCK_DETECTED: ["MONITORING", "CARTING", "FAILED", "CANCELLED"],
  CARTING: ["AWAITING_APPROVAL", "FAILED", "CANCELLED"],
  AWAITING_APPROVAL: ["CHECKING_OUT", "FAILED", "CANCELLED"],
  CHECKING_OUT: ["COMPLETED", "FAILED", "UNKNOWN_OUTCOME"],
  COMPLETED: ["MONITORING"],
  FAILED: ["MONITORING"],
  CANCELLED: ["MONITORING"],
  UNKNOWN_OUTCOME: ["COMPLETED", "FAILED"],
};
export function validateTransition(from: TaskState, to: TaskState) {
  if (!transitions[from].includes(to))
    throw new Error(`Invalid transition ${from} → ${to}`);
}
interface Active {
  id: string;
  adapter: RetailerAdapter;
  controller: AbortController;
  promise: Promise<void>;
  approve?: () => void;
  approved: boolean;
  checkoutStarted: boolean;
}
export class Engine extends EventEmitter {
  private active = new Map<string, Active>();
  private shuttingDown = false;
  private reconciling = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private eventTimer?: ReturnType<typeof setTimeout>;
  readonly scheduler: RequestScheduler;
  readonly inventory: SharedInventory;
  constructor(
    readonly store: Store,
    readonly registry: AdapterRegistry,
    private backoffMs = 300,
    private credentials: Record<string, string> = {},
  ) {
    super();
    this.scheduler = new RequestScheduler(
      () => store.getSettings().concurrency,
      registry.list(),
      () => this.publish(),
    );
    this.inventory = new SharedInventory(
      this.scheduler,
      (ids, message) => {
        for (const id of ids) store.log(id, message);
        this.publish();
      },
      backoffMs,
      (ids) => {
        if (store.getSettings().logLevel === "debug") {
          for (const id of ids)
            store.log(id, "Product out of stock; monitoring continues");
          this.publish();
        }
      },
      (ids, event, changed) => {
        const notice = store.recordInventory(ids, event, changed);
        if (notice && store.getSettings().nativeNotifications)
          this.emit("native-notification", notice);
        this.publish();
      },
    );
    const resume = store.recover();
    for (const task of store.snapshot().tasks)
      if (task.state === "AWAITING_APPROVAL") {
        if (registry.has(store.group(task.groupId).retailer))
          this.launch(task.id, store.approval(task.id)!.cart);
        else
          store.log(
            task.id,
            "Approval preserved; retailer adapter unavailable on this launch",
          );
      }
    for (const id of resume) {
      if (registry.has(store.group(store.task(id).groupId).retailer)) {
        try {
          this.start(id);
        } catch {
          store.log(
            id,
            "Monitoring recovery paused; verify adapter configuration and secure credentials",
          );
        }
      } else
        store.log(
          id,
          "Monitoring recovery paused; retailer adapter unavailable",
        );
    }
    this.store.nextRevision();
  }
  snapshot() {
    return {
      ...this.store.snapshot(),
      retailers: this.registry.list().map((retailer) => ({
        ...retailer,
        config: this.store.retailerConfig(retailer.id),
        credentialConfigured: !!this.credentials[retailer.id],
      })),
      queued: this.scheduler.queued,
    };
  }
  private publish() {
    this.store.nextRevision();
    if (!this.eventTimer && !this.shuttingDown)
      this.eventTimer = setTimeout(() => {
        this.eventTimer = undefined;
        this.emit("snapshot", this.snapshot());
      }, 16);
  }
  private move(id: string, to: TaskState, message: string) {
    validateTransition(this.store.task(id).state, to);
    this.store.transition(id, to, message);
    this.publish();
  }
  isBusy(id: string) {
    return (
      this.active.has(id) ||
      this.reconciling.has(id) ||
      this.store.approval(id) !== undefined
    );
  }
  diagnostics() {
    return {
      activeOperations: this.scheduler.capacity.active,
      peakOperations: this.scheduler.capacity.peak,
      activeTasks: this.active.size,
      queued: this.scheduler.queued.length,
      subscriptions: this.inventory.size,
      subscribers: this.inventory.subscribers,
      inventoryPolls: this.inventory.polls,
      workerHeapBytes: process.memoryUsage().heapUsed,
    };
  }
  start(id: string) {
    if (this.shuttingDown) throw new Error("Engine is shutting down");
    const task = this.store.task(id);
    if (this.isBusy(id)) return;
    validateTransition(task.state, "MONITORING");
    this.launch(id);
  }
  private launch(id: string, cart?: CartResult) {
    if (this.active.size >= 1000)
      throw new Error("Task execution limit reached");
    const task = this.store.task(id);
    const retailer = this.store.group(task.groupId).retailer;
    const adapter = this.registry.create(
      retailer,
      this.store.retailerConfig(retailer),
      this.credentials[retailer],
    );
    if (
      !adapter.capabilities.inventory ||
      (task.workflow === "MONITOR_AND_CHECKOUT" &&
        (!adapter.capabilities.simulated ||
          !adapter.capabilities.cart ||
          !adapter.capabilities.checkout))
    )
      throw new Error(
        "Adapter does not support this task workflow; real adapters are inventory-only",
      );
    const context: Active = {
      id,
      adapter,
      controller: new AbortController(),
      promise: Promise.resolve(),
      approved: false,
      checkoutStarted: false,
    };
    this.active.set(id, context);
    context.promise = this.run(context, cart)
      .catch((error) => this.emit("fault", error))
      .then(() => {
        this.active.delete(id);
        try {
          this.publish();
        } catch (error) {
          this.emit("fault", error);
        }
      });
  }
  private approval(context: Active): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = context.controller.signal;
      const abort = () => {
        signal.removeEventListener("abort", abort);
        context.approve = undefined;
        reject(new Error("Cancelled"));
      };
      context.approve = () => {
        signal.removeEventListener("abort", abort);
        context.approve = undefined;
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private async retry<T>(
    task: Task,
    adapter: RetailerAdapter,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.scheduler.execute(
          adapter.id,
          task.id,
          signal,
          action,
        );
      } catch (error) {
        if (
          signal.aborted ||
          !(error instanceof RetailerError) ||
          !error.retryable ||
          attempt >= task.maxRetries
        )
          throw error;
        const ms = Math.max(
          error.rateLimit?.retryAfterMs ?? 0,
          Math.min(this.backoffMs * 2 ** attempt, 10000),
        );
        this.store.log(
          task.id,
          `${error.message}; retry ${attempt + 1}/${task.maxRetries} in ${ms}ms`,
        );
        this.publish();
        await delay(ms, signal);
      }
    }
  }
  private async run(context: Active, savedCart?: CartResult) {
    const { id, adapter } = context;
    const signal = context.controller.signal;
    try {
      let cart = savedCart;
      if (!cart) {
        this.store.begin(id);
        this.publish();
        const task = this.store.task(id);
        if (task.workflow !== "MONITOR_AND_CHECKOUT") {
          await this.inventory.watch(task, adapter, signal);
          return;
        }
        await this.inventory.wait(task, adapter, signal);
        if (signal.aborted) throw new Error("Cancelled");
        this.move(id, "STOCK_DETECTED", "Inventory available");
        this.move(id, "CARTING", "Creating simulated cart");
        cart = await this.retry(task, adapter, signal, () =>
          adapter.createCart!(task, signal),
        );
        if (signal.aborted) throw new Error("Cancelled");
        validateTransition(this.store.task(id).state, "AWAITING_APPROVAL");
        this.store.prepareApproval(id, cart);
      }
      // Waits own a task context and durable cart, but no execution permit.
      const approval = this.approval(context);
      this.publish();
      await approval;
      const task = this.store.task(id);
      const checkoutCart = cart;
      await this.scheduler.execute(adapter.id, id, signal, async () => {
        if (checkoutCart.expiresAt && checkoutCart.expiresAt <= Date.now())
          throw new RetailerError("Simulated cart expired", "DECLINED", false);
        validateTransition(this.store.task(id).state, "CHECKING_OUT");
        // Durable intent/idempotency key is committed before any submission can happen.
        const key = this.store.beginCheckout(
          id,
          checkoutCart,
          adapter.id,
          adapter.inventoryScope(task),
        );
        context.checkoutStarted = true;
        this.publish();
        const result = await adapter.submitCheckout!(
          task,
          checkoutCart,
          key,
          signal,
        );
        if (result.idempotencyKey !== key)
          throw new RetailerError(
            "Checkout response idempotency mismatch",
            "INVALID_RESPONSE",
            false,
            undefined,
            "unknown",
          );
        validateTransition(this.store.task(id).state, "COMPLETED");
        this.store.finishCheckout(
          id,
          "COMPLETED",
          "Simulation completed; no purchase was made",
          result,
        );
        this.publish();
      });
    } catch (error) {
      const task = this.store.task(id);
      if (
        this.shuttingDown &&
        !context.checkoutStarted &&
        (task.state === "AWAITING_APPROVAL" ||
          ((task.state === "MONITORING" ||
            (task.state === "STOCK_DETECTED" &&
              task.workflow !== "MONITOR_AND_CHECKOUT")) &&
            this.store.getSettings().resumeMonitoring))
      ) {
        this.store.log(
          id,
          task.state === "AWAITING_APPROVAL"
            ? "Approval preserved for next launch"
            : "Monitoring preserved for configured recovery",
        );
        return;
      }
      const unknown =
        context.checkoutStarted &&
        (!(error instanceof RetailerError) ||
          error.outcome === "unknown" ||
          signal.aborted);
      const state = unknown
        ? "UNKNOWN_OUTCOME"
        : signal.aborted
          ? "CANCELLED"
          : "FAILED";
      validateTransition(task.state, state);
      const message = unknown
        ? "Checkout outcome unknown; automatic retry prohibited"
        : signal.aborted
          ? "Task stopped"
          : error instanceof Error
            ? error.message
            : "Execution failed";
      if (context.checkoutStarted)
        this.store.finishCheckout(id, state, message);
      else this.store.transition(id, state, message);
      this.publish();
    }
  }
  async stop(id: string) {
    this.store.task(id);
    const lookup = this.reconciling.get(id);
    if (lookup) {
      lookup.controller.abort();
      await lookup.promise;
      return;
    }
    const context = this.active.get(id);
    if (context) {
      context.controller.abort();
      await context.promise;
    } else if (this.store.task(id).state === "AWAITING_APPROVAL")
      this.move(id, "CANCELLED", "Saved approval cancelled");
  }
  approve(id: string) {
    if (this.store.task(id).state !== "AWAITING_APPROVAL") {
      if (this.active.get(id)?.approved) return;
      throw new Error("Task is not awaiting approval");
    }
    const context = this.active.get(id);
    if (!context)
      throw new Error(
        "Approval cannot resume: retailer adapter is unavailable; restart with the registered adapter or stop this task",
      );
    if (context.approved) return;
    if (!context.approve) throw new Error("Approval is not ready");
    context.approved = true;
    context.approve();
    this.publish();
  }
  async configureIntegration(
    retailerId: string,
    config: Record<string, unknown>,
    credential?: string,
    validateOnly = false,
  ) {
    if (
      this.store
        .snapshot()
        .tasks.some(
          (task) =>
            this.store.group(task.groupId).retailer === retailerId &&
            this.isBusy(task.id),
        )
    )
      throw new Error("Stop retailer tasks before changing configuration");
    const validated = this.registry.validateConfig(retailerId, config);
    this.registry.create(
      retailerId,
      validated,
      credential ?? this.credentials[retailerId],
    );
    if (validateOnly) return this.snapshot();
    this.store.saveRetailerConfig(retailerId, validated);
    if (credential !== undefined) this.credentials[retailerId] = credential;
    this.publish();
    return this.snapshot();
  }
  reconcile(id: string): Promise<void> {
    if (this.shuttingDown) throw new Error("Engine is shutting down");
    const pending = this.reconciling.get(id);
    if (pending) return pending.promise;
    const task = this.store.task(id);
    const attempt = task.runId ? this.store.attempt(task.runId) : undefined;
    if (task.state !== "UNKNOWN_OUTCOME") {
      if (attempt?.lastStatus?.authoritative) return Promise.resolve();
      throw new Error("Task has no unknown checkout outcome");
    }
    if (!attempt) throw new Error("Checkout attempt unavailable");
    const row = this.store.beginReconciliation(id);
    const controller = new AbortController();
    const context = { controller, promise: Promise.resolve() };
    this.reconciling.set(id, context);
    context.promise = (async () => {
      try {
        const retailer =
          attempt.retailerId ?? this.store.group(task.groupId).retailer;
        const adapter = this.registry.create(
          retailer,
          this.store.retailerConfig(retailer),
          this.credentials[retailer],
        );
        if (
          !adapter.capabilities.simulated ||
          !adapter.capabilities.orderStatus ||
          !adapter.lookupOrder
        )
          throw new Error("Order status adapter unavailable");
        if (attempt.configFingerprint !== adapter.inventoryScope(task))
          throw new Error(
            "Retailer configuration changed; source cannot be verified",
          );
        const result = await this.scheduler.execute(
          retailer,
          id,
          controller.signal,
          () => adapter.lookupOrder!(attempt.id, controller.signal),
        );
        if (controller.signal.aborted) throw new Error("Cancelled");
        this.store.finishReconciliation(row.id, result);
      } catch (error) {
        this.store.finishReconciliation(
          row.id,
          undefined,
          controller.signal.aborted
            ? "Status lookup cancelled; outcome remains unknown"
            : error instanceof Error
              ? error.message
              : "Status lookup failed",
        );
      }
    })().finally(() => {
      this.reconciling.delete(id);
      this.publish();
    });
    this.publish();
    return context.promise;
  }
  async command(input: Command) {
    const cmd = commandSchema.parse(input);
    switch (cmd.type) {
      case "saveGroup":
        if (
          cmd.data.id &&
          this.store.group(cmd.data.id).retailer !== cmd.data.retailer &&
          this.store
            .snapshot()
            .tasks.some(
              (task) => task.groupId === cmd.data.id && this.isBusy(task.id),
            )
        )
          throw new Error("Stop tasks before changing their retailer");
        this.registry.get(cmd.data.retailer);
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
        const definition = this.registry.get(
          this.store.group(cmd.data.groupId).retailer,
        );
        if (
          cmd.data.workflow === "MONITOR_AND_CHECKOUT" &&
          (!definition.capabilities.simulated ||
            !definition.capabilities.cart ||
            !definition.capabilities.checkout)
        )
          throw new Error("This retailer supports inventory workflows only");
        this.store.saveTask(cmd.data);
        break;
      case "settings":
        this.store.settings(cmd.data);
        this.scheduler.capacity.pump();
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
      case "reconcile":
        await this.reconcile(cmd.id);
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
    const lookups = [...this.reconciling.values()];
    lookups.forEach((item) => item.controller.abort());
    await Promise.all(lookups.map((item) => item.promise));
    const active = [...this.active.values()];
    active.forEach((context) => context.controller.abort());
    await Promise.all(active.map((context) => context.promise));
    await this.inventory.drain();
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
    this.emit("snapshot", this.snapshot());
  }
}
