# Orbit Milestone 3 completion report

Date: 2026-10-15. Work continues from Milestone 2 in the existing Electron/React repository; no application rewrite or database replacement.

## Audit and implementation plan

Before changes, reviewed the architecture, lifecycle, database, simulator and validation documentation; inspected core engine/inventory/scheduler, database/migrations, SDK/adapters, worker transport, renderer store, and existing tests. The baseline `pnpm test` executed successfully: **51 tests**.

The implementation plan was to preserve existing defaults, add independent inventory workflows/history/notifications, introduce read-only simulated reconciliation with transactional evidence, add an officially documented inventory adapter with a fixture fallback and secure configuration, then validate recovery, UI and migration behavior.

## Implemented changes

- Explicit `MONITOR_ONLY`, `MONITOR_AND_NOTIFY`, and backwards-compatible `MONITOR_AND_CHECKOUT` configurations. Continuous tasks stay subscribed after stock detection, observe variants independently, respect retailer pacing and retries, and never require cart/checkout methods.
- Runtime-validated observations with expiry, existing shared-subscription fan-out and cancellation, latest-observation storage, bounded history and duplicate-suppressed in-app/native notice events from one pipeline. Inventory UI shows watches, freshness, start/stop, history and notifications.
- SDK product/variant lookup, independent capabilities, optional operation methods, typed order evidence, runtime factory validation and per-retailer Zod schemas/generic UI descriptors. A product-lookup-only factory is also tested; monitoring task admission still requires inventory.
- Simulator read-only status lookup by original idempotency key, authoritative success/failure, pending/unresolved status, dropped responses, independent delayed completion, invalid/stale evidence controls, and conservative simulator-restart behavior.
- Explicit engine reconciliation, coalesced duplicate lookups, bounded/cancellable scheduling, persisted attempts/history and transactional resolution. Original source/configuration/key identity, timestamps and monotonic versions are checked before an unknown attempt can resolve. Reconciliation cannot call submission. UI shows the original attempt/product, timestamps, result and history and permits retrying status checks.
- Shopify Storefront `2026-07` inventory-only adapter: handle/GID lookup, paginated variants, availability, strict endpoint authorization configuration, normalized errors, throttling and cancellation. Functional localhost fixture uses the documented query contract and cannot proxy real traffic or submit orders.
- OS-encrypted Storefront credentials outside SQLite, narrow sender-validated configuration IPC, no renderer filesystem/shell access, and no plaintext fallback. Configuration and secret validation precede persistence; inaccessible credentials pause restart recovery safely.
- Crash/worker termination, interrupted results/lookups, missing adapters, expired events, database rollback, legacy migration, and UI coverage. Existing task/profile/proxy/approval workflows and revision gating remain operational.

## Architecture and tradeoffs

One backend worker still owns native SQLite, engine contexts, shared pollers and operation capacity. SQLite operations do not run in Electron main. Main owns windows, sender validation, encrypted credential persistence and optional native notification delivery. React uses the existing revision-gated Zustand store and narrow preload bridge. The new views are in `apps/desktop/src/operations.tsx`; the existing shell and CRUD forms are extended in place.

Inventory and checkout share the source pipeline but have different subscription lifetimes. Continuous monitoring uses `MONITORING ↔ STOCK_DETECTED`; checkout subscribers detach and retain the existing approval lifecycle. Registry policies restrict real adapters to non-purchasing capabilities. Adapter-specific configuration stays outside engine branching.

Reconciliation is evidence acquisition, not retry of purchase. It deliberately favors an unresolved outcome over guessing from absent/stale data. Simulator source identity is persisted with the cart/intent. Old Milestone 2 attempts without that identity cannot be resolved authoritatively by this new API.

Full revisioned snapshots remain. Current unknown attempts are included even outside the recent 500-attempt window, while histories remain recent windows. Shopify pagination runs inside one scheduled operation, with additional pages paced; large products can occupy capacity longer. OS encryption uses synchronous APIs supported by the installed Electron runtime, so keychain unlock can briefly block main. Native delivery is best effort after the durable notice commits.

## Migration strategy

Schema **v3** adds `inventory_events`, `latest_inventory`, `notices`, `reconciliations`, and `retailer_configs`, with foreign keys and task/attempt indexes. Existing domain JSON and the v1/v2 tables remain intact. Workflow and notification defaults are supplied on read; existing tasks continue simulated checkout. Existing v1/v2 files receive a one-time SQLite online backup named `.v1.bak`/`.v2.bak` before additive transactional migrations. Backups are not overwritten. WAL and foreign keys remain enabled.

