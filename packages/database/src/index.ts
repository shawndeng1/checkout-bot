import {
  observationSchema,
  orderStatusSchema,
  type InventoryObservation,
  type OrderStatus,
} from "../../retailer-sdk/src/index";
import type {
  InventoryRecord,
  InventoryNotice,
  CheckoutAttempt,
  Reconciliation,
} from "../../shared-types/src/index";
import type { CartResult, CheckoutResult } from "../../retailer-sdk/src/index";
import { migrations } from "./migrations";
import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import { mkdirSync, existsSync, chmodSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
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
  resumeMonitoring: false,
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
      if (version > migrations.at(-1)!.version)
        throw new Error("Database was created by a newer application version");
      if (options.readOnly && version < migrations.at(-1)!.version)
        throw new Error("Database requires migration before read-only access");
      if (
        !options.readOnly &&
        version > 0 &&
        version < migrations.at(-1)!.version &&
        !existsSync(path + `.v${version}.bak`)
      ) {
        const pending = path + `.v${version}.bak.${randomUUID()}.tmp`;
        try {
          await backup(store.db, pending);
          chmodSync(pending, 0o600);
          renameSync(pending, path + `.v${version}.bak`);
        } finally {
          if (existsSync(pending)) rmSync(pending);
        }
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
    if (this.db.isTransaction) return action();
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
      this.log(
        id,
        message,
        ["FAILED", "UNKNOWN_OUTCOME"].includes(state) ? "error" : "info",
      );
      if (
        ["COMPLETED", "FAILED", "CANCELLED", "UNKNOWN_OUTCOME"].includes(state)
      ) {
        this.run("DELETE FROM approvals WHERE id=?", [id]);
        this.finish(id, state);
      }
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
      revision: this.revision(),
      retailers: [],
      inventory: this.rows("inventory_events", "ORDER BY rowid DESC LIMIT 500"),
      latestInventory: this.rows("latest_inventory"),
      notices: this.rows("notices", "ORDER BY rowid DESC LIMIT 100"),
      attempts: this.rows(
        "checkout_attempts",
        `WHERE id IN (SELECT id FROM checkout_attempts ORDER BY rowid DESC LIMIT 500) OR id IN (SELECT json_extract(data,'$.runId') FROM tasks WHERE json_extract(data,'$.state')='UNKNOWN_OUTCOME') ORDER BY rowid DESC`,
      ),
      reconciliations: this.rows(
        "reconciliations",
        "ORDER BY rowid DESC LIMIT 500",
      ),
      groups: this.rows("groups"),
      tasks: this.rows<Task>("tasks").map((task) => ({
        ...task,
        variantId: task.variantId ?? null,
        workflow: task.workflow ?? "MONITOR_AND_CHECKOUT",
      })),
      profiles: this.rows("profiles"),
      proxies: this.rows("proxies"),
      settings: this.getSettings(),
      logs: this.rows("logs", "ORDER BY at DESC, rowid DESC LIMIT 500"),
      runs: this.rows("runs", "ORDER BY rowid DESC LIMIT 500"),
      queued: [],
    };
  }
  group(id: string) {
    const group = this.read<import("../../shared-types/src/index").Group>(
      "groups",
      id,
    );
    if (!group) throw new Error("Group not found");
    return group;
  }
  task(id: string): Task {
    const task = this.read<Task>("tasks", id);
    if (!task) throw new Error("Task not found");
    return {
      ...task,
      variantId: task.variantId ?? null,
      workflow: task.workflow ?? "MONITOR_AND_CHECKOUT",
    };
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
  getSettings() {
    return settingsSchema.parse(this.read("settings", "app"));
  }
  revision() {
    return Number(
      this.db.prepare("SELECT value FROM metadata WHERE key='revision'").get()
        ?.value ?? 0,
    );
  }
  nextRevision() {
    this.run("UPDATE metadata SET value=value+1 WHERE key='revision'");
    return this.revision();
  }
  approval(id: string) {
    return this.read<{ taskId: string; runId: string; cart: CartResult }>(
      "approvals",
      id,
    );
  }
  prepareApproval(id: string, cart: CartResult) {
    this.transaction(() => {
      this.put("approvals", id, {
        taskId: id,
        runId: this.task(id).runId,
        cart,
      });
      this.transition(
        id,
        "AWAITING_APPROVAL",
        "Simulated cart ready; approve to continue",
      );
    });
  }
  beginCheckout(
    id: string,
    cart: CartResult,
    retailerId?: string,
    configFingerprint?: string,
  ) {
    return this.transaction(() => {
      const runId = this.task(id).runId;
      if (!runId) throw new Error("No execution ID");
      this.run("INSERT INTO checkout_attempts VALUES(?,?,?)", [
        runId,
        id,
        JSON.stringify({
          id: runId,
          taskId: id,
          cart,
          retailerId,
          configFingerprint,
          sourceId: cart.sourceId,
          status: "pending",
          submittedAt: new Date().toISOString(),
        }),
      ]);
      this.run("DELETE FROM approvals WHERE id=?", [id]);
      this.transition(id, "CHECKING_OUT", "Processing simulated checkout");
      return runId;
    });
  }
  checkoutAttempts(id: string) {
    return this.db
      .prepare("SELECT data FROM checkout_attempts WHERE task_id=?")
      .all(id)
      .map((row) => JSON.parse(String(row.data)));
  }
  finishCheckout(
    id: string,
    state: TaskState,
    message: string,
    result?: CheckoutResult,
  ) {
    this.transaction(() => {
      const runId = this.task(id).runId;
      const attempt = runId
        ? this.read<Record<string, unknown>>("checkout_attempts", runId)
        : undefined;
      if (attempt)
        this.run("UPDATE checkout_attempts SET data=? WHERE id=?", [
          JSON.stringify({
            ...attempt,
            status:
              state === "COMPLETED"
                ? "succeeded"
                : state === "UNKNOWN_OUTCOME"
                  ? "unknown"
                  : "failed",
            result,
            endedAt: new Date().toISOString(),
          }),
          runId!,
        ]);
      this.transition(id, state, message);
    });
  }
  private recoveryTag(id: string, reason: Run["recovery"]) {
    const runId = this.task(id).runId;
    const run = runId ? this.read<Run>("runs", runId) : undefined;
    if (run)
      this.run("UPDATE runs SET data=? WHERE id=?", [
        JSON.stringify({ ...run, recovery: reason }),
        runId!,
      ]);
  }
  recover(): string[] {
    const resume: string[] = [];
    for (const task of this.snapshot().tasks)
      this.transaction(() => {
        if (
          task.state === "MONITORING" ||
          (task.state === "STOCK_DETECTED" &&
            task.workflow !== "MONITOR_AND_CHECKOUT")
        ) {
          this.transition(
            task.id,
            "CANCELLED",
            "Interrupted monitoring recovered; " +
              (this.getSettings().resumeMonitoring
                ? "automatic monitoring restart configured"
                : "explicit restart required"),
          );
          this.recoveryTag(task.id, "interrupted-monitoring");
          if (this.getSettings().resumeMonitoring) resume.push(task.id);
        } else if (task.state === "AWAITING_APPROVAL") {
          if (this.approval(task.id)) {
            this.log(
              task.id,
              "Approval restored; explicit user approval required",
            );
            this.recoveryTag(task.id, "approval-restored");
          } else {
            this.transition(
              task.id,
              "CANCELLED",
              "Legacy approval has no saved cart; explicit restart required",
            );
            this.recoveryTag(task.id, "interrupted-operation");
          }
        } else if (task.state === "CHECKING_OUT") {
          this.finishCheckout(
            task.id,
            "UNKNOWN_OUTCOME",
            "Interrupted checkout has an unknown outcome; automatic retry prohibited",
          );
          this.recoveryTag(task.id, "checkout-unknown");
        } else if (["STOCK_DETECTED", "CARTING"].includes(task.state)) {
          this.transition(
            task.id,
            "CANCELLED",
            "Interrupted cart operation recovered; explicit restart required",
          );
          this.recoveryTag(task.id, "interrupted-operation");
        }
      });
    for (const reconciliation of this.rows<Reconciliation>("reconciliations"))
      if (reconciliation.status === "started")
        this.run("UPDATE reconciliations SET data=? WHERE id=?", [
          JSON.stringify({
            ...reconciliation,
            status: "interrupted",
            message: "Status lookup interrupted; safe to check again",
          }),
          reconciliation.id,
        ]);
    return resume;
  }

  retailerConfig(id: string): Record<string, unknown> {
    return this.read<Record<string, unknown>>("retailer_configs", id) ?? {};
  }
  saveRetailerConfig(id: string, config: Record<string, unknown>) {
    this.put("retailer_configs", id, config);
  }
  recordInventory(
    ids: string[],
    input: InventoryObservation,
    changed = true,
  ): InventoryNotice | undefined {
    const event = observationSchema.parse(input);
    return this.transaction(() => {
      let notice: InventoryNotice | undefined;
      for (const taskId of ids) {
        const task = this.task(taskId);
        const previous = this.read<InventoryRecord>("latest_inventory", taskId);
        const record: InventoryRecord = {
          id: createHash("sha256")
            .update(JSON.stringify([taskId, event.streamId, event.eventId]))
            .digest("hex"),
          taskId,
          runId: task.runId,
          observation: event,
          receivedAt: new Date().toISOString(),
        };
        this.put("latest_inventory", taskId, record);
        if (changed)
          this.run("INSERT OR IGNORE INTO inventory_events VALUES(?,?,?)", [
            record.id,
            taskId,
            JSON.stringify(record),
          ]);
        if (task.workflow !== "MONITOR_AND_CHECKOUT") {
          if (
            event.availability === "in-stock" &&
            task.state === "MONITORING"
          ) {
            this.update(taskId, "STOCK_DETECTED");
            this.log(taskId, "Inventory available; continuous monitoring");
          } else if (
            event.availability !== "in-stock" &&
            task.state === "STOCK_DETECTED"
          ) {
            this.update(taskId, "MONITORING");
            this.log(taskId, "Availability changed; monitoring continues");
          }
        }
        if (
          changed &&
          task.workflow === "MONITOR_AND_NOTIFY" &&
          this.getSettings().inventoryNotifications &&
          event.availability === "in-stock" &&
          previous?.observation.availability !== "in-stock"
        ) {
          const key = createHash("sha256")
            .update(
              JSON.stringify([
                event.retailerId,
                event.product,
                event.streamId,
                event.eventId,
              ]),
            )
            .digest("hex");
          if (!this.read("notices", key)) {
            notice = {
              id: key,
              taskId,
              product: task.product,
              variant: task.variantId,
              retailer: event.retailerId,
              at: new Date().toISOString(),
              message: `${task.product}${task.variantId ? " / " + task.variantId : ""} is available`,
            };
            this.run("INSERT INTO notices VALUES(?,?,?)", [
              key,
              taskId,
              JSON.stringify(notice),
            ]);
          }
        }
      }
      this.run(
        "DELETE FROM inventory_events WHERE id IN(SELECT id FROM inventory_events ORDER BY rowid DESC LIMIT -1 OFFSET 10000)",
      );
      this.run(
        "DELETE FROM notices WHERE id IN(SELECT id FROM notices ORDER BY rowid DESC LIMIT -1 OFFSET 1000)",
      );
      return notice;
    });
  }
  attempt(id: string) {
    return this.read<CheckoutAttempt>("checkout_attempts", id);
  }
  beginReconciliation(taskId: string) {
    return this.transaction(() => {
      const task = this.task(taskId);
      if (
        task.state !== "UNKNOWN_OUTCOME" ||
        !task.runId ||
        !this.attempt(task.runId)
      )
        throw new Error("No unknown checkout attempt to reconcile");
      const row: Reconciliation = {
        id: randomUUID(),
        taskId,
        attemptId: task.runId,
        at: new Date().toISOString(),
        status: "started",
        message: "Checking order status; no order will be submitted",
      };
      this.run("INSERT INTO reconciliations VALUES(?,?,?,?)", [
        row.id,
        taskId,
        row.attemptId,
        JSON.stringify(row),
      ]);
      return row;
    });
  }
  finishReconciliation(id: string, input?: unknown, errorMessage?: string) {
    return this.transaction(() => {
      const lookup = this.read<Reconciliation>("reconciliations", id);
      if (!lookup || lookup.status !== "started") return;
      const attempt = this.attempt(lookup.attemptId);
      const task = this.task(lookup.taskId);
      if (!attempt) throw new Error("Attempt missing");
      let status: Reconciliation["status"] = "error";
      let message = errorMessage ?? "Invalid status evidence";
      let result: OrderStatus | undefined;
      const parsed = orderStatusSchema.safeParse(input);
      if (parsed.success) {
        const candidate = parsed.data;
        const last = attempt.lastStatus;
        if (
          candidate.idempotencyKey !== attempt.id ||
          !attempt.sourceId ||
          candidate.sourceId !== attempt.sourceId
        )
          message = "Source or attempt mismatch; outcome remains unknown";
        else if (
          candidate.checkedAt < Date.now() - 30000 ||
          candidate.checkedAt > Date.now() + 5000 ||
          candidate.checkedAt < Date.parse(attempt.submittedAt) ||
          candidate.checkedAt < Date.parse(lookup.at) ||
          (last &&
            (candidate.sequence < last.sequence ||
              candidate.checkedAt < last.checkedAt ||
              (candidate.sequence === last.sequence &&
                (candidate.status !== last.status ||
                  (candidate.status === "completed" &&
                    last.status === "completed" &&
                    candidate.orderId !== last.orderId)))))
        )
          message = "Stale status evidence ignored";
        else {
          result = candidate;
          status = candidate.status;
          message =
            candidate.status === "completed"
              ? `Confirmed order ${candidate.orderId}`
              : candidate.status === "failed"
                ? candidate.reason
                : (candidate.reason ?? "Order status is not yet conclusive");
        }
      }
      this.run("UPDATE reconciliations SET data=? WHERE id=?", [
        JSON.stringify({ ...lookup, status, message, result }),
        id,
      ]);
      if (result) {
        this.run("UPDATE checkout_attempts SET data=? WHERE id=?", [
          JSON.stringify({ ...attempt, lastStatus: result }),
          attempt.id,
        ]);
      }
      if (
        task.state === "UNKNOWN_OUTCOME" &&
        task.runId === attempt.id &&
        result?.authoritative
      ) {
        if (result.status === "completed")
          this.finishCheckout(task.id, "COMPLETED", message, {
            orderId: result.orderId,
            status: "completed",
            idempotencyKey: attempt.id,
          });
        else if (result.status === "failed")
          this.finishCheckout(task.id, "FAILED", message);
      }
      this.log(task.id, `Order status: ${message}`);
    });
  }
  close() {
    this.db.close();
    if (this.ownerKey) owners.delete(this.ownerKey);
  }
}
