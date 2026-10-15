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
    writeFileSync(path, legacy.export());
    legacy.close();
    const before = readFileSync(path);
    const store = await Store.open(path);
    expect(store.snapshot().groups[0].name).toBe("Preserved");
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