Tests open an actual SQL.js v1 SQLite file and a native v2 file, check retained records/defaults, verify versioned backups, and reopen after writes. Inventory and reconciliation failure injection proves related state/history/log/notice writes roll back together. No user data directory was used by tests.

## Executed validation

Environment: macOS, Node **24.19.0**, Electron **41.10.7**, pnpm **11.25.0**. The bundled Node runtime was explicitly added to PATH because the shell's default Node is older than the project requirement.

| Validation           | Result                                             |
| -------------------- | -------------------------------------------------- |
| Baseline `pnpm test` | 51 passed                                          |
| `pnpm typecheck`     | Passed                                             |
| Final `pnpm test`    | 86 passed across 10 files                          |
| `pnpm build`         | Passed; renderer, main, preload and worker bundles |
| `pnpm test:e2e`      | 7 Electron scenarios passed                        |
| `pnpm format:check`  | Passed                                             |
| `git diff --check`   | Passed                                             |

The 35 additional unit/integration tests include shared continuous inventory at 10/50/100 tasks, notification dedup/preferences, expiry/stale handling, independent adapter capabilities, Shopify contract/error/rate/cancellation behavior, encrypted-vault failure handling, read-only reconciliation and duplicates, active/queued lookup cancellation, authoritative/invalid/stale/conflicting evidence, restart behavior, v2 migration, and abrupt monitoring-worker termination.

The seven desktop scenarios cover existing CRUD/events/logs/persistence, profiles/proxies/settings, development preload security, approval capacity/restart, HTTP variant checkout, Shopify fixture settings/continuous monitoring/notifications/restart, and reconciliation after a lost checkout response and application restart. Screenshots of Inventory and Reconciliation were inspected for layout. Artifacts are generated under ignored `test-results/`.

Build output contains non-fatal upstream Zod/Rollup annotation warnings; Electron tests also emit an environment color warning. No validation result is inferred from scaffolding or documentation. This milestone did not rerun or claim new CPU/memory benchmarks; 10/50/100 tasks here are correctness scenarios, and historical Milestone 2 measurements remain separately documented.

## Limitations and remaining debt

- No developer-controlled Shopify credentials were available; fixture behavior is validated, live Shopify access is not. Activation instructions and official references are in [RETAILER_INTEGRATION_GUIDE.md](../RETAILER_INTEGRATION_GUIDE.md).
- No real purchasing, real order reconciliation, scraping, CAPTCHA/queue bypass or access-control circumvention. The Shopify adapter has no cart/checkout/status submission methods.
- Simulator state and source identity are in memory. Its restart can leave an old checkout permanently unresolved; absence is deliberately not failure evidence. Legacy attempts missing verifiable source metadata also remain blocked. There is no unsafe manual-complete override.
- Unit tests inject an encryption provider; actual OS-keychain lock/unlock and native notification presentation were not exercised. Native delivery can be denied by the OS. Windows/Linux runtime/keyring/installer validation remains outstanding.
- Credential file and SQLite commits cannot be atomic together; a crash during configuration change can require token re-entry. Token replacement is supported; a dedicated deletion/rotation interface remains future work.
- History is bounded/recent and snapshots are full; pagination, complete reconciliation export, worker health UI, catalog browsing, webhook monitoring and multi-account configuration remain future work. Task forms accept product/variant identifiers directly.
- Shopify reports Storefront sellability, not exact warehouse inventory. Pagination is capped at 2,000 variants, and the fixture covers the query/response contract rather than all Shopify API behavior.
- Database failure tests inject errors/read-only failures; physical disk-full/power-loss/corruption behavior is not established. A persistent write failure during lookup can require restart to recover its durable `started` row.

## Recommended next milestone

Run an explicitly authorized Shopify developer-store pilot, add Windows/Linux CI and signed installers, verify real OS-keychain/native notification behavior, and build paginated product/history tools and durable simulator order storage. Expand fault-injection at commit boundaries while retaining the rule that inconclusive outcomes never trigger resubmission.

Usage and behavioral details: [README](../README.md), [inventory](../INVENTORY_MONITORING.md), [reconciliation](../ORDER_RECONCILIATION.md), [integration guide](../RETAILER_INTEGRATION_GUIDE.md), [architecture](../ARCHITECTURE.md), [database](../DATABASE.md), and [lifecycle](../TASK_ENGINE.md).
