import { it, expect, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Store } from "../packages/database/src/index";
import { Engine } from "../packages/core/src/index";
import { createAdapters } from "../packages/adapters/src/index";
it("durably recovers delayed orders, source identity, carts and idempotency after SIGKILL and reconciles without resubmission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-simulator-crash-"));
  const runner = join(dir, "server.cjs"),
    database = join(dir, "simulator.sqlite");
  let child: ChildProcess | undefined;
  let engine: Engine | undefined;
  let store: Store | undefined;
  await build({
    stdin: {
      contents: `import {startSimulator} from './packages/simulator/src/index';startSimulator(Number(process.argv[3]),{databasePath:process.argv[2]}).then(server=>process.send({url:server.url,token:server.token}));`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile: runner,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const launch = async (port = 0) => {
    child = fork(runner, [database, String(port)], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const running = child;
    return new Promise<{ url: string; token: string }>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        running.off("message", message);
        running.off("exit", exit);
        running.off("error", exit);
      };
      const message = (value: unknown) => {
        cleanup();
        resolve(value as { url: string; token: string });
      };
      const exit = () => {
        cleanup();
        reject(new Error("Simulator test process failed to start"));
      };
      const timer = setTimeout(exit, 5000);
      running.once("message", message);
      running.once("exit", exit);
      running.once("error", exit);
    });
  };
  const kill = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      child = undefined;
      return;
    }
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    child = undefined;
  };
  try {
    let server = await launch();
    store = await Store.open(":memory:");
    engine = new Engine(store, createAdapters(server.url), 10);
    const groupId = store.saveGroup({
      name: "Durable simulator",
      retailer: "simulator",
    });
    const id = store.saveTask({
      name: "Pending order",
      groupId,
      product: "SKU-42",
      variantId: "blue",
      scenario: "available",
      intervalMs: 100,
      maxRetries: 1,
    });
    await fetch(server.url + "/control/config", {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dropCheckoutResponse: true,
        completionDelayMs: 1000,
      }),
    });
    engine.start(id);
    await vi.waitFor(() =>
      expect(store!.task(id).state).toBe("AWAITING_APPROVAL"),
    );
    engine.approve(id);
    await vi.waitFor(() =>
      expect(store!.task(id).state).toBe("UNKNOWN_OUTCOME"),
    );
    const attempt = store.attempt(store.task(id).runId!)!;
    await engine.reconcile(id);
    expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
    const port = Number(new URL(server.url).port);
    await kill();
    server = await launch(port);
    await vi.waitFor(
      async () => {
        await engine!.reconcile(id);
        expect(store!.task(id).state).toBe("COMPLETED");
      },
      { timeout: 4000, interval: 100 },
    );
    const result = store.attempt(attempt.id)?.lastStatus;
    expect(result).toMatchObject({
      status: "completed",
      sourceId: attempt.sourceId,
    });
    let metrics = await fetch(server.url + "/control/metrics", {
      headers: { authorization: `Bearer ${server.token}` },
    }).then((response) => response.json());
    expect(metrics).toMatchObject({ checkoutRequests: 0, ordersCreated: 1 });
    const repeated = await fetch(server.url + "/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cartId: attempt.cart.id,
        idempotencyKey: attempt.id,
      }),
    }).then((response) => response.json());
    expect(repeated.orderId).toBe((result as any).orderId);
    const absent = await fetch(
      server.url + "/orders/status?idempotencyKey=never-submitted",
    ).then((response) => response.json());
    expect(absent).toMatchObject({
      status: "unresolved",
      authoritative: false,
    });
    metrics = await fetch(server.url + "/control/metrics", {
      headers: { authorization: `Bearer ${server.token}` },
    }).then((response) => response.json());
    expect(metrics.ordersCreated).toBe(1);
  } finally {
    await engine?.shutdown();
    store?.close();
    await kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("preserves inventory values across restarts but gives observations a new stream independent of durable order identity", async () => {
  const { startSimulator } = await import("../packages/simulator/src/index");
  const dir = mkdtempSync(join(tmpdir(), "orbit-simulator-inventory-"));
  let server = await startSimulator(0, {
    databasePath: join(dir, "state.sqlite"),
  });
  try {
    const first = await fetch(server.url + "/inventory?productId=SKU-42").then(
      (response) => response.json(),
    );
    await fetch(server.url + "/control/inventory", {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ productId: "SKU-42", available: true }),
    });
    await server.close();
    server = await startSimulator(0, {
      databasePath: join(dir, "state.sqlite"),
    });
    const next = await fetch(server.url + "/inventory?productId=SKU-42").then(
      (response) => response.json(),
    );
    expect(next.availability).toBe("in-stock");
    expect(next.sequence).toBe(2);
    expect(next.streamId).not.toBe(first.streamId);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects a future simulator schema without creating or replacing tables", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { SimulatorStorage } =
    await import("../packages/simulator/src/storage");
  const dir = mkdtempSync(join(tmpdir(), "orbit-simulator-future-")),
    path = join(dir, "state.sqlite");
  try {
    let db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE simulator_schema(version INTEGER PRIMARY KEY);INSERT INTO simulator_schema VALUES(2);CREATE TABLE future_data(value TEXT);INSERT INTO future_data VALUES('preserved')",
    );
    db.close();
    expect(() => new SimulatorStorage(path)).toThrow("Unsupported");
    db = new DatabaseSync(path);
    expect(db.prepare("SELECT value FROM future_data").get()?.value).toBe(
      "preserved",
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='orders'").get(),
    ).toBeUndefined();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses to initialize simulator tables inside the desktop database", async () => {
  const { SimulatorStorage } =
    await import("../packages/simulator/src/storage");
  const dir = mkdtempSync(join(tmpdir(), "orbit-simulator-foreign-")),
    path = join(dir, "retail.sqlite");
  try {
    let desktop = await Store.open(path);
    desktop.saveGroup({ name: "Do not alter", retailer: "mock" });
    desktop.close();
    expect(() => new SimulatorStorage(path)).toThrow(
      "not an Orbit simulator database",
    );
    desktop = await Store.open(path);
    expect(desktop.snapshot().groups[0].name).toBe("Do not alter");
    desktop.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
