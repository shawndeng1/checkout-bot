# Roadmap

## Completed: Milestone 3 inventory and reconciliation

- Preserved Electron/React application, single worker, SQLite WAL, scheduler and existing workflows.
- Continuous inventory-only/notification workflows, normalized observation history, deduplicated in-app and optional native notices.
- Independent SDK capabilities, optional purchasing methods, runtime registration/configuration validation.
- Read-only simulator status lookup, lost/delayed results, durable reconciliation history, authoritative transactional resolution and desktop UI.
- Shopify Storefront inventory-only adapter and functional loopback contract fixture; generic settings and OS-encrypted credentials.
- v1/v2-compatible schema v3 migration/backups, crash/cancellation/write-failure and desktop coverage.

Milestone 2 architecture, validation, and measured benchmarks remain in [docs/MILESTONE_2.md](docs/MILESTONE_2.md).

## Recommended Milestone 4: Authorized inventory pilot and distribution reliability

- Activate a developer-controlled Shopify store with explicit authorization; run the contract suite against published test products and real token/permission/revocation behavior.
- Exercise OS-keychain lock/unlock, token rotation/deletion, native notification permissions, and signed installer migration on macOS, Windows and Linux CI.
- Add a product/variant lookup browser, paginated observation/reconciliation history and sensitive-data-free diagnostics/export.
- Persist simulator orders/source identity for durable service-restart reconciliation; keep absence and inconclusive evidence blocked.
- Expand crash/kill points around database/credential commits and submission/result persistence; add physical disk-full, power-loss and backup/restore validation.
- Add backend health/startup deadlines and recovery diagnostics; replace full snapshots with revisioned incremental updates.
- Measure longer continuous-monitoring workloads and resource regressions; retain bounded queues and per-retailer policies.

## Later, separately authorized scope

Versioned adapter conformance and discovery, webhook-based official inventory sources, and further authorized inventory platforms. Any future real purchasing would require a separate user scope, approval UX, durable idempotency, authoritative reconciliation, and security review. No real checkout, access-control circumvention, CAPTCHA bypass, or queue bypass is implemented.
