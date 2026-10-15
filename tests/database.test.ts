import { it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import initSqlJs from "sql.js";
import { Store } from "../packages/database/src/index";
import { migrations } from "../packages/database/src/migrations";

it("opens an actual SQL.js v1 file without converting or losing user data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-v1-"));
  const path = join(dir, "retail.sqlite");
  try {
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.run(
      "CREATE TABLE migrations(version INTEGER PRIMARY KEY);INSERT INTO migrations VALUES(1);",
    );
    legacy.run(migrations[0].sql);
    legacy.run("INSERT INTO groups VALUES(?,?)", [
      "legacy",
      JSON.stringify({ id: "legacy", name: "Preserved", retailer: "mock" }),
    ]);
    const task = {
      id: "task",
      groupId: "legacy",
      name: "Legacy task",
      product: "SKU-42",
      profileId: "profile",
      proxyId: "proxy",
      scenario: "available",
      intervalMs: 1000,
      maxRetries: 3,
      state: "COMPLETED",
      runId: "run",
      updatedAt: "2026-10-14T00:00:00.000Z",
    };
    const profile = {
      id: "profile",
      name: "Legacy profile",
      group: "Home",
      email: "alex@example.com",
      phone: "",
      address: "1 Example St",
      city: "Toronto",
      postalCode: "M1A1A1",
      country: "CA",
      paymentToken: "mock_legacy",
    };
    const proxy = {
      id: "proxy",
      name: "Legacy proxy",
      group: "Home",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 1080,
    };
    const settings = {
      concurrency: 2,
      notifications: true,
      logLevel: "debug",
      launchView: "Tasks",
    };
    legacy.run("INSERT INTO profiles VALUES(?,?)", [
      "profile",
      JSON.stringify(profile),
    ]);
    legacy.run("INSERT INTO proxies VALUES(?,?)", [
      "proxy",
      JSON.stringify(proxy),
    ]);
    legacy.run("INSERT INTO tasks VALUES(?,?,?)", [
      "task",
      "legacy",
      JSON.stringify(task),
    ]);
    legacy.run("INSERT INTO runs VALUES(?,?,?)", [
      "run",
      "task",
      JSON.stringify({
        id: "run",
        taskId: "task",
        startedAt: task.updatedAt,
        endedAt: task.updatedAt,
        outcome: "COMPLETED",
      }),
    ]);
    legacy.run("INSERT INTO logs VALUES(?,?,?,?)", [
      "log",
      "task",
      task.updatedAt,
      JSON.stringify({
        id: "log",
        taskId: "task",
        runId: "run",
        at: task.updatedAt,
        state: "COMPLETED",
        level: "info",
        message: "Legacy event",
      }),
    ]);
    legacy.run("INSERT INTO settings VALUES(?,?)", [
      "app",
      JSON.stringify(settings),
    ]);
    writeFileSync(path, legacy.export());
    legacy.close();
    const before = readFileSync(path);
    const store = await Store.open(path);
    const migrated = store.snapshot();
    expect(migrated.groups[0].name).toBe("Preserved");
    expect(migrated.tasks[0]).toEqual({
      ...task,
      variantId: null,
      workflow: "MONITOR_AND_CHECKOUT",
    });
    expect(migrated.profiles).toEqual([profile]);
    expect(migrated.proxies).toEqual([proxy]);
    expect(migrated.settings).toEqual({
      ...settings,
      resumeMonitoring: false,
      inventoryNotifications: true,
      nativeNotifications: false,
    });
    expect(migrated.logs[0].message).toBe("Legacy event");
    expect(migrated.runs[0].outcome).toBe("COMPLETED");
    const backup = new DatabaseSync(path + ".v1.bak", { readOnly: true });
    expect(
      backup.prepare("SELECT MAX(version) AS version FROM migrations").get()
        ?.version,
    ).toBe(1);
    backup.close();
    expect(store.diagnostics()).toEqual({ journalMode: "wal", foreignKeys: 1 });
    expect(
      readFileSync(path + ".v1.bak")
        .subarray(0, 16)
        .toString(),
    ).toBe("SQLite format 3\0");
    expect(existsSync(path + ".tmp")).toBe(false);
    store.saveGroup({ name: "New", retailer: "mock" });
    store.close();
    const reopened = await Store.open(path);
    expect(reopened.snapshot().groups).toHaveLength(2);
    reopened.close();
    expect(before.subarray(0, 16).toString()).toBe("SQLite format 3\0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("rolls back the entire lifecycle write when a log write fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-write-"));
  const path = join(dir, "db.sqlite");
  let store = await Store.open(path);
  try {
    const groupId = store.saveGroup({ name: "Test", retailer: "mock" });
    const id = store.saveTask({
      name: "Task",
      product: "x",
      groupId,
      scenario: "available",
      intervalMs: 100,
      maxRetries: 0,
    });
    store.begin(id);
    store.close();
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TRIGGER fail_log BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT,'injected write failure'); END;",
    );
    db.close();
    store = await Store.open(path);
    expect(() => store.transition(id, "FAILED", "must roll back")).toThrow(
      "injected write failure",
    );
    expect(store.task(id).state).toBe("MONITORING");
    expect(store.snapshot().runs[0].endedAt).toBeNull();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("enforces one store owner and reports read-only write failures without changing data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-readonly-"));
  const path = join(dir, "db.sqlite");
  const store = await Store.open(path);
  try {
    store.saveGroup({ name: "Preserved", retailer: "mock" });
    await expect(Store.open(path)).rejects.toThrow("owner");
    store.close();
    const reader = await Store.open(path, { readOnly: true });
    try {
      expect(() =>
        reader.saveGroup({ name: "Rejected", retailer: "mock" }),
      ).toThrow();
      expect(reader.snapshot().groups).toHaveLength(1);
    } finally {
      reader.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects a future schema and rolls back a failed migration without dropping legacy data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-migration-fail-"));
  const path = join(dir, "db.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE migrations(version INTEGER PRIMARY KEY);INSERT INTO migrations VALUES(1);",
    );
    db.exec(migrations[0].sql);
    db.exec(
      'INSERT INTO groups VALUES(\'legacy\',\'{"id":"legacy","name":"Preserved","retailer":"mock"}\');CREATE TABLE checkout_attempts(existing TEXT);',
    );
    db.close();
    await expect(Store.open(path)).rejects.toThrow("already exists");
    const check = new DatabaseSync(path);
    expect(
      check.prepare("SELECT MAX(version) AS version FROM migrations").get()
        ?.version,
    ).toBe(1);
    expect(
      check
        .prepare("SELECT name FROM sqlite_master WHERE name='approvals'")
        .get(),
    ).toBeUndefined();
    expect(
      JSON.parse(String(check.prepare("SELECT data FROM groups").get()?.data))
        .name,
    ).toBe("Preserved");
    check.exec("UPDATE migrations SET version=99");
    check.close();
    await expect(Store.open(path)).rejects.toThrow("newer application");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("backs up schema v2 and preserves approval, attempt, revision and legacy task records when adding v3 tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-v2-"));
  const path = join(dir, "db.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE migrations(version INTEGER PRIMARY KEY)",
    );
    for (const migration of migrations.slice(0, 2)) {
      old.exec(migration.sql);
      old.prepare("INSERT INTO migrations VALUES(?)").run(migration.version);
    }
    const group = { id: "group", name: "Preserved", retailer: "simulator" },
      task = {
        id: "task",
        groupId: "group",
        name: "Old",
        product: "SKU-42",
        scenario: "available",
        intervalMs: 100,
        maxRetries: 2,
        profileId: null,
        proxyId: null,
        variantId: "blue",
        state: "UNKNOWN_OUTCOME",
        runId: "run",
        updatedAt: new Date().toISOString(),
      };
    const cart = {
      id: "cart",
      product: { productId: "SKU-42", variantId: "blue" },
      quantity: 1,
    };
    const attempt = {
      id: "run",
      taskId: "task",
      cart,
      status: "unknown",
      submittedAt: new Date().toISOString(),
    };
    old
      .prepare("INSERT INTO groups VALUES(?,?)")
      .run(group.id, JSON.stringify(group));
    old
      .prepare("INSERT INTO tasks VALUES(?,?,?)")
      .run(task.id, task.groupId, JSON.stringify(task));
    old.prepare("INSERT INTO runs VALUES(?,?,?)").run(
      "run",
      "task",
      JSON.stringify({
        id: "run",
        taskId: "task",
        outcome: "UNKNOWN_OUTCOME",
        startedAt: new Date().toISOString(),
        endedAt: null,
      }),
    );
    old
      .prepare("INSERT INTO checkout_attempts VALUES(?,?,?)")
      .run("run", "task", JSON.stringify(attempt));
    old.prepare("UPDATE metadata SET value=91 WHERE key='revision'").run();
    old.close();
    let store = await Store.open(path);
    expect(store.task("task").workflow).toBe("MONITOR_AND_CHECKOUT");
    expect(store.attempt("run")).toEqual(attempt);
    expect(store.snapshot().revision).toBe(91);
    expect(store.snapshot().inventory).toEqual([]);
    expect(store.snapshot().reconciliations).toEqual([]);
    store.recover();
    expect(store.task("task").state).toBe("UNKNOWN_OUTCOME");
    store.saveRetailerConfig("shopify", {
      mode: "fixture",
      endpoint: "http://127.0.0.1:4319",
    });
    store.close();
    const backup = new DatabaseSync(path + ".v2.bak", { readOnly: true });
    expect(
      backup.prepare("SELECT MAX(version) AS version FROM migrations").get()
        ?.version,
    ).toBe(2);
    expect(
      backup.prepare("SELECT data FROM checkout_attempts").get()?.data,
    ).toBe(JSON.stringify(attempt));
    backup.close();
    store = await Store.open(path);
    expect(store.retailerConfig("shopify").mode).toBe("fixture");
    expect(store.attempt("run")).toEqual(attempt);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("migrates schema v3 with observation data in place and backfills monitoring health", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-v3-")),
    path = join(dir, "db.sqlite");
  try {
    let store = await Store.open(path);
    const groupId = store.saveGroup({ name: "Preserved v3", retailer: "mock" });
    const id = store.saveTask({
      name: "Preserved",
      groupId,
      product: "x",
      workflow: "MONITOR_ONLY",
      scenario: "available",
      intervalMs: 100,
      maxRetries: 1,
    });
    store.begin(id);
    store.recordInventory([id], {
      eventId: "one",
      streamId: "source",
      retailerId: "mock",
      product: { productId: "x" },
      sequence: 1,
      observedAt: Date.now(),
      availability: "out-of-stock",
    });
    const event = store.inventoryHistory().items[0];
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "DROP TABLE monitoring_health; DELETE FROM migrations WHERE version=4",
    );
    legacy.close();
    store = await Store.open(path);
    expect(store.inventoryHistory().items[0]).toEqual(event);
    expect(store.task(id).workflow).toBe("MONITOR_ONLY");
    expect(store.snapshot().monitoringHealth[0].lastSuccess).toBe(
      event.receivedAt,
    );
    expect(existsSync(path + ".v3.bak")).toBe(true);
    expect(store.snapshot().inventory).toEqual([]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
