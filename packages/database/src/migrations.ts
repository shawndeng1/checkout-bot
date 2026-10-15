export const migrations = [
  {
    version: 1,
    sql: `
   CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS proxies(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS logs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, at TEXT NOT NULL, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS tasks_group ON tasks(group_id);
   CREATE INDEX IF NOT EXISTS logs_task_time ON logs(task_id,at);
   CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
`,
  },
  {
    version: 2,
    sql: `
    CREATE TABLE approvals(id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE checkout_attempts(id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE INDEX attempts_task ON checkout_attempts(task_id);
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO metadata VALUES('revision',0);
  `,
  },
  {
    version: 3,
    sql: `
 CREATE TABLE inventory_events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,data TEXT NOT NULL);
 CREATE INDEX inventory_task ON inventory_events(task_id);
 CREATE TABLE latest_inventory(id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,data TEXT NOT NULL);
 CREATE TABLE notices(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,data TEXT NOT NULL);
 CREATE TABLE reconciliations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,attempt_id TEXT NOT NULL REFERENCES checkout_attempts(id) ON DELETE CASCADE,data TEXT NOT NULL);
 CREATE INDEX reconciliations_attempt ON reconciliations(attempt_id);
 CREATE TABLE retailer_configs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 `,
  },
  {
    version: 4,
    sql: `
 CREATE TABLE monitoring_health(id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,data TEXT NOT NULL);
 INSERT INTO monitoring_health SELECT id,json_object('taskId',id,'lastSuccess',json_extract(data,'$.receivedAt')) FROM latest_inventory;
 `,
  },
];
