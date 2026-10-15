import { it, expect } from "vitest";
import { once } from "node:events";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendClient } from "../apps/desktop/electron/backend-client";
it("owns SQLite in a backend worker and persists IPC commands across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-worker-"));
  const workerPath = join(dir, "backend.cjs");
  await build({
    entryPoints: ["apps/desktop/electron/backend-worker.ts"],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  let backend = new BackendClient(workerPath, join(dir, "db.sqlite"));
  try {
    await backend.ready;
    await backend.command({
      type: "saveGroup",
      data: { name: "Worker group", retailer: "mock" },
    });
    expect((await backend.snapshot()).groups[0].name).toBe("Worker group");
    await backend.shutdown();
    backend = new BackendClient(workerPath, join(dir, "db.sqlite"));
    await backend.ready;
    expect((await backend.snapshot()).groups[0].name).toBe("Worker group");
  } finally {
    await backend.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("recovers a committed checkout intent after abrupt worker exit without resubmitting it", async () => {
  const { Worker } = await import("node:worker_threads");
  const dir = mkdtempSync(join(tmpdir(), "orbit-crash-"));
  const workerPath = join(dir, "crash.cjs");
  const database = join(dir, "db.sqlite");
  try {
    await build({
      stdin: {
        contents: `import {Store} from './packages/database/src/index';import {parentPort,workerData} from 'node:worker_threads';async function crash(){const store=await Store.open(workerData.path);const groupId=store.saveGroup({name:'Crash',retailer:'mock'});const id=store.saveTask({name:'Crash task',product:'x',groupId,scenario:'available',intervalMs:100,maxRetries:0});store.begin(id);const cart={id:'cart',product:{productId:'x'},quantity:1};store.prepareApproval(id,cart);store.beginCheckout(id,cart);parentPort.postMessage(id);process.exit(9);}void crash();`,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      outfile: workerPath,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const worker = new Worker(workerPath, { workerData: { path: database } });
    const exit = once(worker, "exit");
    const [id] = await once(worker, "message");
    expect((await exit)[0]).toBe(9);
    const { Store } = await import("../packages/database/src/index");
    const store = await Store.open(database);
    try {
      store.recover();
      expect(store.task(id).state).toBe("UNKNOWN_OUTCOME");
      expect(store.checkoutAttempts(id)).toHaveLength(1);
      expect(store.checkoutAttempts(id)[0].status).toBe("unknown");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects pending RPCs when its worker exits unexpectedly", async () => {
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "orbit-rpc-fail-"));
  const workerPath = join(dir, "exit.cjs");
  writeFileSync(
    workerPath,
    "const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>process.exit(7));parentPort.postMessage({type:'ready'});",
  );
  const backend = new BackendClient(workerPath, join(dir, "unused.sqlite"));
  try {
    await backend.ready;
    await expect(backend.snapshot()).rejects.toThrow("exited (7)");
  } finally {
    await backend.shutdown().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

it("recovers inventory watches and their persisted observations after worker termination", async () => {
  const { vi } = await import("vitest");
  const dir = mkdtempSync(join(tmpdir(), "orbit-watch-crash-")),
    workerPath = join(dir, "backend.cjs"),
    database = join(dir, "db.sqlite");
  await build({
    entryPoints: ["apps/desktop/electron/backend-worker.ts"],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  let backend = new BackendClient(workerPath, database);
  try {
    await backend.ready;
    let data = await backend.snapshot();
    await backend.command({
      type: "settings",
      data: { ...data.settings, resumeMonitoring: true },
    });
    data = await backend.command({
      type: "saveGroup",
      data: { name: "Watch crash", retailer: "mock" },
    });
    data = await backend.command({
      type: "saveTask",
      data: {
        name: "Continuous",
        groupId: data.groups[0].id,
        product: "sku",
        workflow: "MONITOR_ONLY",
        scenario: "available",
        intervalMs: 100,
        maxRetries: 1,
      },
    });
    const id = data.tasks[0].id;
    await backend.command({ type: "start", id });
    await vi.waitFor(
      async () =>
        expect((await backend.snapshot()).tasks[0].state).toBe(
          "STOCK_DETECTED",
        ),
      { timeout: 3000 },
    );
    const run = (await backend.snapshot()).tasks[0].runId;
    await (backend as any).worker.terminate();
    await backend.shutdown().catch(() => {});
    backend = new BackendClient(workerPath, database);
    await backend.ready;
    data = await backend.snapshot();
    expect(data.inventory.length).toBeGreaterThan(0);
    expect(data.runs.find((row) => row.id === run)?.recovery).toBe(
      "interrupted-monitoring",
    );
    expect(data.tasks[0].runId).not.toBe(run);
    expect(data.attempts).toEqual([]);
    await backend.command({ type: "stop", id });
  } finally {
    await backend.shutdown().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
