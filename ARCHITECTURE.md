# Orbit architecture — Milestone 4

```text
React screens → Zustand revision gate → narrow preload API
                                           ↓ validated IPC
                             Electron main: window + BackendClient
                                           ↓ asynchronous worker RPC
                            Backend worker (one database owner)
                               ├─ Engine / task contexts
                               ├─ FIFO operation capacity + retailer gates
                               ├─ Product-keyed shared inventory registry
                               ├─ Registered mock / HTTP / Shopify inventory adapters
                               └─ Native SQLite connection → retail.sqlite + WAL
```

## Preserve the desktop boundary

The existing Electron/React UI, profiles, proxies, task groups, task commands, and preload methods remain. Renderer Node integration is disabled; context isolation and the renderer sandbox remain enabled. Navigation, popups, webviews, and permission requests are denied. IPC verifies the sender window, main frame, and trusted local renderer URL, then validates strict Zod command payloads. Production CSP permits bundled scripts; development permits the inline preamble required by React Refresh.

The main process no longer imports the Store or Engine at runtime. `BackendClient` uses `worker_threads` and a typed, request-ID-based protocol. One backend worker owns the engine and the only application database connection. Mutating worker commands are serialized; reconciliation requests may overlap so the engine can coalesce duplicate lookups. Task execution advances asynchronously between commands. Main also serializes configuration/credential changes with normal task commands. RPC failures reject pending requests. An unexpected worker failure rejects pending RPCs and blocks operations while keeping the renderer/diagnostics available. A 2.5-second health-RPC deadline detects an unresponsive worker; later successful diagnostics can clear that temporary gate. Startup has a 10-second deadline. An exited worker requires explicit application restart, preserving single-owner recovery. Discovery has separate cancellable request IDs, uses the same scheduler and retailer policy, and is not serialized behind normal command RPCs. Paginated inventory queries are read-only and independent of snapshot application.

Graceful shutdown aborts operations, drains shared polling, commits recovery state, and closes SQLite. A 10-second transport deadline can terminate an unresponsive worker; durable checkout intent then remains subject to conservative recovery.

## Incremental SQLite

The bundled `node:sqlite` driver replaces SQL.js runtime exports. SQLite executes incremental prepared statements, with foreign keys, WAL, `synchronous=FULL`, a bounded busy timeout, and SQL transactions. These synchronous calls occur exclusively in the worker in the desktop application. The same Store is instantiated directly in unit tests. There is no new database format or ORM. SQL.js remains a development dependency solely to test legacy-file compatibility.

`Store.open` rejects duplicate ownership in its isolate; Electron's single-instance lock prevents normal duplicate application owners. External writers are unsupported; SQLite still arbitrates file locks. The implementation does not promise cross-process application ownership arbitration beyond the desktop lock. See [database schema and migration strategy](DATABASE.md) and [driver decision](docs/decisions/002-sqlite-owner.md).

## Logical tasks and operation capacity

A logical task owns an AbortController and lifecycle context. It does not reserve capacity for its lifetime. Shared inventory requests, cart requests, checkout requests, and order-status lookups acquire an abortable FIFO execution permit. Approval waits and rate-limit delays do not hold a global permit. Per-retailer gates impose minimum request spacing, concurrency, and shared Retry-After cooldowns. The scheduler rechecks policy after global queueing, including cooldowns discovered by an earlier request.

Queues are bounded at 2,000 entries per gate and the engine admits at most 1,000 simultaneous task contexts. Approval is consumed once per context, then checkout queues through the same bounded scheduler. A queued approval is not persisted as permission to submit after restart: the user must approve again. Checkout itself is never automatically retried.

## Shared inventory and adapters

`SharedInventory` creates one poller for compatible retailer/product/variant subscriptions. Compatibility also includes profile/proxy identity, monitor interval, retry bound, adapter-specific scope, and the adapter's sharing capability. Each subscriber is independently cancellable. The last unsubscribe aborts the source. Observations fan out to all current subscribers. Checkout subscribers leave on stock detection; continuous workflows remain subscribed through availability changes. Fresh repeated source events refresh latest-observation TTL without duplicating history. SQLite records initial/changed observations, independent durable last-success/error health, and creates deduplicated in-app notices transactionally; opt-in native events originate from this same pipeline after commit. Source stream IDs, sequences, timestamps, and bounded event-ID/retired-stream caches suppress duplicates and older events. A source restart can introduce a new stream without permanently locking out lower sequence numbers.

