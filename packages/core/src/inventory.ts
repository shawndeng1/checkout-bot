import {
  delay,
  RetailerError,
  type InventoryObservation,
  type RetailerAdapter,
} from "../../retailer-sdk/src/index";
import type { Task } from "../../shared-types/src/index";
import { RequestScheduler } from "./scheduler";
/** Suppress duplicates, older timestamps and non-increasing source sequences. */
export class ObservationTracker {
  private lastAt = -Infinity;
  private lastSequence = -1;
  private stream = "";
  private retired = new Set<string>();
  private ids = new Set<string>();
  accept(event: InventoryObservation) {
    if (
      event.observedAt < this.lastAt ||
      this.ids.has(`${event.streamId}:${event.eventId}`) ||
      this.retired.has(event.streamId)
    )
      return false;
    if (event.streamId === this.stream && event.sequence <= this.lastSequence)
      return false;
    if (event.streamId !== this.stream) {
      if (this.stream) this.retired.add(this.stream);
      this.stream = event.streamId;
      this.lastSequence = -1;
    }
    this.lastAt = event.observedAt;
    this.lastSequence = event.sequence;
    this.ids.add(`${event.streamId}:${event.eventId}`);
    if (this.ids.size > 128) this.ids.delete(this.ids.values().next().value!);
    if (this.retired.size > 128)
      this.retired.delete(this.retired.values().next().value!);
    return true;
  }
}
interface Subscriber {
  id: string;
  resolve(value: InventoryObservation): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  abort(): void;
}
interface Subscription {
  key: string;
  task: Task;
  adapter: RetailerAdapter;
  controller: AbortController;
  subscribers: Map<string, Subscriber>;
  tracker: ObservationTracker;
}
export class SharedInventory {
  private subscriptions = new Map<string, Subscription>();
  polls = 0;
  private running = new Set<Promise<void>>();
  async drain() {
    await Promise.all([...this.running]);
  }
  constructor(
    private scheduler: RequestScheduler,
    private log: (ids: string[], message: string) => void,
    private backoffMs = 300,
    private outOfStock: (ids: string[]) => void = () => {},
  ) {}
  get size() {
    return this.subscriptions.size;
  }
  get subscribers() {
    return [...this.subscriptions.values()].reduce(
      (sum, entry) => sum + entry.subscribers.size,
      0,
    );
  }
  private key(task: Task, adapter: RetailerAdapter) {
    return JSON.stringify([
      adapter.id,
      task.product.trim(),
      task.variantId ?? null,
      task.profileId,
      task.proxyId,
      task.intervalMs,
      task.maxRetries,
      adapter.inventoryScope(task),
      adapter.capabilities.sharedInventory ? null : task.id,
    ]);
  }
  wait(
    task: Task,
    adapter: RetailerAdapter,
    signal: AbortSignal,
  ): Promise<InventoryObservation> {
    if (signal.aborted) return Promise.reject(new Error("Cancelled"));
    const key = this.key(task, adapter);
    let entry = this.subscriptions.get(key);
    if (!entry) {
      entry = {
        key,
        task,
        adapter,
        controller: new AbortController(),
        subscribers: new Map(),
        tracker: new ObservationTracker(),
      };
      this.subscriptions.set(key, entry);
      const subscription = entry;
      const running = Promise.resolve().then(() => this.poll(subscription));
      this.running.add(running);
      void running.finally(() => this.running.delete(running));
    }
    const subscription = entry;
    if (subscription.subscribers.has(task.id))
      return Promise.reject(new Error("Task already subscribed"));
    return new Promise((resolve, reject) => {
      const subscriber: Subscriber = {
        id: task.id,
        resolve,
        reject,
        signal,
        abort: () => {
          this.remove(subscription, subscriber);
          reject(new Error("Cancelled"));
        },
      };
      subscription.subscribers.set(task.id, subscriber);
      signal.addEventListener("abort", subscriber.abort, { once: true });
    });
  }
  private remove(entry: Subscription, subscriber: Subscriber) {
    subscriber.signal.removeEventListener("abort", subscriber.abort);
    entry.subscribers.delete(subscriber.id);
    if (!entry.subscribers.size) {
      entry.controller.abort();
      if (this.subscriptions.get(entry.key) === entry)
        this.subscriptions.delete(entry.key);
    }
  }
  private async poll(entry: Subscription) {
    const signal = entry.controller.signal;
    let attempts = 0;
    try {
      while (!signal.aborted) {
        try {
          const event = await this.scheduler.execute(
            entry.adapter.id,
            entry.task.id,
            signal,
            () => {
              this.polls++;
              return entry.adapter.observe(entry.task, signal);
            },
          );
          attempts = 0;
          if (
            event.retailerId !== entry.adapter.id ||
            event.product.productId !== entry.task.product ||
            (event.product.variantId ?? null) !== (entry.task.variantId ?? null)
          )
            throw new RetailerError(
              "Inventory product mismatch",
              "INVALID_RESPONSE",
              false,
            );
          if (entry.tracker.accept(event)) {
            if (event.availability === "in-stock") {
              for (const subscriber of [...entry.subscribers.values()]) {
                this.remove(entry, subscriber);
                subscriber.resolve(event);
              }
              return;
            }
            this.outOfStock([...entry.subscribers.keys()]);
          }
          await delay(entry.task.intervalMs, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          if (
            !(error instanceof RetailerError) ||
            !error.retryable ||
            attempts >= entry.task.maxRetries
          )
            throw error;
          const ms = Math.max(
            error.rateLimit?.retryAfterMs ?? 0,
            Math.min(this.backoffMs * 2 ** attempts, 10000),
          );
          attempts++;
          this.log(
            [...entry.subscribers.keys()],
            `${error.message}; retry ${attempts}/${entry.task.maxRetries} in ${ms}ms`,
          );
          await delay(ms, signal);
        }
      }
    } catch (error) {
      for (const subscriber of [...entry.subscribers.values()]) {
        this.remove(entry, subscriber);
        subscriber.reject(error);
      }
    }
  }
}
