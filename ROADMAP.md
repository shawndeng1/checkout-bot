# Roadmap

## Completed: Milestone 2 architecture and reliability

- Single backend worker owns native incremental SQLite with WAL and v1-compatible migrations/backups.
- Operation-level concurrency, approval release/requeue, cancellation, duplicate approval prevention.
- Shared inventory subscriptions, normalized observations, retailer rate policies, stale-event suppression.
- Typed SDK and adapter registration, deterministic mock and loopback HTTP simulator.
- Revisioned snapshot synchronization and conservative intent/approval/restart recovery.
- Unit/integration/desktop tests and recorded 10/50/100-task backend benchmarks.

## Recommended Milestone 3: Reconciliation and distribution reliability

- Build a simulator order-status/reconciliation API and explicit UI resolution for UNKNOWN_OUTCOME, with tests proving that reconciliation cannot submit another order.
- Exercise crash/kill points before/after each lifecycle commit and HTTP submission; add disk-full, power-loss, backup/restore and corruption tests.
- Package and sign installers, pin supported Electron/Node runtimes, and run launch/migration tests on Windows and Linux CI.
- Add worker health/status UI, startup deadlines, recovery diagnostics, and log export without sensitive data.
- Replace full snapshots with revisioned incremental events plus paginated history for larger workspaces.
- Add first-class profile/proxy group management and improved screen/form modularity, keyboard focus handling, and accessibility audits.
- Expand benchmark sampling, process isolation, resource profiling and regression baselines.

## Later: Authorized integration development

- Versioned adapter contracts, stronger conformance tests and plugin discovery.
- OS keychain-backed authentication only if an explicitly scoped integration requires it.
- Evaluate documented official retailer inventory APIs only with explicit authorization.
- Any future purchasing requires an explicit user scope, clear approval UX, idempotency, order reconciliation, and a security review.

No real retailer integration, purchasing, access-control circumvention, or anti-bot bypass is included in the current application.