The SDK defines optional product search/lookup and expanded product/variant metadata as well as capabilities, product/variant IDs, inventory observations, cart and checkout results, authentication requirements, normalized errors, and rate-limit policy/information. The engine depends on `AdapterRegistry`, not concrete retailer classes. `packages/adapters/src/index.ts` composes registrations. The mock adapter retains its legacy convenience methods; the HTTP adapter is registered when the main process receives a loopback `ORBIT_SIMULATOR_URL`. Non-simulated adapters may advertise inventory/product lookup/variants but cannot advertise purchasing or order-status capabilities. Strict retailer-specific configuration schemas and generic field descriptors drive Settings without retailer-specific engine logic. Cart/checkout/order-status methods are optional. The Shopify adapter uses only documented Storefront product queries with a loopback fixture fallback. Electron main encrypts supplied public Storefront tokens using OS-backed safeStorage; SQLite stores public configuration only. Decrypted tokens live only in main/worker memory. See [integration boundaries](RETAILER_INTEGRATION_GUIDE.md).

## Revisions and snapshots

Each published engine change advances a SQLite-backed revision. Command responses and event subscriptions carry the revision. Zustand uses a single gate that accepts only strictly newer snapshots, including the initial read; an older command response cannot replace a newer subscription update. Revisions survive restarts. Event snapshots are coalesced over 16ms to reduce IPC bursts. Full snapshots include latest observations, per-task monitoring health, notification/reconciliation windows and up to 500 recent logs/runs. Inventory history is excluded (the deprecated inventory array is empty); a bounded descending keyset query returns history pages with a separate revision and request-generation gate. All current unknown attempts are included even outside the 500 recent-attempt window; delta synchronization and pagination for other histories remain technical debt.

## Recovery and uncertainty

Approval carts and checkout intents are durable. The checkout run UUID is the idempotency key, committed before submission. Cart approval, checkout intent, and terminal results each use transactional state/log/history writes. A lost response or interrupted checkout becomes `UNKNOWN_OUTCOME`; start/restart is blocked. Explicit reconciliation uses the original key/source/configuration scope, records attempts, validates freshness/version/evidence, and transactionally resolves only authoritative results. It cannot invoke submission. Pending, absence, errors, and changed simulator sources remain blocked. See [reconciliation](ORDER_RECONCILIATION.md). Configured monitoring can restart automatically with a new run ID. Saved approvals are restored but never submitted automatically. Missing optional adapters preserve saved approvals without preventing app startup; the task can be cancelled or the adapter restored on a subsequent launch.

## Diagnostics, credentials and simulator durability

The existing engine counters are exposed through safe diagnostic IPC, with bounded recent error codes and a 256-sample observation-to-persistence latency window. SQLite quick-check/foreign-key/WAL health is cached for 30 seconds, and runs only in the worker. The renderer polls availability every five seconds; Settings refreshes full diagnostics. Diagnostics omit credentials and profile data.

Credential replacement preserves unrelated ciphertext instead of rewriting all decrypted entries. Deletion can remove a scoped encrypted entry even when OS decryption is unavailable; it stops retailer watches/discovery, clears worker memory, and retains public configuration. Rotation/deletion never grants automatic restart. Credential status distinguishes available/missing/inaccessible entries and encryption failure. Separate credential-file/SQLite commits still require compensating restoration and can require token re-entry after a crash.

The simulator CLI owns a separate SQLite/WAL database with durable source identity, carts, orders, idempotency keys and delayed-completion due times. Startup reschedules pending completion timers; order-status GET never inserts/submits/completes orders. Inventory values/sequences persist, while the inventory stream changes per launch independently of durable order source identity. The service refuses foreign/future schemas; its database must never be the desktop file. Programmatic tests can explicitly use ephemeral storage. See [simulator operations](docs/SIMULATOR.md).

## Build and scope

pnpm workspaces retain source-level domain boundaries. Vite builds the renderer; esbuild bundles main, preload, and backend worker separately. No WASM runtime asset or native addon rebuild is required. The development CLI requires Node 24.15+; Electron's locked runtime is checked through actual desktop tests. Validation used local services only and made no real retailer requests or purchases. Authorized Shopify inventory access requires explicit configuration; real purchasing remains prohibited by both registry and workflow admission.
