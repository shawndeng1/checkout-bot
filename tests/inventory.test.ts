import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Store } from "../packages/database/src/index";
import { Engine } from "../packages/core/src/index";
import {
  AdapterRegistry,
  simulatedCapabilities,
  productRef,
  RetailerError,
  type RetailerAdapter,
  type InventoryObservation,
} from "../packages/retailer-sdk/src/index";
let store: Store, engine: Engine, groupId: string;
let available = false,
  sequence = 1,
  calls = 0,
  expired = false,
  limited = 0;
const capabilities = { ...simulatedCapabilities, cart: false, checkout: false };
let observation:
  | ((
      task: Parameters<NonNullable<RetailerAdapter["observe"]>>[0],
    ) => InventoryObservation)
  | undefined;
beforeEach(async () => {
  store = await Store.open(":memory:");
  available = false;
  sequence = 1;
  calls = 0;
  expired = false;
  limited = 0;
  observation = undefined;
  const adapter: RetailerAdapter = {
    id: "watch",
    capabilities,
    inventoryScope: () => "public",
    observe: async (task) => {
      calls++;
      if (limited-- > 0)
        throw new RetailerError("Rate limit", "RATE_LIMIT", true, {
          retryAfterMs: 200,
        });
      return (
        observation?.(task) ?? {
          eventId: `event-${sequence}`,
          streamId: "source",
          retailerId: "watch",
          product: productRef(task),
          sequence,
          observedAt: Date.now(),
          expiresAt: Date.now() + (expired ? -1 : 30000),
          availability: available ? "in-stock" : "out-of-stock",
        }
      );
    },
  };
  const registry = new AdapterRegistry().register({
    id: "watch",
    name: "Inventory only",
    capabilities,
    rateLimit: { minIntervalMs: 50, maxConcurrentRequests: 1 },
    create: () => adapter,
  });
  engine = new Engine(store, registry, 10);
  groupId = store.saveGroup({ name: "Watches", retailer: "watch" });
  vi.useFakeTimers();
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  vi.useRealTimers();
});
function add(
  workflow = "MONITOR_AND_NOTIFY",
  variantId: string | null = "blue",
) {
  return store.saveTask({
    groupId,
    name: "Watch",
    product: "x",
    variantId,
    workflow,
    scenario: "available",
    intervalMs: 100,
    maxRetries: 2,
  });
}
it.each([10, 50, 100])(
  "continuously shares %i inventory-only watches without cart methods or checkout permits",
  async (count) => {
    const ids = Array.from({ length: count }, () => add());
    ids.forEach((id) => engine.start(id));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    expect(engine.inventory.size).toBe(1);
    available = true;
    sequence++;
    await vi.advanceTimersByTimeAsync(100);
    expect(ids.every((id) => store.task(id).state === "STOCK_DETECTED")).toBe(
      true,
    );
    expect(engine.inventory.subscribers).toBe(count);
    expect(engine.scheduler.capacity.active).toBe(0);
    expect(store.snapshot().notices).toHaveLength(1);
    expect(store.snapshot().attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.snapshot().notices).toHaveLength(1);
    available = false;
    sequence++;
    await vi.advanceTimersByTimeAsync(100);
    expect(ids.every((id) => store.task(id).state === "MONITORING")).toBe(true);
    available = true;
    sequence++;
    await vi.advanceTimersByTimeAsync(100);
    expect(store.snapshot().notices).toHaveLength(2);
    await engine.stop(ids[0]);
    expect(engine.inventory.subscribers).toBe(count - 1);
    await Promise.all(ids.slice(1).map((id) => engine.stop(id)));
    expect(engine.inventory.size).toBe(0);
    expect(store.snapshot().logs.some((log) => log.state === "CARTING")).toBe(
      false,
    );
  },
);
it("separates variants and suppresses notices for MONITOR_ONLY and disabled preferences", async () => {
  const a = add("MONITOR_ONLY", "blue"),
    b = add("MONITOR_AND_NOTIFY", "red");
  store.settings({
    ...store.getSettings(),
    inventoryNotifications: false,
    nativeNotifications: true,
  });
  const native = vi.fn();
  engine.on("native-notification", native);
  available = true;
  engine.start(a);
  engine.start(b);
  await vi.advanceTimersByTimeAsync(250);
  expect(engine.inventory.size).toBe(2);
  expect(store.snapshot().notices).toEqual([]);
  expect(native).not.toHaveBeenCalled();
});
it("emits one opt-in native notice from the shared observation pipeline", async () => {
  store.settings({ ...store.getSettings(), nativeNotifications: true });
  const native = vi.fn();
  engine.on("native-notification", native);
  available = true;
  [add(), add()].forEach((id) => engine.start(id));
  await vi.advanceTimersByTimeAsync(300);
  expect(native).toHaveBeenCalledTimes(1);
  const payload = native.mock.calls[0][0];
  expect(payload).toMatchObject({ product: "x", variant: "blue" });
  expect(payload).not.toHaveProperty("profileId");
});
it("does not deliver expired events and safely retries shared rate limits", async () => {
  const id = add();
  expired = true;
  available = true;
  limited = 1;
  engine.start(id);
  await vi.advanceTimersByTimeAsync(199);
  expect(calls).toBe(1);
  expect(store.task(id).state).toBe("MONITORING");
  await vi.advanceTimersByTimeAsync(100);
  expect(store.snapshot().latestInventory).toEqual([]);
  expired = false;
  await vi.advanceTimersByTimeAsync(150);
  expect(store.task(id).state).toBe("STOCK_DETECTED");
  expect(store.snapshot().notices).toHaveLength(1);
});
it("does not refresh availability from stale or malformed inventory events", async () => {
  const id = add();
  engine.start(id);
  await vi.advanceTimersByTimeAsync(10);
  observation = (task) => ({
    eventId: "stale",
    streamId: "source",
    sequence: 0,
    observedAt: Date.now(),
    retailerId: "watch",
    product: productRef(task),
    availability: "in-stock",
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(store.task(id).state).toBe("MONITORING");
  expect(store.snapshot().notices).toEqual([]);
  observation = (task) => ({
    eventId: "invalid",
    streamId: "source",
    sequence: 2,
    observedAt: Date.now(),
    retailerId: "other",
    product: productRef(task),
    availability: "in-stock",
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(store.task(id).state).toBe("FAILED");
});
it("refreshes heartbeat freshness without adding duplicate history", async () => {
  const id = add();
  engine.start(id);
  await vi.advanceTimersByTimeAsync(10);
  const first = store.snapshot().latestInventory[0].observation.observedAt;
  await vi.advanceTimersByTimeAsync(300);
  expect(store.inventoryHistory().items).toHaveLength(1);
  expect(
    store.snapshot().latestInventory[0].observation.observedAt,
  ).toBeGreaterThan(first);
});
it("recovers continuous in-stock monitoring with an ended interrupted run and no checkout", async () => {
  store.settings({ ...store.getSettings(), resumeMonitoring: true });
  available = true;
  const id = add();
  engine.start(id);
  await vi.advanceTimersByTimeAsync(10);
  const old = store.task(id).runId;
  const registry = engine.registry;
  await engine.shutdown();
  engine = new Engine(store, registry, 10);
  await vi.advanceTimersByTimeAsync(10);
  expect(store.task(id).state).toBe("STOCK_DETECTED");
  expect(store.task(id).runId).not.toBe(old);
  expect(store.snapshot().runs.find((run) => run.id === old)?.recovery).toBe(
    "interrupted-monitoring",
  );
  expect(store.snapshot().attempts).toEqual([]);
});
it("rolls back inventory history, lifecycle and notices together on a database write failure", async () => {
  const id = add();
  store.begin(id);
  const original = (store as any).run.bind(store);
  const fail = vi
    .spyOn(store as any, "run")
    .mockImplementation((...args: any[]) => {
      if (String(args[0]).startsWith("INSERT INTO notices"))
        throw new Error("disk full");
      return original(...args);
    });
  expect(() =>
    store.recordInventory([id], {
      eventId: "event",
      streamId: "source",
      retailerId: "watch",
      product: { productId: "x", variantId: "blue" },
      sequence: 1,
      observedAt: Date.now(),
      availability: "in-stock",
    }),
  ).toThrow("disk full");
  fail.mockRestore();
  expect(store.task(id).state).toBe("MONITORING");
  expect(store.inventoryHistory().items).toEqual([]);
  expect(store.snapshot().notices).toEqual([]);
  expect(store.snapshot().latestInventory).toEqual([]);
});
it("validates required methods and rejects malformed capability declarations", () => {
  expect(() =>
    new AdapterRegistry().register({
      id: "bad",
      name: "bad",
      capabilities: { ...capabilities, inventory: "yes" } as any,
      rateLimit: { minIntervalMs: 0, maxConcurrentRequests: 1 },
      create: () => ({}) as any,
    }),
  ).toThrow();
  const registry = new AdapterRegistry().register({
    id: "bad",
    name: "bad",
    capabilities: { ...capabilities, cart: true },
    rateLimit: { minIntervalMs: 0, maxConcurrentRequests: 1 },
    create: () =>
      ({
        id: "bad",
        capabilities: { ...capabilities, cart: true },
        observe: async () => ({}),
        inventoryScope: () => "",
      }) as any,
  });
  expect(() => registry.create("bad")).toThrow("Invalid adapter factory");
});

it("can register a product-lookup-only adapter without inventory or checkout methods", () => {
  const caps = { ...capabilities, inventory: false, productLookup: true };
  const registry = new AdapterRegistry().register({
    id: "catalog",
    name: "Catalog",
    capabilities: caps,
    rateLimit: { minIntervalMs: 100, maxConcurrentRequests: 1 },
    create: () => ({
      id: "catalog",
      capabilities: caps,
      inventoryScope: () => "catalog",
      lookupProduct: async (id) => ({ id, title: "Product", variants: [] }),
    }),
  });
  expect(registry.create("catalog").observe).toBeUndefined();
});
