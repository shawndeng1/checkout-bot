# Orbit Milestone 2 — Completion and validation

Implemented in the existing `shawndeng1/checkout-bot` repository, preserving the Electron/React application and existing workflows. Validation executed on macOS with Node 24.19.0 and Electron 41.10.7. No real retailer integration or purchasing was added.

## Implemented changes

- Native incremental SQLite/WAL in a single backend worker; the main process owns only the window and asynchronous transport.
- Operation-level capacity, bounded queues, approval slot release/requeue, duplicate approval protection, cancellation, and shared retailer cooldowns.
- Product/variant-keyed compatible monitoring subscriptions with event fan-out, per-subscriber cancellation, reference-counted cleanup, source sequence/timestamp/ID suppression, and source restart handling.
- Typed SDK capabilities, products, inventory, carts, checkout results, authentication declarations, errors and rate limits; adapter registration outside engine control flow.
- A loopback-only HTTP simulator with catalog/variants, inventory controls, simulated carts/orders, idempotency keys, latency/failure/429 controls, and lost-response simulation.
- Persisted snapshot revisions and one Zustand acceptance gate for reads, events and command responses.
- Durable approval carts, checkout intents/results, differentiated restart recovery, configured monitoring resume, and blocked UNKNOWN_OUTCOME tasks.
- Existing UI forms now support registered retailers, optional variants, and monitoring-recovery settings. Existing task/profile/proxy/dashboard behavior remains covered.

## Architecture and tradeoffs

The bundled `node:sqlite` API avoids native addon rebuilds and reads the existing file directly. Its synchronous API runs exclusively in the backend worker. WAL/FULL commits trade write latency for durability. Node 24.15+ is the development/runtime requirement; the API's release-candidate status is an explicit compatibility consideration. Electron runtime support was verified by launching the actual application.

Task lifetimes no longer own global permits. Requests acquire FIFO capacity only while executing; approval and rate-policy waits release it. Conservative sharing includes identity, timing, retry and adapter scope, so compatible tasks can share without assuming that every account or proxy has the same inventory view. The simulator's order keys model idempotency, but an unknown result never grants permission for automatic resubmission.

See [ARCHITECTURE.md](../ARCHITECTURE.md), [TASK_ENGINE.md](../TASK_ENGINE.md), and the [driver decision](decisions/002-sqlite-owner.md).

## Database migration strategy

Schema v1 is retained and read directly. SQLite's online backup API writes a one-time, atomically renamed `retail.sqlite.v1.bak` before migration. Schema v2 adds approvals, checkout attempts and revision metadata; no user records are dropped or rewritten. Transactions enforce all-or-nothing lifecycle writes. Foreign keys remain enabled and deletion cascades retain their original behavior. Missing new configuration fields receive read-time defaults. A failed migration rolls back, newer schema versions are rejected, and automatic restore never overwrites data.

Migration tests create an actual SQL.js v1 file with groups, tasks, profiles, proxies, settings, runs and logs, then verify that all survive the native-driver upgrade. See [DATABASE.md](../DATABASE.md).

## Executed validation

| Command                                         | Result                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Baseline `pnpm test`, before modifications      | 20 tests passed                                            |
| Final `pnpm typecheck`                          | Passed                                                     |
| Final `pnpm test`                               | 51 tests passed across 6 files                             |
| `pnpm build` (also executed by `pnpm test:e2e`) | Passed                                                     |
| Final `pnpm test:e2e`                           | 5 Electron scenarios passed                                |
| `pnpm format:check`                             | Passed                                                     |
| `pnpm benchmark`                                | Completed 10, 50 and 100-task cases; measurements recorded |

The original core suite remains, with concurrency expectations updated to operation rather than task capacity. New tests cover approval release/requeue, duplicate approvals, queued cancellation, queue saturation, shared monitoring at 10/50/100 tasks, stale/duplicate fan-out, source retirement, pacing/Retry-After, debug logging, optional-adapter recovery, retailer mutation guards, migration preservation/rollback, write failures, worker RPC failure, abrupt worker exit with a committed checkout intent, restart classification, and stale snapshot responses.

GUI scenarios verify original CRUD/logs/restart persistence; profiles/proxies/settings; development-mode startup and the narrow preload API; three approvals with concurrency one surviving a full restart; and a registered HTTP variant task created and completed through the existing UI.

## Performance measurements

The measured table and raw data are in [benchmarks/MILESTONE_2.md](benchmarks/MILESTONE_2.md) and [benchmarks/milestone-2.json](benchmarks/milestone-2.json). The runner measures steady monitoring CPU, process RSS, worker heap, persisted stock-event latency, and cart/approval readiness. Each case asserts one shared subscription, the expected subscriber count, cleanup, bounded capacity, and zero orders.

These are backend-plus-simulator measurements, not complete Electron resource usage. Cases run sequentially in one parent process, each with a fresh worker/service; parent allocator/JIT retention can affect RSS. A single sample per scale does not establish a regression baseline or a speedup over Milestone 1.

## Known limitations and technical debt

- Runtime/GUI tests and measurements were executed on macOS only; Windows/Linux CI and signed installer verification remain.
- The simulator, its catalog, carts, and idempotency records are in memory and reset on restart. It is a development service, not durable order infrastructure.
- UNKNOWN_OUTCOME is deliberately blocked. There is no reconciliation/status-query API or UI to resolve it yet.
- Full snapshots remain; their 16ms coalescing and 500-log/run limits do not replace pagination or incremental events. Bounded in-memory event caches are not a distributed inventory consistency protocol.
- Store ownership assumes the desktop single-instance model and one backend connection. External writer tools/multiple independent application processes are unsupported.
- SQL statement failures, read-only writes, failed migrations, and abrupt worker exit were tested. Physical disk exhaustion, power loss, backup corruption, network filesystems, and forced shutdown at every possible commit boundary were not tested.
- Node's bundled SQLite compatibility still needs platform-matrix coverage. No automatic backup restore or corruption repair is provided.
- Profile/proxy groups remain named labels. Authentication contracts have no credential/login implementation. Proxy routing is not used by simulated tasks. Full UI accessibility/focus management and feature-module extraction remain.
- Builds emit non-failing Rollup warnings about annotation placement in Zod; no build errors remain.

## Recommended next milestone

Add an explicit simulator order-status/reconciliation workflow and safe UI resolution for unknown outcomes, followed by fault-injection/durability tests, worker health diagnostics, and signed cross-platform distribution with CI. Establish isolated multi-sample performance baselines and paginated/delta synchronization before increasing workload limits. Continue to exclude real retailer integrations and purchasing until explicitly scoped.
