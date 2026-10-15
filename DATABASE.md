# Database

Migration definitions live in `packages/database/src/migrations.ts`. Each unapplied migration runs in a transaction and records its version. A database with a newer schema version is rejected rather than downgraded.

| Table      | Columns                                     | Purpose                                                        |
| ---------- | ------------------------------------------- | -------------------------------------------------------------- |
| migrations | version (PK)                                | Applied migration versions                                     |
| groups     | id (PK), data (JSON text)                   | Name and mock retailer identifier                              |
| tasks      | id (PK), group_id (FK), data (JSON text)    | Configuration, current state, execution ID, update timestamp   |
| profiles   | id (PK), data (JSON text)                   | Named group, contact/shipping fields, mock payment placeholder |
| proxies    | id (PK), data (JSON text)                   | Named group, HTTP/SOCKS5 protocol, host, port                  |
| runs       | id (PK), task_id (FK), data (JSON text)     | Start/end timestamps and terminal outcome                      |
| logs       | id (PK), task_id (FK), at, data (JSON text) | Execution ID, state, level, timestamp and message              |
| settings   | id (PK), data (JSON text)                   | Singleton `app`: concurrency, notices, log level, startup view |

Indexes: `tasks_group(group_id)`, `logs_task_time(task_id, at)`, `runs_task(task_id)`. Deleting groups cascades to tasks, runs, and logs. Deleting tasks cascades to history. Assigned profiles/proxies cannot be deleted until tasks unassign them. Profile/proxy group names are embedded organizational labels in this milestone, rather than separate group entities.

UUIDs identify entities. Timestamps use ISO UTC strings and render in local time. Strict Zod schemas validate incoming configurations, including placeholder-token prefixes. Parameter binding is used for all user values. Table names and query suffixes are private, fixed internal values. JSON text keeps initial migrations small while relationship keys and indexes remain relational.

Every mutation is persisted to disk. Starting a run stores the run record, monitoring state, and initial log in one transaction. State transitions and terminal outcomes are similarly atomic. Startup recovery marks all active states cancelled, closes their run records, and records an interruption event. Queued requests are volatile and dropped on restart; no queued task has started a run.

Logs are globally capped at 10,000 events; UI snapshots include 500 recent events and 500 recent runs. Run records remain persisted until task/group deletion. Shipping/contact data is unencrypted local data. No sensitive authentication, passwords, raw payment card numbers, or proxy credentials are supported.
