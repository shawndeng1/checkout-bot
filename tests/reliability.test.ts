import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Store } from "../packages/database/src/index";
import { Engine } from "../packages/core/src/index";
import { createAdapters } from "../packages/adapters/src/index";
import { ObservationTracker } from "../packages/core/src/inventory";
import { RequestScheduler } from "../packages/core/src/scheduler";
import {
  RetailerError,
  type InventoryObservation,
} from "../packages/retailer-sdk/src/index";
let store: Store, engine: Engine, groupId: string;
beforeEach(async () => {
  store = await Store.open(":memory:");
  engine = new Engine(store, createAdapters(), 10);
  groupId = store.saveGroup({ name: "Shared", retailer: "mock" });
  vi.useFakeTimers();
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  vi.useRealTimers();
});
function add(product = "SKU-42", scenario = "available") {
  return store.saveTask({
    groupId,
    name: "Task",
    product,
    scenario,
    intervalMs: 100,
    maxRetries: 2,
  });
}
it.each([10, 50, 100])(
  "shares monitoring for %i tasks and releases all subscription references",
  async (count) => {
    const ids = Array.from({ length: count }, () => add());
    ids.forEach((id) => engine.start(id));
    expect(engine.inventory.size).toBe(1);
    expect(engine.inventory.subscribers).toBe(count);
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      ids.every((id) => store.task(id).state === "AWAITING_APPROVAL"),
    ).toBe(true);
    expect(engine.diagnostics().inventoryPolls).toBe(3);
    expect(engine.inventory.size).toBe(0);
    expect(engine.inventory.subscribers).toBe(0);
    expect(engine.diagnostics().peakOperations).toBeLessThanOrEqual(3);
    expect(engine.diagnostics().activeOperations).toBe(0);
  },
);
it("approval waits release slots; duplicate approvals submit at most once through bounded capacity", async () => {
  store.settings({ ...store.getSettings(), concurrency: 1 });
  const ids = [add(), add(), add()];
  ids.forEach((id) => engine.start(id));
  await vi.advanceTimersByTimeAsync(1200);
  expect(ids.map((id) => store.task(id).state)).toEqual(
    ids.map(() => "AWAITING_APPROVAL"),
  );
  expect(engine.diagnostics().activeOperations).toBe(0);
  ids.forEach((id) => {
    engine.approve(id);
    engine.approve(id);
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(
    ids.filter((id) => store.task(id).state === "CHECKING_OUT"),
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(ids.every((id) => store.task(id).state === "COMPLETED")).toBe(true);
  expect(engine.diagnostics().peakOperations).toBe(1);
  ids.forEach((id) => expect(store.checkoutAttempts(id)).toHaveLength(1));
});
it("cancels an approved task waiting for checkout capacity without submitting it", async () => {
  store.settings({ ...store.getSettings(), concurrency: 1 });
  const a = add(),
    b = add();
  engine.start(a);
  engine.start(b);
  await vi.advanceTimersByTimeAsync(1000);
  engine.approve(a);
  engine.approve(b);
  await vi.advanceTimersByTimeAsync(1);
  await engine.stop(b);
  expect(store.task(b).state).toBe("CANCELLED");
  expect(store.checkoutAttempts(b)).toEqual([]);
  await vi.advanceTimersByTimeAsync(200);
  expect(store.task(a).state).toBe("COMPLETED");
});
it("cancels one subscriber without aborting the other; final unsubscribe cleans the poll", async () => {
  const a = add("same", "out-of-stock"),
    b = add("same", "out-of-stock");
  engine.start(a);
  engine.start(b);
  await vi.advanceTimersByTimeAsync(150);
  await engine.stop(a);
  expect(engine.inventory.subscribers).toBe(1);
  expect(store.task(b).state).toBe("MONITORING");
  await engine.stop(b);
  expect(engine.inventory.size).toBe(0);
  await engine.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not share incompatible products, profiles or simulation scenarios", () => {
  [add("first"), add("second"), add("first", "timeout")].forEach((id) =>
    engine.start(id),
  );
  expect(engine.inventory.size).toBe(3);
});
it("preserves approval carts on shutdown and restores them without resuming checkout", async () => {
  const id = add();
  engine.start(id);
  await vi.advanceTimersByTimeAsync(1000);
  const run = store.task(id).runId;
  await engine.shutdown();
  expect(store.task(id).state).toBe("AWAITING_APPROVAL");
  engine = new Engine(store, createAdapters(), 10);
  await vi.advanceTimersByTimeAsync(1000);
  expect(store.task(id).state).toBe("AWAITING_APPROVAL");
  expect(store.task(id).runId).toBe(run);
  expect(engine.diagnostics().inventoryPolls).toBe(0);
  engine.approve(id);
  await vi.advanceTimersByTimeAsync(200);
  expect(store.task(id).state).toBe("COMPLETED");
});
it("marks an interrupted submission unknown and prohibits restart or automatic retry", async () => {
  const id = add();
  engine.start(id);
  await vi.advanceTimersByTimeAsync(1000);
  engine.approve(id);
  await vi.advanceTimersByTimeAsync(1);
  expect(store.task(id).state).toBe("CHECKING_OUT");
  await engine.stop(id);
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(store.checkoutAttempts(id)[0].status).toBe("unknown");
  expect(() => engine.start(id)).toThrow("Invalid transition");
  await engine.shutdown();
  engine = new Engine(store, createAdapters(), 10);
  await vi.advanceTimersByTimeAsync(1000);
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(engine.isBusy(id)).toBe(false);
  expect(store.checkoutAttempts(id)).toHaveLength(1);
});
it("recovers checkout intent after a crash and only auto-resumes configured monitoring", async () => {
  const id = add();
  store.begin(id);
  store.prepareApproval(id, {
    id: "cart",
    product: { productId: "SKU-42" },
    quantity: 1,
  });
  store.beginCheckout(id, {
    id: "cart",
    product: { productId: "SKU-42" },
    quantity: 1,
  });
  const monitor = add("other");
  store.begin(monitor);
  store.settings({ ...store.getSettings(), resumeMonitoring: true });
  await engine.shutdown();
  engine = new Engine(store, createAdapters(), 10);
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(store.task(monitor).state).toBe("MONITORING");
  expect(store.checkoutAttempts(id)[0].status).toBe("unknown");
  expect(store.snapshot().runs.find((run) => run.taskId === id)?.recovery).toBe(
    "checkout-unknown",
  );
});
it("suppresses duplicate and stale observations including retired source streams", () => {
  const tracker = new ObservationTracker();
  const event: InventoryObservation = {
    eventId: "one",
    streamId: "stream1",
    retailerId: "mock",
    product: { productId: "x" },
    sequence: 1,
    observedAt: 100,
    availability: "out-of-stock",
  };
  expect(tracker.accept(event)).toBe(true);
  expect(tracker.accept({ ...event, observedAt: 101 })).toBe(false);
  expect(tracker.accept({ ...event, eventId: "older", sequence: 0 })).toBe(
    false,
  );
  expect(
    tracker.accept({ ...event, eventId: "late", sequence: 2, observedAt: 99 }),
  ).toBe(false);
  expect(
    tracker.accept({
      ...event,
      eventId: "new",
      streamId: "stream2",
      observedAt: 101,
    }),
  ).toBe(true);
  expect(
    tracker.accept({
      ...event,
      eventId: "retired",
      sequence: 3,
      observedAt: 102,
    }),
  ).toBe(false);
});
it("enforces retailer pacing and shared Retry-After cooldowns", async () => {
  const scheduler = new RequestScheduler(
    () => 10,
    [
      {
        id: "test",
        rateLimit: { minIntervalMs: 50, maxConcurrentRequests: 1 },
      },
    ],
  );
  const signal = new AbortController().signal;
  const times: number[] = [];
  const one = scheduler
    .execute("test", "a", signal, async () => {
      times.push(Date.now());
      throw new RetailerError("Limited", "RATE_LIMIT", true, {
        retryAfterMs: 100,
      });
    })
    .catch(() => {});
  const two = scheduler.execute("test", "b", signal, async () => {
    times.push(Date.now());
  });
  await vi.advanceTimersByTimeAsync(200);
  await Promise.all([one, two]);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
});
it("applies a newly discovered cooldown to requests already queued for global capacity", async () => {
  const scheduler = new RequestScheduler(
    () => 1,
    [{ id: "test", rateLimit: { minIntervalMs: 0, maxConcurrentRequests: 2 } }],
  );
  const signal = new AbortController().signal;
  const times: number[] = [];
  const first = scheduler
    .execute("test", "a", signal, async () => {
      times.push(Date.now());
      throw new RetailerError("Limited", "RATE_LIMIT", true, {
        retryAfterMs: 100,
      });
    })
    .catch(() => {});
  const second = scheduler.execute("test", "b", signal, async () => {
    times.push(Date.now());
  });
  await vi.advanceTimersByTimeAsync(200);
  await Promise.all([first, second]);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
});
it("logs normalized out-of-stock observations when debug logging is enabled", async () => {
  store.settings({ ...store.getSettings(), logLevel: "debug" });
  const id = add();
  engine.start(id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    store.snapshot().logs.filter((log) => log.message.includes("out of stock")),
  ).toHaveLength(2);
});
it("preserves saved approvals when an optional retailer is unavailable without blocking application startup", async () => {
  const { AdapterRegistry } =
    await import("../packages/retailer-sdk/src/index");
  const id = add();
  engine.start(id);
  await vi.advanceTimersByTimeAsync(1000);
  await engine.shutdown();
  engine = new Engine(store, new AdapterRegistry(), 10);
  expect(store.task(id).state).toBe("AWAITING_APPROVAL");
  expect(store.approval(id)).toBeDefined();
  expect(() => engine.approve(id)).toThrow("unavailable");
  await engine.stop(id);
  expect(store.task(id).state).toBe("CANCELLED");
  expect(store.approval(id)).toBeUndefined();
});
it("does not change a task group retailer while its tasks are executing", async () => {
  const id = add();
  engine.start(id);
  await expect(
    engine.command({
      type: "saveGroup",
      data: { id: groupId, name: "Changed", retailer: "different" },
    }),
  ).rejects.toThrow("Stop tasks");
  expect(store.group(groupId).retailer).toBe("mock");
});
it("bounds the execution queue and cancels saturated waiters cleanly", async () => {
  const { CapacityPool } = await import("../packages/core/src/scheduler");
  const pool = new CapacityPool(
    () => 0,
    () => {},
    1,
  );
  const controller = new AbortController();
  const waiting = pool
    .acquire("one", controller.signal)
    .catch((error) => error);
  await expect(
    pool.acquire("two", new AbortController().signal),
  ).rejects.toThrow("queue is full");
  controller.abort();
  expect((await waiting).message).toBe("Cancelled");
  expect(pool.queued).toEqual([]);
});
it("does not cart or fan out stale in-stock events before a fresh inventory observation", async () => {
  const { MockAdapter } = await import("../packages/adapters/mock/src/index");
  const { AdapterRegistry, productRef, simulatedCapabilities } =
    await import("../packages/retailer-sdk/src/index");
  await engine.shutdown();
  let polls = 0;
  let carts = 0;
  const adapter = new MockAdapter();
  adapter.observe = async (task) => {
    polls++;
    return {
      eventId: `event-${polls}`,
      streamId: "test",
      retailerId: "mock",
      product: productRef(task),
      sequence: polls === 1 ? 2 : polls === 2 ? 1 : 3,
      observedAt: Date.now(),
      availability: polls === 1 ? "out-of-stock" : "in-stock",
    };
  };
  const createCart = adapter.createCart.bind(adapter);
  adapter.createCart = async (task, signal) => {
    carts++;
    return createCart(task, signal);
  };
  const registry = new AdapterRegistry().register({
    id: "mock",
    name: "Scripted",
    capabilities: simulatedCapabilities,
    rateLimit: { minIntervalMs: 0, maxConcurrentRequests: 1 },
    create: () => adapter,
  });
  engine = new Engine(store, registry, 10);
  const id = add();
  engine.start(id);
  await vi.advanceTimersByTimeAsync(150);
  expect(store.task(id).state).toBe("MONITORING");
  expect(carts).toBe(0);
  await vi.advanceTimersByTimeAsync(300);
  expect(store.task(id).state).toBe("AWAITING_APPROVAL");
  expect(carts).toBe(1);
});
