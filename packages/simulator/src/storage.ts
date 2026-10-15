import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const owners = new Set<string>();
/** A separate service database, never the desktop application's retail.sqlite. */
export class SimulatorStorage {
  private db: DatabaseSync;
  private key: string;
  readonly sourceId: string;
  constructor(path = ":memory:") {
    this.key = path === ":memory:" ? "" : resolve(path);
    if (this.key && owners.has(this.key))
      throw new Error("Simulator database already owned");
    if (this.key) mkdirSync(dirname(this.key), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      const existing = this.db
        .prepare("SELECT name FROM sqlite_master WHERE name='simulator_schema'")
        .get();
      if (
        !existing &&
        this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
          )
          .get()
      )
        throw new Error("Database is not an Orbit simulator database");
      if (
        existing &&
        Number(
          this.db
            .prepare("SELECT MAX(version) AS version FROM simulator_schema")
            .get()?.version,
        ) !== 1
      )
        throw new Error("Unsupported simulator database version");
      this.db
        .exec(`PRAGMA foreign_keys=ON;PRAGMA busy_timeout=1000;PRAGMA locking_mode=EXCLUSIVE;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS simulator_schema(version INTEGER PRIMARY KEY);INSERT OR IGNORE INTO simulator_schema VALUES(1);
      CREATE TABLE IF NOT EXISTS metadata(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS carts(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,cart_id TEXT NOT NULL REFERENCES carts(id),data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_status ON orders(json_extract(data,'$.status'));`);
      if (
        Number(
          this.db
            .prepare("SELECT MAX(version) AS version FROM simulator_schema")
            .get()?.version,
        ) !== 1
      )
        throw new Error("Unsupported simulator database version");
      this.sourceId = this.get<string>("metadata", "source") ?? randomUUID();
      this.set("metadata", "source", this.sourceId);
      if (this.key) {
        chmodSync(this.key, 0o600);
        owners.add(this.key);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(table: "metadata" | "carts" | "orders", id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  set(table: "metadata" | "carts", id: string, value: unknown) {
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(id, JSON.stringify(value));
  }
  insertOrder(id: string, cartId: string, value: unknown) {
    this.db
      .prepare("INSERT INTO orders VALUES(?,?,?)")
      .run(id, cartId, JSON.stringify(value));
  }
  updateOrder(id: string, value: unknown) {
    this.db
      .prepare("UPDATE orders SET data=? WHERE id=?")
      .run(JSON.stringify(value), id);
  }
  orderCount() {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM orders WHERE json_extract(data,'$.result.orderId') IS NOT NULL",
        )
        .get()?.count ?? 0,
    );
  }
  pendingOrders<T>(): [string, T][] {
    return this.db
      .prepare(
        "SELECT id,data FROM orders WHERE json_extract(data,'$.status')='pending'",
      )
      .all()
      .map((row) => [String(row.id), JSON.parse(String(row.data))]);
  }
  orders<T>(): [string, T][] {
    return this.db
      .prepare("SELECT id,data FROM orders")
      .all()
      .map((row) => [String(row.id), JSON.parse(String(row.data))]);
  }
  close() {
    this.db.close();
    if (this.key) owners.delete(this.key);
  }
}
