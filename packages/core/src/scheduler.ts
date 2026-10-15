import {
  delay,
  RetailerError,
  type RateLimitPolicy,
} from "../../retailer-sdk/src/index";
interface Waiter {
  id: string;
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: Error): void;
  abort(): void;
}
/** FIFO, abortable, bounded operation capacity. Waiting tasks hold no permit. */
export class CapacityPool {
  private waiting: Waiter[] = [];
  private used = 0;
  peak = 0;
  constructor(
    private limit: () => number,
    private changed: () => void = () => {},
    private maxQueue = 2000,
  ) {}
  get queued() {
    return this.waiting.map((item) => item.id);
  }
  get active() {
    return this.used;
  }
  acquire(id: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error("Cancelled"));
    if (this.waiting.length >= this.maxQueue)
      return Promise.reject(new Error("Execution queue is full"));
    return new Promise((resolve, reject) => {
      const item: Waiter = {
        id,
        signal,
        resolve,
        reject,
        abort: () => {
          this.waiting = this.waiting.filter((entry) => entry !== item);
          signal.removeEventListener("abort", item.abort);
          reject(new Error("Cancelled"));
          this.changed();
        },
      };
      signal.addEventListener("abort", item.abort, { once: true });
      this.waiting.push(item);
      this.pump();
    });
  }
  pump() {
    while (this.used < this.limit() && this.waiting.length) {
      const item = this.waiting.shift()!;
      item.signal.removeEventListener("abort", item.abort);
      if (item.signal.aborted) {
        item.reject(new Error("Cancelled"));
        continue;
      }
      this.used++;
      this.peak = Math.max(this.peak, this.used);
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.used--;
        this.pump();
        this.changed();
      });
    }
    this.changed();
  }
  async execute<T>(
    id: string,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(id, signal);
    try {
      if (signal.aborted) throw new Error("Cancelled");
      return await action();
    } finally {
      release();
    }
  }
}
interface RetailerGate {
  pool: CapacityPool;
  nextAt: number;
  cooldownUntil: number;
  policy: RateLimitPolicy;
}
export class RequestScheduler {
  readonly capacity: CapacityPool;
  private retailers = new Map<string, RetailerGate>();
  constructor(
    limit: () => number,
    policies: { id: string; rateLimit: RateLimitPolicy }[],
    changed: () => void = () => {},
  ) {
    this.capacity = new CapacityPool(limit, changed);
    for (const entry of policies)
      this.retailers.set(entry.id, {
        pool: new CapacityPool(() => entry.rateLimit.maxConcurrentRequests),
        nextAt: 0,
        cooldownUntil: 0,
        policy: entry.rateLimit,
      });
  }
  async execute<T>(
    retailer: string,
    id: string,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    const gate = this.retailers.get(retailer);
    if (!gate) throw new Error("No rate policy for retailer");
    return gate.pool.execute(id, signal, async () => {
      while (true) {
        const at = Math.max(gate.nextAt, gate.cooldownUntil);
        if (at > Date.now()) await delay(at - Date.now(), signal);
        const release = await this.capacity.acquire(id, signal);
        // Re-check after global queueing: another request may have learned a rate limit.
        if (signal.aborted) {
          release();
          throw new Error("Cancelled");
        }
        if (Math.max(gate.nextAt, gate.cooldownUntil) > Date.now()) {
          release();
          continue;
        }
        gate.nextAt = Date.now() + gate.policy.minIntervalMs;
        try {
          return await action();
        } catch (error) {
          if (error instanceof RetailerError && error.rateLimit)
            gate.cooldownUntil = Math.max(
              gate.cooldownUntil,
              Date.now() + error.rateLimit.retryAfterMs,
            );
          throw error;
        } finally {
          release();
        }
      }
    });
  }

  get queued() {
    return [
      ...new Set([
        ...this.capacity.queued,
        ...[...this.retailers.values()].flatMap((gate) => gate.pool.queued),
      ]),
    ];
  }
}
