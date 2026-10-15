import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { Store } from "../packages/database/src/index";
import { Engine } from "../packages/core/src/index";
import { createAdapters } from "../packages/adapters/src/index";
import { startSimulator } from "../packages/simulator/src/index";
import { AdapterRegistry } from "../packages/retailer-sdk/src/index";
let store: Store,
  engine: Engine,
  simulator: Awaited<ReturnType<typeof startSimulator>>,
  id: string;
async function control(data: Record<string, unknown>) {
  const response = await fetch(simulator.url + "/control/config", {
    method: "POST",
    headers: {
      authorization: `Bearer ${simulator.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(data),
  });
  expect(response.ok).toBe(true);
}
async function until(state: string) {
  await vi.waitFor(() => expect(store.task(id).state).toBe(state), {
    timeout: 4000,
    interval: 10,
  });
}
async function submit(data: Record<string, unknown> = {}) {
  await control({ dropCheckoutResponse: true, ...data });
  engine.start(id);
  await until("AWAITING_APPROVAL");
  engine.approve(id);
  await until("UNKNOWN_OUTCOME");
  await vi.waitFor(() => expect(engine.isBusy(id)).toBe(false));
}
beforeEach(async () => {
  simulator = await startSimulator();
  store = await Store.open(":memory:");
  engine = new Engine(store, createAdapters(simulator.url), 10);
  const groupId = store.saveGroup({ name: "HTTP", retailer: "simulator" });
  id = store.saveTask({
    name: "Uncertain order",
    groupId,
    product: "SKU-42",
    variantId: "blue",
    scenario: "available",
    intervalMs: 100,
    maxRetries: 1,
  });
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  await simulator.close();
});
it("reconciles a lost success once without ever resubmitting checkout", async () => {
  await submit();
  const key = store.task(id).runId!;
  expect(simulator.metrics.ordersCreated).toBe(1);
  const first = engine.reconcile(id),
    second = engine.reconcile(id);
  expect(second).toBe(first);
  await Promise.all([first, second]);
  expect(store.task(id).state).toBe("COMPLETED");
  expect(store.attempt(key)?.lastStatus).toMatchObject({
    status: "completed",
    authoritative: true,
    idempotencyKey: key,
  });
  expect(store.snapshot().reconciliations).toHaveLength(1);
  await engine.reconcile(id);
  expect(simulator.metrics.checkoutRequests).toBe(1);
  expect(simulator.metrics.statusRequests).toBe(1);
  expect(simulator.metrics.ordersCreated).toBe(1);
});
it("only resolves failure with an authoritative recorded decline", async () => {
  await submit({ checkoutFailure: true });
  await engine.reconcile(id);
  expect(store.task(id).state).toBe("FAILED");
  expect(store.snapshot().reconciliations[0].status).toBe("failed");
  expect(simulator.metrics.ordersCreated).toBe(0);
  expect(simulator.metrics.checkoutRequests).toBe(1);
});
it("keeps pending orders blocked until delayed completion is confirmed", async () => {
  await submit({ completionDelayMs: 500 });
  await engine.reconcile(id);
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(store.snapshot().reconciliations[0].status).toBe("pending");
  await new Promise((resolve) => setTimeout(resolve, 520));
  await engine.reconcile(id);
  expect(store.task(id).state).toBe("COMPLETED");
  expect(simulator.metrics.ordersCreated).toBe(1);
  expect(simulator.metrics.checkoutRequests).toBe(1);
});
it.each([{ invalidStatus: true }, { statusAgeMs: 60000 }])(
  "rejects invalid/stale evidence %j and retains a retryable unknown outcome",
  async (controls) => {
    await submit();
    await control(controls);
    await engine.reconcile(id);
    expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
    expect(store.snapshot().reconciliations[0].status).toBe("error");
    await control({ invalidStatus: false, statusAgeMs: 0 });
    await engine.reconcile(id);
    expect(store.task(id).state).toBe("COMPLETED");
    expect(simulator.metrics.checkoutRequests).toBe(1);
  },
);
it("reconciles after application restart with the same source and durable intent", async () => {
  await submit();
  const key = store.task(id).runId;
  await engine.shutdown();
  engine = new Engine(store, createAdapters(simulator.url), 10);
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  await engine.reconcile(id);
  expect(store.task(id).state).toBe("COMPLETED");
  expect(store.task(id).runId).toBe(key);
  expect(simulator.metrics.checkoutRequests).toBe(1);
});
it("simulator restart returns inconclusive absence instead of manufacturing failure or a new order", async () => {
  await submit();
  const key = store.task(id).runId!;
  await engine.shutdown();
  const port = Number(new URL(simulator.url).port);
  await simulator.close();
  simulator = await startSimulator(port);
  engine = new Engine(store, createAdapters(simulator.url), 10);
  await engine.reconcile(id);
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(store.snapshot().reconciliations[0].message).toContain("Source");
  expect(simulator.metrics.ordersCreated).toBe(0);
  expect(simulator.metrics.checkoutRequests).toBe(0);
  const status = await fetch(
    simulator.url + "/orders/status?idempotencyKey=" + key,
  ).then((res) => res.json());
  expect(status).toMatchObject({ status: "unresolved", authoritative: false });
  expect(simulator.metrics.ordersCreated).toBe(0);
});
it("records a missing retailer adapter without losing the original intent", async () => {
  await submit();
  await engine.shutdown();
  engine = new Engine(store, new AdapterRegistry(), 10);
  await engine.reconcile(id);
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(store.snapshot().reconciliations[0].message).toContain(
    "not registered",
  );
  expect(store.snapshot().attempts).toHaveLength(1);
});
it("cancels an active status lookup and shuts down without changing the unknown outcome", async () => {
  await submit();
  await control({ latencyMs: 1000 });
  const lookup = engine.reconcile(id);
  await vi.waitFor(() => expect(engine.scheduler.capacity.active).toBe(1));
  await engine.shutdown();
  await lookup;
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(store.snapshot().reconciliations[0].message).toContain("cancelled");
  expect(engine.scheduler.capacity.active).toBe(0);
  expect(simulator.metrics.checkoutRequests).toBe(1);
});
it("rolls back result evidence, history, run and task together when a database write fails", async () => {
  await submit();
  const lookup = store.beginReconciliation(id),
    attempt = store.attempt(store.task(id).runId!)!;
  const result = {
    status: "completed",
    authoritative: true,
    idempotencyKey: attempt.id,
    sourceId: attempt.sourceId,
    sequence: 1,
    checkedAt: Date.now(),
    orderId: "verified",
  };
  const original = (store as any).run.bind(store);
  const fail = vi
    .spyOn(store as any, "run")
    .mockImplementation((...args: any[]) => {
      if (String(args[0]).startsWith("INSERT INTO logs"))
        throw new Error("disk full");
      return original(...args);
    });
  expect(() => store.finishReconciliation(lookup.id, result)).toThrow(
    "disk full",
  );
  fail.mockRestore();
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(store.attempt(attempt.id)?.lastStatus).toBeUndefined();
  expect(store.snapshot().reconciliations[0].status).toBe("started");
  store.finishReconciliation(lookup.id, result);
  expect(store.task(id).state).toBe("COMPLETED");
});
it("recovers an interrupted lookup and rejects mismatched, regressive and conflicting evidence", async () => {
  await submit();
  const attempt = store.attempt(store.task(id).runId!)!;
  store.beginReconciliation(id);
  await engine.shutdown();
  engine = new Engine(store, createAdapters(simulator.url), 10);
  expect(store.snapshot().reconciliations[0].status).toBe("interrupted");
  const base = {
    idempotencyKey: attempt.id,
    sourceId: attempt.sourceId,
    sequence: 2,
    checkedAt: Date.now(),
    status: "pending",
    authoritative: false,
  };
  let row = store.beginReconciliation(id);
  store.finishReconciliation(row.id, base);
  for (const change of [
    { idempotencyKey: "wrong" },
    { sourceId: "wrong" },
    { sequence: 1 },
    {
      sequence: 2,
      status: "completed",
      authoritative: true,
      orderId: "contradictory",
    },
  ]) {
    row = store.beginReconciliation(id);
    store.finishReconciliation(row.id, {
      ...base,
      ...change,
      checkedAt: Date.now(),
    });
    expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
    expect(store.snapshot().reconciliations[0].status).toBe("error");
  }
  expect(store.attempt(attempt.id)?.lastStatus?.status).toBe("pending");
});

it("cancels reconciliation queued for execution capacity without issuing a lookup", async () => {
  await submit();
  store.settings({ ...store.getSettings(), concurrency: 1 });
  let release!: () => void;
  const occupied = engine.scheduler.execute(
    "simulator",
    "occupied",
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await vi.waitFor(() => expect(engine.scheduler.capacity.active).toBe(1));
  const pending = engine.reconcile(id);
  await vi.waitFor(() => expect(engine.scheduler.queued).toContain(id));
  await engine.stop(id);
  await pending;
  release();
  await occupied;
  expect(simulator.metrics.statusRequests).toBe(0);
  expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
  expect(store.snapshot().reconciliations[0].status).toBe("error");
});
