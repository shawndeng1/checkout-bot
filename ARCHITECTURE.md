# Orbit architecture — Milestone 2

```text
React screens → Zustand revision gate → narrow preload API
                                           ↓ validated IPC
                             Electron main: window + BackendClient
                                           ↓ asynchronous worker RPC
                            Backend worker (one database owner)
                               ├─ Engine / task contexts
                               ├─ FIFO operation capacity + retailer gates
                               ├─ Product-keyed shared inventory registry
                               ├─ Registered mock / loopback HTTP adapters
                               └─ Native SQLite connection → retail.sqlite + WAL
```

## Preserve the desktop boundary

The existing Electron/React UI, profiles, proxies, task groups, task commands, and preload methods remain. Renderer Node integration is disabled; context isolation and the renderer sandbox remain enabled. Navigation, popups, webviews, and permission requests are denied. IPC verifies the sender window, main frame, and trusted local renderer URL, then validates strict Zod command payloads. Production CSP permits bundled scripts; development permits the inline preamble required by React Refresh.

The main process no longer imports the Store or Engine at runtime. `BackendClient` uses `worker_threads` and a typed, request-ID-based protocol. One backend worker owns the engine and the only application database connection. Worker commands are serialized; task execution advances asynchronously between commands. RPC failures reject pending requests. An unexpected worker failure makes the app exit rather than continue with an unavailable engine. Graceful shutdown aborts operations, drains shared polling, commits recovery state, and closes SQLite. A 10-second transport deadline can terminate an unresponsive worker; durable checkout intent then remains subject to conservative recovery.

## Incremental SQLite

The bundled `node:sqlite` driver replaces SQL.js runtime exports. SQLite executes incremental prepared statements, with foreign keys, WAL, `synchronous=FULL`, a bounded busy timeout, and SQL transactions. These synchronous calls occur exclusively in the worker in the desktop application. The same Store is instantiated directly in unit tests. There is no new database format or ORM. SQL.js remains a development dependency solely to test legacy-file compatibility.

`Store.open` rejects duplicate ownership in its isolate; Electron's single-instance lock prevents normal duplicate application owners. External writers are unsupported; SQLite still arbitrates file locks. The implementation does not promise cross-process application ownership arbitration beyond the desktop lock. See [database schema and migration strategy](DATABASE.md) and [driver decision](docs/decisions/002-sqlite-owner.md).

## Logical tasks and operation capacity

A logical task owns an AbortController and lifecycle context. It does not reserve capacity for its lifetime. Shared inventory requests, cart requests, and checkout requests acquire an abortable FIFO execution permit. Approval waits and rate-limit delays do not hold a global permit. Per-retailer gates impose minimum request spacing, concurrency, and shared Retry-After cooldowns. The scheduler rechecks policy after global queueing, including cooldowns discovered by an earlier request.

Queues are bounded at 2,000 entries per gate and the engine admits at most 1,000 simultaneous task contexts. Approval is consumed once per context, then checkout queues through the same bounded scheduler. A queued approval is not persisted as permission to submit after restart: the user must approve again. Checkout itself is never automatically retried.

## Shared inventory and adapters

`SharedInventory` creates one poller for compatible retailer/product/variant subscriptions. Compatibility also includes profile/proxy identity, monitor interval, retry bound, adapter-specific scope, and the adapter's sharing capability. Each subscriber is independently cancellable. The last unsubscribe aborts the source. Observations fan out only once when stock is detected. Source stream IDs, sequences, timestamps, and bounded event-ID/retired-stream caches suppress duplicates and older events. A source restart can introduce a new stream without permanently locking out lower sequence numbers.

The SDK defines capabilities, product/variant IDs, inventory observations, cart and checkout results, authentication requirements, normalized errors, and rate-limit policy/information. The engine depends on `AdapterRegistry`, not concrete retailer classes. `packages/adapters/src/index.ts` composes registrations. The mock adapter retains its legacy convenience methods; the HTTP adapter is registered when the main process receives a loopback `ORBIT_SIMULATOR_URL`. Non-simulated registrations remain disabled in this milestone. Authentication requirements describe future adapter needs; no authentication workflow or credential storage is implemented.

## Revisions and snapshots

Each published engine change advances a SQLite-backed revision. Command responses and event subscriptions carry the revision. Zustand uses a single gate that accepts only strictly newer snapshots, including the initial read; an older command response cannot replace a newer subscription update. Revisions survive restarts. Event snapshots are coalesced over 16ms to reduce IPC bursts. Full snapshots still include up to 500 recent logs/runs; paginated/delta synchronization remains technical debt.

## Recovery and uncertainty

Approval carts and checkout intents are durable. The checkout run UUID is the idempotency key, committed before submission. Cart approval, checkout intent, and terminal results each use transactional state/log/history writes. A lost response or interrupted checkout becomes `UNKNOWN_OUTCOME`; start/restart is blocked. Configured monitoring can restart automatically with a new run ID. Saved approvals are restored but never submitted automatically. Missing optional adapters preserve saved approvals without preventing app startup; the task can be cancelled or the adapter restored on a subsequent launch.

## Build and scope

pnpm workspaces retain source-level domain boundaries. Vite builds the renderer; esbuild bundles main, preload, and backend worker separately. No WASM runtime asset or native addon rebuild is required. The development CLI requires Node 24.15+; Electron's locked runtime is checked through actual desktop tests. This milestone makes zero real retailer requests or purchases.
