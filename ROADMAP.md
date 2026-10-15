# Roadmap

## Milestone 2 — Desktop reliability and distribution

- Split screens/forms into focused feature modules; add keyboard modal focus management and accessibility audits.
- Move persistence and execution into a worker/utility process with revisioned events and paginated history.
- Incremental SQLite writes, backup/restore, fsync durability, corruption handling, and transactional fault-injection tests.
- First-class profile/proxy group management, search/filtering, and import/export of non-sensitive configurations.
- Signed installers, automatic updates, CI validation on macOS/Windows/Linux, and clean install/upgrade tests.
- Expand GUI coverage for bulk actions, concurrency changes, notifications, and interruption recovery.

## Milestone 3 — Adapter development tools

- Deterministic scripted inventory events and virtual clock tooling.
- Adapter capability negotiation, schema-defined configuration, contract tests, and execution metrics.
- Permission-aware adapter discovery and packaging.
- Secure OS keychain integration only if future authorized integrations require credentials.

## Later — Authorized integrations

Evaluate documented official retailer APIs and permitted inventory integrations only after explicit scoping. No real purchasing, security bypasses, CAPTCHA circumvention, proxy rotation, or anti-bot evasion exists in this milestone. Any future checkout requires explicit authorization, clear approval UX, and idempotency/reconciliation design before execution.
