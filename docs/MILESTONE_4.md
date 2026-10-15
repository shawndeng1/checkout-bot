# Orbit Milestone 4 completion report

Date: 2026-10-15. The existing Electron/React application, backend worker, native SQLite, SDK, scheduler and checkout simulation are extended in place. No real purchasing or security-bypass functionality is added.

## Audit and implementation plan

Read the architecture, schema, lifecycle, inventory, reconciliation, integration and Milestone 3 documentation; inspected worker/client/preload/main, Shopify/SDK/fixture, credential vault, simulator, renderer and tests. Baseline validation executed successfully: 86 unit/integration tests, seven Electron scenarios, typecheck, production build and formatting.

The audit confirmed that history was a 500-row snapshot window, lookup was SDK-only, credential status was a boolean, and worker failure exited the app. It also found that replacing the whole decrypted credential map after an unsuccessful load could discard unrelated encrypted entries. These gaps are now addressed. Historical Milestone 3 reports remain unchanged as historical records.

The plan was to add optional SDK search and richer validated product data; use cancellable discovery and paginated history RPCs; persist simulator orders independently; expose safe worker/database health and scoped credential management; then deliver desktop discovery, pilot instructions/tests, cross-platform CI and repeated isolated benchmarks.

## Implemented changes

- Discover supports registered-retailer search and direct handle/ID lookup, cursor pages, descriptions, optional HTTPS images, variant attributes/availability, observation timestamps, cancellation and missing/invalid-credential states. Selecting a variant creates an inventory-only task in an existing or new retailer group. Adapters without discovery retain direct identifier entry.
- Shopify remains pinned to documented Storefront API `2026-07`. Product-only search includes unavailable results; full lookup pages variants. Runtime validation bounds responses, checks product/page identity and API-version drift, normalizes rate/permission failures, and enforces cancellation/timeouts. No Admin API, cart, checkout or real order methods exist.
- Inventory shows product/variant details, current availability/freshness, last successful check, last classified error, name/identifier search, active/availability filters, and paginated change history. Latest state remains revision-gated; history is a separate bounded query and never rides in snapshots. Notification messages use public product/variant names where available.
- Simulator carts, orders/idempotency keys, source identity, inventory values/sequences and delayed completion due times persist in a separate native SQLite database. Pending timers resume after restart. Inventory uses a fresh stream independently of stable order identity. Read-only status lookup cannot submit; missing evidence remains unresolved. Foreign/future databases are rejected.
- Settings diagnostics expose availability, active/queued work, shared subscriptions, polling, bounded error classes, database checks and observation-to-persistence latency. Worker exit/unresponsiveness leaves the UI usable for diagnostics and blocks new operations; health RPC/startup/shutdown/request deadlines bound waits.
- Credential rotation/deletion suspends retailer work. Scoped ciphertext updates preserve unrelated entries; deletion works without decrypting the removed entry. Status distinguishes available, missing and inaccessible credentials and reports OS encryption failure. No plaintext fallback or old-token renderer read exists.
- A live pilot suite and exact setup procedure are provided, gated by explicit authorization/configuration. GitHub Actions includes macOS, Windows and Ubuntu unit/build/format validation and Electron GUI runs, with Xvfb/dependencies on Linux. Live credentials are not part of CI.

## Architecture and migrations

The desktop worker remains the only owner of `retail.sqlite`; SQL and integrity checks never run in Electron main. Product discovery uses existing scheduler gates and AbortSignals, with at most 20 discovery contexts and two bounded retries. Mutation RPCs stay serialized while discovery/cancel/history/diagnostics can proceed independently. The transport caps pending requests at 256. History uses descending keyset SQL pages (20 by default, 100 maximum); React guards query generations without applying query results as snapshots.

Schema **v4** adds `monitoring_health`, with a task foreign key, last-success time and last classified error. Existing latest-observation receipt times are backfilled; prior history and checkout/approval/reconciliation records are retained. Existing v1/v2/v3 files receive versioned online backups before additive migrations. Initial-per-run, availability and quantity changes create history rows; unchanged reads update latest/success state. Existing v3 history is still queryable.

The simulator CLI defaults to `.orbit-simulator/state.sqlite`, independently versioned at 1, with WAL/FULL writes, foreign keys, unique order keys and exclusive ownership. `ORBIT_SIMULATOR_DB` selects a separate path; programmatic tests can choose ephemeral storage. Simulator source identity and pending orders survive process restart; control credentials rotate and are not stored. The simulator database is never the desktop database.

Credential persistence remains a separate OS-encrypted file. Replacement suspends work, validates configuration/token presence, checkpoints ciphertext and compensates if the worker/configuration write fails. Saving a token does not claim successful API authentication; that is checked by discovery/monitoring and the separately gated pilot. SQLite and the credential file are not a distributed transaction; a process crash between them may require token re-entry. Inaccessible credentials do not auto-resume monitoring. Native notifications remain OS-dependent, best effort after durable in-app notice commit.

## Executed validation

Baseline: 86 tests and seven Electron scenarios passed. The final local commands executed on macOS are recorded below. `pnpm test:pilot` was also executed without live enablement and reported four skipped cases, with zero live test executions.

| Command             | Final result                     |
| ------------------- | -------------------------------- |
| `pnpm typecheck`    | Passed                           |
| `pnpm test`         | 105 passed; 4 live cases skipped |
| `pnpm test:e2e`     | 8 passed                         |
| `pnpm build`        | Passed                           |
| `pnpm format:check` | Passed                           |
| `git diff --check`  | Passed                           |

