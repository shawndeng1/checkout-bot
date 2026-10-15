# Incremental SQLite and worker ownership

Decision: replace SQL.js exports with Electron/Node's bundled `node:sqlite` driver, and put the task engine plus its only database connection in a backend worker. The Electron main process only validates IPC and forwards typed requests. The UI and preload contract remain intact.

Evaluated alternatives:

- Keeping SQL.js exports preserves ABI portability but does not offer incremental file-backed writes.
- `better-sqlite3` offers a mature API but adds native binary/rebuild requirements for each Electron ABI and target OS.
- Bundled `node:sqlite` avoids native addon packaging, opens existing SQLite files directly, and provides SQLite transactions and WAL. Its synchronous calls are acceptable exclusively in the worker. Node 24's API is a release candidate, so runtime compatibility must be verified in Electron tests and pinned through the dependency lockfile.

The native driver executes incremental prepared statements with WAL, FULL synchronous mode, foreign keys, and a bounded busy timeout. A per-isolate owner guard prevents accidental duplicate Store instances; the desktop single-instance lock prevents normal duplicate application owners. SQLite arbitrates external file locks. No application code should open a second writer.

Existing v1 SQL.js files are ordinary SQLite files and require no conversion. Before applying schema changes, an SQLite online backup is saved once as `retail.sqlite.v1.bak` (mode 0600). Transactions record migration versions. Unknown newer versions are rejected. Backups must include live WAL content, so raw file copying is not used.

Store methods remain synchronous for engine consistency and straightforward transaction boundaries. Desktop callers use asynchronous worker RPC; filesystem and SQLite work never run in the main/renderer processes. Worker failure rejects pending requests and exits the app rather than silently keeping a nonfunctional engine.

References: [Node 24 SQLite API](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html), [Electron threading](https://www.electronjs.org/docs/latest/tutorial/multithreading).
