import { migrations } from "./migrations";
import initSqlJs, {
  type Database as SQLDatabase,
  type SqlJsStatic,
} from "sql.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  groupSchema,
  taskSchema,
  profileSchema,
  proxySchema,
  settingsSchema,
  type Snapshot,
  type Task,
  type TaskState,
  type Log,
  type Run,
} from "../../shared-types/src/index";
const defaults = {
  concurrency: 3,
  notifications: false,
  logLevel: "info" as const,
  launchView: "Dashboard" as const,
};
// SQL.js is SQLite compiled to WASM: no Electron/native ABI coupling.
export class Store {
  private db: SQLDatabase;
  private transactionDepth = 0;
  static async open(path: string, wasmPath?: string) {
    const SQL = await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : {});
    return new Store(SQL, path);
  }
  private constructor(
    SQL: SqlJsStatic,
    private path: string,
  ) {
    this.db = existsSync(path)
      ? new SQL.Database(readFileSync(path))
      : new SQL.Database();
    this.db.run("PRAGMA foreign_keys=ON");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY)",
    );
    const applied = this.db.exec("SELECT version FROM migrations");
    const versions = applied.length
      ? applied[0].values.map((row) => Number(row[0]))
      : [];
    if (versions.some((version) => version > migrations.at(-1)!.version))
      throw new Error("Database was created by a newer application version");
    for (const migration of migrations)
      if (!versions.includes(migration.version)) {
        this.db.run("BEGIN IMMEDIATE");
        try {
          this.db.run(migration.sql);
          this.db.run("INSERT INTO migrations VALUES(?)", [migration.version]);
          this.db.run("COMMIT");
        } catch (error) {
          this.db.run("ROLLBACK");
          throw error;
        }
      }
    if (!this.read("settings", "app")) this.put("settings", "app", defaults);
    this.flush();
  }
  private flush() {
    if (this.transactionDepth) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const bytes = this.db.export();
    // SQL.js export reopens the connection, resetting per-connection PRAGMAs.
    this.db.run("PRAGMA foreign_keys=ON");
    writeFileSync(this.path + ".tmp", bytes, { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
  }
  private transaction<T>(action: () => T): T {
    this.db.run("BEGIN IMMEDIATE");
    this.transactionDepth++;
    let result: T;
    try {
      result = action();
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
    this.flush();
    return result;
  }
  transition(id: string, state: TaskState, message: string) {
    this.transaction(() => {
      this.update(id, state);
      this.log(id, message, state === "FAILED" ? "error" : "info");
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(state))
        this.finish(id, state);
    });
  }
  private rows<T>(table: string, suffix = ""): T[] {
    const result = this.db.exec(`SELECT data FROM ${table} ${suffix}`);
    return result.length
      ? result[0].values.map((row) => JSON.parse(String(row[0])))
      : [];
  }
  private read<T>(table: string, id: string): T | undefined {
    const stmt = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`);
    try {
      stmt.bind([id]);
      return stmt.step() ? JSON.parse(String(stmt.get()[0])) : undefined;
    } finally {
      stmt.free();
    }
  }
  private put(table: string, id: string, data: unknown) {
    this.db.run(
      `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      [id, JSON.stringify(data)],
    );
  }
  snapshot(): Snapshot {
    return {
      groups: this.rows("groups"),
      tasks: this.rows("tasks"),
      profiles: this.rows("profiles"),
      proxies: this.rows("proxies"),
      settings: this.read("settings", "app")!,
      logs: this.rows("logs", "ORDER BY at DESC, rowid DESC LIMIT 500"),
      runs: this.rows("runs", "ORDER BY rowid DESC LIMIT 500"),
      queued: [],
    };
  }
  task(id: string): Task {
    const task = this.read<Task>("tasks", id);
    if (!task) throw new Error("Task not found");
    return task;
  }
  saveGroup(input: unknown) {
    const data = groupSchema.parse(input);
    const id = data.id ?? randomUUID();
    if (data.id && !this.read("groups", id)) throw new Error("Group not found");
    this.put("groups", id, { ...data, id });
    this.flush();
    return id;
  }
  saveTask(input: unknown) {
    const data = taskSchema.parse(input);
    if (!this.read("groups", data.groupId)) throw new Error("Group not found");
    if (data.profileId && !this.read("profiles", data.profileId))
      throw new Error("Profile not found");
    if (data.proxyId && !this.read("proxies", data.proxyId))
      throw new Error("Proxy not found");
    const id = data.id ?? randomUUID();
    const old = data.id ? this.task(id) : undefined;
    const task: Task = {
      ...data,
      id,
      state: old?.state ?? "CREATED",
      runId: old?.runId ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.db.run(
      "INSERT INTO tasks(id,group_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,data=excluded.data",
      [id, data.groupId, JSON.stringify(task)],
    );
    this.flush();
    return id;
  }
  saveProfile(input: unknown) {
    const data = profileSchema.parse(input);
    const id = data.id ?? randomUUID();
    if (data.id && !this.read("profiles", id))
      throw new Error("Profile not found");
    this.put("profiles", id, { ...data, id });
    this.flush();
  }
  saveProxy(input: unknown) {
    const data = proxySchema.parse(input);
    const id = data.id ?? randomUUID();
    if (data.id && !this.read("proxies", id))
      throw new Error("Proxy not found");
    this.put("proxies", id, { ...data, id });
    this.flush();
  }
  settings(input: unknown) {
    this.put("settings", "app", settingsSchema.parse(input));
    this.flush();
  }
  delete(kind: "groups" | "tasks" | "profiles" | "proxies", id: string) {
    if (kind === "profiles" || kind === "proxies") {
      const key = kind === "profiles" ? "profileId" : "proxyId";
      if (this.snapshot().tasks.some((t) => t[key] === id))
        throw new Error(
          "This configuration is assigned to a task; unassign it first",
        );
    }
    this.db.run(`DELETE FROM ${kind} WHERE id=?`, [id]);
    this.flush();
  }
  update(id: string, state: TaskState, runId?: string | null) {
    const task = this.task(id);
    this.db.run("UPDATE tasks SET data=? WHERE id=?", [
      JSON.stringify({
        ...task,
        state,
        runId: runId === undefined ? task.runId : runId,
        updatedAt: new Date().toISOString(),
      }),
      id,
    ]);
    this.flush();
  }
  log(taskId: string, message: string, level: "info" | "error" = "info") {
    const task = this.task(taskId);
    const log: Log = {
      id: randomUUID(),
      taskId,
      runId: task.runId,
      at: new Date().toISOString(),
      state: task.state,
      level,
      message,
    };
    this.db.run("INSERT INTO logs VALUES(?,?,?,?)", [
      log.id,
      taskId,
      log.at,
      JSON.stringify(log),
    ]);
    this.db.run(
      "DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 10000)",
    );
    this.flush();
  }
  begin(id: string) {
    return this.transaction(() => {
      const run: Run = {
        id: randomUUID(),
        taskId: id,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: "MONITORING",
      };
      this.db.run("INSERT INTO runs VALUES(?,?,?)", [
        run.id,
        id,
        JSON.stringify(run),
      ]);
      this.update(id, "MONITORING", run.id);
      this.log(id, "Monitoring mock inventory");
      return run.id;
    });
  }
  finish(id: string, outcome: TaskState) {
    const runId = this.task(id).runId;
    if (runId) {
      const run = this.read<Run>("runs", runId);
      if (run)
        this.db.run("UPDATE runs SET data=? WHERE id=?", [
          JSON.stringify({
            ...run,
            endedAt: new Date().toISOString(),
            outcome,
          }),
          runId,
        ]);
    }
    this.flush();
  }
  recover() {
    for (const task of this.snapshot().tasks)
      if (
        [
          "MONITORING",
          "STOCK_DETECTED",
          "CARTING",
          "AWAITING_APPROVAL",
          "CHECKING_OUT",
        ].includes(task.state)
      ) {
        this.transition(
          task.id,
          "CANCELLED",
          "Interrupted run recovered safely; explicit restart required",
        );
      }
  }
  close() {
    this.flush();
    this.db.close();
  }
}
