import { it, expect } from "vitest";
import { Store } from "../packages/database/src/index";
it("paginates per-task change history without copying it into snapshots or duplicating pages after new writes", async () => {
  const store = await Store.open(":memory:");
  try {
    const groupId = store.saveGroup({ name: "History", retailer: "mock" });
    const ids = [0, 1].map((i) =>
      store.saveTask({
        name: `Watch ${i}`,
        groupId,
        product: "x",
        workflow: "MONITOR_ONLY",
        scenario: "available",
        intervalMs: 100,
        maxRetries: 1,
      }),
    );
    ids.forEach((id) => store.begin(id));
    const event = (sequence: number) => ({
      eventId: String(sequence),
      streamId: "source",
      retailerId: "mock",
      product: { productId: "x" },
      sequence,
      observedAt: Date.now(),
      availability:
        sequence % 2 ? ("in-stock" as const) : ("out-of-stock" as const),
    });
    for (let sequence = 1; sequence <= 9; sequence++)
      store.recordInventory(ids, event(sequence));
    const first = store.inventoryHistory({ taskId: ids[0], limit: 3 });
    expect(first.items).toHaveLength(3);
    store.recordInventory(ids, event(10));
    const second = store.inventoryHistory({
      taskId: ids[0],
      limit: 3,
      cursor: first.nextCursor!,
    });
    const third = store.inventoryHistory({
      taskId: ids[0],
      limit: 3,
      cursor: second.nextCursor!,
    });
    expect(third.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.items, ...second.items, ...third.items].map((row) => row.id),
      ).size,
    ).toBe(9);
    expect(store.snapshot().inventory).toEqual([]);
    expect(store.snapshot().monitoringHealth[0].lastSuccess).toBeDefined();
    expect(() => store.inventoryHistory({ limit: 101 })).toThrow();
    expect(() => store.inventoryHistory({ cursor: -1 })).toThrow();
  } finally {
    store.close();
  }
});
it("keeps last errors and last successful observations independent and excludes unchanged reads from change history", async () => {
  const store = await Store.open(":memory:");
  try {
    const groupId = store.saveGroup({ name: "Health", retailer: "mock" });
    const id = store.saveTask({
      name: "Watch",
      groupId,
      product: "x",
      workflow: "MONITOR_ONLY",
      scenario: "available",
      intervalMs: 100,
      maxRetries: 1,
    });
    store.begin(id);
    store.monitoringError([id], "AUTH", "Inventory auth error");
    for (let sequence = 1; sequence <= 3; sequence++)
      store.recordInventory([id], {
        eventId: String(sequence),
        streamId: "source",
        retailerId: "mock",
        product: { productId: "x" },
        sequence,
        observedAt: Date.now(),
        availability: "in-stock",
      });
    expect(store.inventoryHistory().items).toHaveLength(1);
    expect(store.snapshot().monitoringHealth[0]).toMatchObject({
      lastSuccess: expect.any(String),
      lastError: { code: "AUTH" },
    });
  } finally {
    store.close();
  }
});
