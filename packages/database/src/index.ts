import { migrations } from "./migrations";
import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
export interface StoreOptions {
  readOnly?: boolean;
  busyTimeoutMs?: number;
}
const owners = new Set<string>();
// In the desktop app this synchronous driver is owned exclusively by the backend worker.
export class Store {
  private db: DatabaseSync;
  private ownerKey: string;
  static async open(path: string, options: StoreOptions = {}) {
    const key = path === ":memory:" ? "" : resolve(path);
    if (key && owners.has(key))
      throw new Error("Database already has an owner");
    if (key) owners.add(key);
    let store: Store | undefined;
    try {
      store = new Store(path, key, options);
      const hasMigrations = store.db
        .prepare("SELECT name FROM sqlite_master WHERE name='migrations'")
        .get();
      const version = hasMigrations
        ? Number(
            store.db
              .prepare("SELECT MAX(version) AS version FROM migrations")
              .get()?.version ?? 0,
          )
        : 0;
      if (!options.readOnly && version === 1 && !existsSync(path + ".v1.bak")) {
        await backup(store.db, path + ".v1.bak");
        chmodSync(path + ".v1.bak", 0o600);
      }
      if (!options.readOnly) store.initialize();
      return store;
    } catch (error) {
      store?.db.close();
      if (key) owners.delete(key);
      throw error;
    }
  }
  private constructor(path: string, ownerKey: string, options: StoreOptions) {
    this.ownerKey = ownerKey;
    if (path !== ":memory:" && !options.readOnly)
      mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly });
    this.db.exec(
      `PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${options.busyTimeoutMs ?? 1000};`,
    );
    if (!options.readOnly) {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (path !== ":memory:") chmodSync(path, 0o600);
    }
  }
  private run(sql: string, params?: SQLInputValue[]) {
    if (params) this.db.prepare(sql).run(...params);
    else this.db.exec(sql);
  }
  private initialize() {
    this.run(
      "CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY)",
    );
    const versions = this.db
      .prepare("SELECT version FROM migrations")
      .all()
      .map((row) => Number(row.version));
    if (versions.some((version) => version > migrations.at(-1)!.version))
      throw new Error("Database was created by a newer application version");
    for (const migration of migrations)
      if (!versions.includes(migration.version)) {
        this.run("BEGIN IMMEDIATE");
        try {
          this.run(migration.sql);
          this.run("INSERT INTO migrations VALUES(?)", [migration.version]);
          this.run("COMMIT");
        } catch (error) {
          this.run("ROLLBACK");
          throw error;
        }
      }
    if (!this.read("settings", "app")) this.put("settings", "app", defaults);
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  diagnostics() {
    return {
      journalMode: this.db.prepare("PRAGMA journal_mode").get()?.journal_mode,
      foreignKeys: this.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
    };
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
    return this.db
      .prepare(`SELECT data FROM ${table} ${suffix}`)
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  private read<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private put(table: string, id: string, data: unknown) {
    this.run(
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
    this.run(
      "INSERT INTO tasks(id,group_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,data=excluded.data",
      [id, data.groupId, JSON.stringify(task)],
    );
    return id;
  }
  saveProfile(input: unknown) {
    const data = profileSchema.parse(input);
    const id = data.id ?? randomUUID();
    if (data.id && !this.read("profiles", id))
      throw new Error("Profile not found");
    this.put("profiles", id, { ...data, id });
  }
  saveProxy(input: unknown) {
    const data = proxySchema.parse(input);
    const id = data.id ?? randomUUID();
    if (data.id && !this.read("proxies", id))
      throw new Error("Proxy not found");
    this.put("proxies", id, { ...data, id });
  }
  settings(input: unknown) {
    this.put("settings", "app", settingsSchema.parse(input));
  }
  delete(kind: "groups" | "tasks" | "profiles" | "proxies", id: string) {
    if (kind === "profiles" || kind === "proxies") {
      const key = kind === "profiles" ? "profileId" : "proxyId";
      if (this.snapshot().tasks.some((t) => t[key] === id))
        throw new Error(
          "This configuration is assigned to a task; unassign it first",
        );
    }
    this.run(`DELETE FROM ${kind} WHERE id=?`, [id]);
  }
  update(id: string, state: TaskState, runId?: string | null) {
    const task = this.task(id);
    this.run("UPDATE tasks SET data=? WHERE id=?", [
      JSON.stringify({
        ...task,
        state,
        runId: runId === undefined ? task.runId : runId,
        updatedAt: new Date().toISOString(),
      }),
      id,
    ]);
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
    this.run("INSERT INTO logs VALUES(?,?,?,?)", [
      log.id,
      taskId,
      log.at,
      JSON.stringify(log),
    ]);
    this.run(
      "DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 10000)",
    );
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
      this.run("INSERT INTO runs VALUES(?,?,?)", [
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
        this.run("UPDATE runs SET data=? WHERE id=?", [
          JSON.stringify({
            ...run,
            endedAt: new Date().toISOString(),
            outcome,
          }),
          runId,
        ]);
    }
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
    this.db.close();
    if (this.ownerKey) owners.delete(this.ownerKey);
  }
}
