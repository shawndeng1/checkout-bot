# SQLite schema and migration strategy

Orbit continues to use the existing `retail.sqlite` file in Electron user data (or `RETAIL_DATA_DIR`). Milestone 2 opens it directly with native SQLite in the backend worker. SQL.js files are ordinary SQLite files: no export/import conversion or record rewrite is required.

## Migration safety

1. Acquire the application Store owner; open one native connection with foreign keys.
2. Enable WAL and FULL synchronous commits, and set a bounded busy timeout (1 second by default).
3. Reject schema versions newer than the application supports. Read-only opens require an already migrated schema.
4. Before migrating v1, use SQLite's online backup API to write a temporary backup, then atomically rename it to `retail.sqlite.v1.bak`. The backup includes committed WAL contents and is not overwritten on subsequent starts.
5. Apply each unapplied migration transactionally and record its version. A migration failure rolls back schema changes and leaves user records intact. Failed Store opens close the connection and release ownership.

Database and migration backup files use mode 0600 on platforms supporting Unix modes. Keep backup/WAL files with their database when making manual copies; use SQLite's backup API for a live database. No automatic restore overwrites user data.

## Tables

| Version | Table             | Columns / purpose                                                                                                     |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1       | migrations        | version (PK): applied schema versions                                                                                 |
| 1       | groups            | id (PK), data: task-group name and retailer registration ID                                                           |
| 1       | tasks             | id (PK), group_id (FK), data: task configuration, lifecycle state, run ID, update timestamp                           |
| 1       | profiles          | id (PK), data: contact/shipping details, named group, mock payment token                                              |
| 1       | proxies           | id (PK), data: named group, protocol, host, port                                                                      |
| 1       | runs              | id (PK), task_id (FK), data: start/end, outcome, optional recovery reason                                             |
| 1       | logs              | id (PK), task_id (FK), at, data: structured task/run event                                                            |
| 1       | settings          | id (PK), data: singleton application settings                                                                         |
| 2       | approvals         | id (task FK and PK), data: run ID and typed cart waiting for approval                                                 |
| 2       | checkout_attempts | id (run FK and PK), task_id (FK), data: idempotency key, cart, submission intent, status, timestamps, optional result |
| 2       | metadata          | key (PK), value: persisted monotonically increasing snapshot revision                                                 |

Indexes: tasks by group; logs by task/time; runs and checkout attempts by task. Group deletion cascades to tasks and all related history/approvals/attempts. Assigned profiles/proxies cannot be deleted until unassigned. Profile/proxy groups remain named labels. JSON text preserves v1 records and keeps domain data extensible while relational IDs provide foreign-key relationships and indexes.

New `variantId` task values default to null when reading v1 data. Missing `resumeMonitoring` settings default to false. Existing groups, tasks, profiles, proxies, settings, logs and runs are retained. No plaintext card, password, or authentication-token fields are added.

## Lifecycle transactions

- Begin: run record, monitoring state, initial log.
- Stock/cart transitions: state, log, and terminal history where applicable.
- Approval: durable typed cart, awaiting-approval state, log.
- Checkout intent: unique run/idempotency key, pending attempt, removal of approval, checking-out state, log; commit before calling the adapter.
- Completion/failure/unknown: attempt status/result, terminal task state, closed run, log.
- Recovery: state classification, attempt/run updates, and recovery event.

No write exports the whole database. SQLite handles incremental WAL writes and checkpoints. A write failure throws; a failed lifecycle transaction rolls back its task state, log, and history together. Tests inject statement failures, failed migrations, read-only writes, and abrupt worker exits. Physical disk-full, power-loss, network-filesystem durability, and corruption repair are not established by those tests.

Logs retain 10,000 events globally; snapshots expose the latest 500 logs and runs. Persisted runs remain until task/group deletion. Contact data remains unencrypted local data protected by the OS account.
