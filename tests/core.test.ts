import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapters } from "../packages/adapters/src/index";
import { Store } from "../packages/database/src/index";
import {
  Engine,
  validateTransition,
  transitions,
} from "../packages/core/src/index";
import { MockAdapter } from "../packages/adapters/mock/src/index";
import {
  commandSchema,
  proxySchema,
  profileSchema,
  type TaskInput,
} from "../packages/shared-types/src/index";
let dir: string, store: Store, engine: Engine, groupId: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "retail-test-"));
  store = await Store.open(join(dir, "db.sqlite"));
  engine = new Engine(store, createAdapters(), 10);
  groupId = store.saveGroup({ name: "Test group", retailer: "mock" });
  vi.useFakeTimers();
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});
const add = (scenario: TaskInput["scenario"] = "available") =>
  store.saveTask({
    name: "Test task",
    product: "SKU-42",
    groupId,
    scenario,
    intervalMs: 100,
    maxRetries: 2,
  });
const advance = (ms = 1000) => vi.advanceTimersByTimeAsync(ms);
describe("state machine", () => {
  it("accepts every explicit edge and rejects all other edges", () => {
    for (const from of Object.keys(transitions) as (keyof typeof transitions)[])
      for (const to of Object.keys(
        transitions,
      ) as (keyof typeof transitions)[]) {
        if (transitions[from].includes(to))
          expect(() => validateTransition(from, to)).not.toThrow();
        else
          expect(() => validateTransition(from, to)).toThrow(
            "Invalid transition",
          );
      }
  });
});
describe("execution", () => {
  it("monitors inventory, requires approval, and completes simulated checkout", async () => {
    const id = add();
    engine.start(id);
    await advance();
    expect(store.task(id).state).toBe("AWAITING_APPROVAL");
    expect(
      store.snapshot().logs.some((l) => l.state === "STOCK_DETECTED"),
    ).toBe(true);
    engine.approve(id);
    await advance();
    expect(store.task(id).state).toBe("COMPLETED");
    expect(store.snapshot().runs[0].endedAt).not.toBeNull();
  });
  it("cancels monitoring with AbortController", async () => {
    const id = add("out-of-stock");
    engine.start(id);
    await advance(150);
    await engine.stop(id);
    expect(store.task(id).state).toBe("CANCELLED");
    expect(engine.isBusy(id)).toBe(false);
  });
  it("cancels approval waits and clears their slot", async () => {
    const id = add();
    engine.start(id);
    await advance();
    await engine.stop(id);
    expect(store.task(id).state).toBe("CANCELLED");
  });
  it("limits operations and prevents duplicate execution while sharing subscriptions", async () => {
    store.settings({ ...store.getSettings(), concurrency: 1 });
    const a = add(),
      b = add();
    engine.start(a);
    engine.start(a);
    engine.start(b);
    expect(store.snapshot().runs).toHaveLength(2);
    expect(engine.inventory.subscribers).toBe(2);
    await advance();
    expect(store.task(a).state).toBe("AWAITING_APPROVAL");
    expect(store.task(b).state).toBe("AWAITING_APPROVAL");
    expect(engine.diagnostics().peakOperations).toBe(1);
  });
  it("cancels a task waiting for execution capacity", async () => {
    store.settings({ ...store.getSettings(), concurrency: 1 });
    const a = add(),
      b = add();
    engine.start(a);
    engine.start(b);
    await advance(501);
    expect(engine.snapshot().queued).toContain(b);
    await engine.stop(b);
    expect(store.task(b).state).toBe("CANCELLED");
    expect(store.approval(b)).toBeUndefined();
    expect(engine.snapshot().queued).not.toContain(b);
  });
  it("bounds exponential retries on timeouts", async () => {
    const id = add("timeout");
    engine.start(id);
    await advance();
    expect(store.task(id).state).toBe("FAILED");
    const logs = store
      .snapshot()
      .logs.filter((l) => l.message.includes("; retry"))
      .reverse();
    expect(logs.map((l) => l.message)).toEqual([
      "Simulated network timeout; retry 1/2 in 10ms",
      "Simulated network timeout; retry 2/2 in 20ms",
    ]);
  });
  it("recovers from deterministic rate limiting", async () => {
    const id = add("rate-limit");
    engine.start(id);
    await advance();
    expect(store.task(id).state).toBe("AWAITING_APPROVAL");
  });
  it("fails simulated checkout without retrying", async () => {
    const id = add("checkout-failure");
    engine.start(id);
    await advance();
    engine.approve(id);
    await advance();
    expect(store.task(id).state).toBe("FAILED");
    expect(
      store.snapshot().logs.filter((l) => l.message.includes("declined")),
    ).toHaveLength(1);
  });
  it("restarts with a new execution id", async () => {
    const id = add();
    engine.start(id);
    await advance();
    const first = store.task(id).runId;
    await engine.command({ type: "restart", id });
    await advance();
    expect(store.task(id).runId).not.toBe(first);
    expect(store.snapshot().runs).toHaveLength(2);
  });
});
describe("persistence and service", () => {
  it("creates, edits, duplicates and deletes task configurations", async () => {
    const id = add();
    await engine.command({
      type: "saveTask",
      data: { ...config(id), name: "Edited" },
    });
    expect(store.task(id).name).toBe("Edited");
    await engine.command({ type: "duplicateTask", id });
    expect(store.snapshot().tasks).toHaveLength(2);
    expect(store.snapshot().tasks[1].name).toBe("Edited copy");
    await engine.command({ type: "deleteTask", id });
    expect(store.snapshot().tasks).toHaveLength(1);
  });
  it("blocks mutation of active tasks", async () => {
    const id = add();
    engine.start(id);
    await expect(
      engine.command({ type: "saveTask", data: config(id) }),
    ).rejects.toThrow("Stop");
    await expect(
      engine.command({ type: "deleteGroup", id: groupId }),
    ).rejects.toThrow("Stop");
  });
  it("persists groups, profiles, proxies, settings, task history and logs across restart", async () => {
    store.saveProfile({
      name: "Alex",
      group: "Home",
      email: "alex@example.com",
      phone: "",
      address: "1 Example St",
      city: "Toronto",
      postalCode: "M1A1A1",
      country: "CA",
      paymentToken: "mock_test",
    });
    store.saveProxy({
      name: "Local",
      group: "Test",
      host: "127.0.0.1",
      protocol: "socks5",
      port: 1080,
    });
    store.settings({ ...store.snapshot().settings, concurrency: 2 });
    const id = add();
    engine.start(id);
    await advance();
    await engine.shutdown();
    store.close();
    store = await Store.open(join(dir, "db.sqlite"));
    engine = new Engine(store, createAdapters());
    const snapshot = engine.snapshot();
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.proxies).toHaveLength(1);
    expect(snapshot.settings.concurrency).toBe(2);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.logs.length).toBeGreaterThan(0);
  });
  it("recovers interrupted active runs without automatically resuming", async () => {
    const id = add();
    const runId = store.begin(id);
    store.close();
    store = await Store.open(join(dir, "db.sqlite"));
    engine = new Engine(store, createAdapters());
    expect(store.task(id).state).toBe("CANCELLED");
    expect(store.snapshot().runs.find((r) => r.id === runId)?.outcome).toBe(
      "CANCELLED",
    );
    expect(engine.isBusy(id)).toBe(false);
    expect(store.snapshot().logs[0].message).toContain("recovered");
  });
  it("cascades group deletion to tasks and histories", async () => {
    const id = add();
    engine.start(id);
    await engine.stop(id);
    store.delete("groups", groupId);
    expect(store.snapshot().tasks).toEqual([]);
    expect(store.snapshot().runs).toEqual([]);
    expect(store.snapshot().logs).toEqual([]);
  });
  it("validates IPC payloads, foreign keys, proxy syntax and placeholder tokens", () => {
    expect(() => commandSchema.parse({ type: "start", id: "bad" })).toThrow();
    expect(() =>
      commandSchema.parse({ type: "settings", data: { concurrency: 999 } }),
    ).toThrow();
    expect(() =>
      proxySchema.parse({
        name: "x",
        group: "g",
        protocol: "http",
        host: "http://user:pass@host",
        port: 80,
      }),
    ).toThrow();
    expect(() =>
      profileSchema.parse({ paymentToken: "4111111111111111" }),
    ).toThrow();
    expect(() =>
      store.saveTask({
        ...config(add()),
        groupId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toThrow("Group not found");
  });
});
function config(id: string) {
  const { state, runId, updatedAt, ...input } = store.task(id);
  return input;
}
it("mock inventory stays out of stock or becomes available deterministically", async () => {
  const id = add();
  const adapter = new MockAdapter();
  const signal = new AbortController().signal;
  const checks: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const check = adapter.inventory(store.task(id), signal);
    await advance(100);
    checks.push(await check);
  }
  expect(checks).toEqual([false, false, true]);
});
it("rejects malformed proxy IPs and accepts supported host syntax", () => {
  const input = { name: "test", group: "local", protocol: "http", port: 8080 };
  for (const host of [
    "999.1.1.1",
    "bad..example.com",
    "-host",
    "[:::]",
    "host/path",
    "user:pass@host",
  ])
    expect(proxySchema.safeParse({ ...input, host }).success).toBe(false);
  for (const host of ["localhost", "127.0.0.1", "proxy.example.com", "[::1]"])
    expect(proxySchema.safeParse({ ...input, host }).success).toBe(true);
});
it("cancels during a retry backoff without waiting for its timer", async () => {
  engine = new Engine(store, createAdapters(), 5000);
  const id = add("timeout");
  engine.start(id);
  await advance(150);
  expect(
    store.snapshot().logs.some((log) => log.message.includes("5000ms")),
  ).toBe(true);
  await engine.stop(id);
  expect(store.task(id).state).toBe("CANCELLED");
  await engine.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});
it("increasing concurrency immediately launches waiting operations", async () => {
  store.settings({ ...store.getSettings(), concurrency: 1 });
  const a = add(),
    b = add();
  engine.start(a);
  engine.start(b);
  await advance(501);
  expect(engine.snapshot().queued).toContain(b);
  await engine.command({
    type: "settings",
    data: { ...store.getSettings(), concurrency: 2 },
  });
  await advance(1);
  expect(engine.snapshot().queued).toEqual([]);
  expect(engine.diagnostics().peakOperations).toBe(2);
});