New coverage includes product search/pages, empty and malformed responses, attributes/images, variant pagination, timeout/cancellation, version drift, rate errors, history pages during new writes, durable health, v3 migration/backfill, scoped credential rotation/deletion while locked, worker exit/unresponsiveness and simulator SIGKILL recovery. Desktop tests exercise discovery cancellation, product/variant selection, watch creation, history next/previous pages, diagnostics and credential deletion while preserving existing seven workflows. Screenshots were visually inspected. Tests use temporary application databases; actual user data is not modified.

## Performance

The final harness runs **three isolated trials at each of 10, 50 and 100 continuous simulated tasks** (nine trial processes). Each scale shares one subscription and verifies zero orders. It records 30/150/300 correlated task-event latency samples and three CPU windows per scale. [PERFORMANCE.md](../PERFORMANCE.md) and [raw measurements](benchmarks/milestone-4.json) contain measured p50/p95, CPU, RSS/heap, runtime/hardware and methodology.

An initial same-parent run revealed retained RSS across trials; the committed measurements use fresh child processes instead. The steady CPU window is two seconds after 500 ms warmup; RSS includes the trial process/worker/simulator, not the orchestrator. Log-timestamp latency is distinct from end-to-end snapshot readiness. Small samples, shared fan-out correlation and polling phase prevent production performance or controlled regression claims. GUI rendering and durable simulator disk throughput are not benchmarked by this in-memory simulator workload.

## Live pilot and cross-platform status

**Authorized live Shopify pilot: NOT EXECUTED, pending developer-store configuration and credentials.** Four gated live cases remain skipped without explicit enablement. The suite performs only authorized reads, asks the enabled operator to change test stock manually, verifies notification/history/restart/cancellation, and never makes inventory mutations or orders. Real throttle evidence is observational and skipped unless naturally encountered; no traffic flooding is used. Native notification presentation is a separate manual acceptance step. See [SHOPIFY_PILOT.md](../SHOPIFY_PILOT.md).

Local validation runs on macOS with Node 24.19.0, Electron 41.10.7 and pnpm 11.25.0. [GitHub Actions run 38800486587](https://github.com/shawndeng1/checkout-bot/actions/runs/38800486587) passed on tested commit `1690898` on all three platforms:

| Runner         | Unit/integration           | Electron GUI      | Typecheck / build / format |
| -------------- | -------------------------- | ----------------- | -------------------------- |
| macos-latest   | 105 passed; 4 live skipped | 8 passed (49.3 s) | Passed                     |
| windows-latest | 105 passed; 4 live skipped | 8 passed (29.2 s) | Passed                     |
| ubuntu-24.04   | 105 passed; 4 live skipped | 8 passed (23.0 s) | Passed                     |

The initial run passed on macOS/Linux but failed Windows formatting because checkout converted files to CRLF. A repository `.gitattributes` rule now preserves LF text checkouts; the full rerun above passed, including Windows GUI tests. Linux uses Xvfb and runner-specific user namespace setup; the application sandbox remains enabled. Actual keyring lock/unlock and native notification permissions are not asserted by mocked encryption-provider tests or fixture GUI tests. The subsequent documentation-only delivery commit records these results without changing the tested application.

## Delivery commits

- `d965266`: persistent simulator orders, idempotency and delayed completion.
- `d0f0478`: product discovery, inventory history, diagnostics and credential lifecycle.
- `7d8ea22`: cross-platform CI, gated live pilot and isolated benchmarks.
- `5bd797b`: milestone documentation and measured results.
- `1690898`: LF checkout policy; tested by the successful three-platform run above.

These commits were pushed to `origin/main`. The working tree was clean before recording these final CI results.

## Limitations and next milestone

- Live Shopify access, real throttling and OS-native credential/notification behavior require the documented authorized pilot. No account or credentials were created/requested during this task.
- Storefront availability is sellability, not warehouse quantity. Search has Shopify's own limits; variant lookup is capped at 2,000 variants and uses paced pages within one scheduled operation. The fixture is a supported-contract subset, not the whole Shopify platform.
- Inventory history is bounded at 10,000 rows; other histories still use recent snapshot windows. Product details are refreshed through discovery/monitoring rather than an indexed offline catalog. Full snapshots of current state remain; pagination/deltas for other histories and multi-account profiles are future work.
- Worker recovery after exit is explicit application restart; backend RPC/health timeouts are diagnostics, not permission to resubmit any operation. Credential-file/SQLite atomicity is limited as described above.
- Simulator persistence is a single-owner development service. Physical power-loss/corruption repair, large durable-order throughput, multi-server operation and real reconciliation are not validated. Missing source/key evidence remains unknown.
- Signed installers are outside this milestone. Hosted-runner success does not establish compatibility with every supported OS version or native credential/notification provider.

Recommended Milestone 5: execute the authorized developer-store pilot; verify cross-platform OS-keychain/native delivery; add revisioned deltas and other history pagination, worker recovery controls, durable backup/restore tests and a longer monitoring soak. Continue to exclude real purchasing and access-control bypass.

Usage: [discovery](../PRODUCT_DISCOVERY.md), [pilot](../SHOPIFY_PILOT.md), [inventory](../INVENTORY_MONITORING.md), [reconciliation](../ORDER_RECONCILIATION.md), [architecture](../ARCHITECTURE.md), [database](../DATABASE.md), [integration guide](../RETAILER_INTEGRATION_GUIDE.md).
