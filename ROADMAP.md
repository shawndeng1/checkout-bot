# Roadmap

## Implemented: Milestone 4 discovery and practical monitoring

- SDK-driven authorized search, lookup and variant selection with descriptions, images, availability and timestamps.
- Shopify Storefront 2026-07 discovery, strict response/version validation, rate policy, timeouts and cancellation; fixture-backed validation and a gated live pilot suite.
- Filterable inventory view, product/variant details, durable last check/error and paginated change history outside snapshots.
- Durable simulator carts, orders/idempotency, pending completion and restart-safe reconciliation.
- Worker/database diagnostics and bounded error/latency reporting; scoped credential rotation/deletion and fail-closed OS encryption.
- Repeated isolated 10/50/100-task measurements and macOS/Windows/Linux CI preparation.

Historical milestone reports remain in docs. Live Shopify pilot status is **NOT EXECUTED** until an authorized developer-store setup is supplied and tested. Remote CI configuration is not evidence of platform success; see [Milestone 4 results](docs/MILESTONE_4.md).

## Recommended Milestone 5: Verified inventory pilot and operational hardening

- Run the documented developer-store pilot and record actual API authorization, publication, variant, stock-change, cancellation, notification and recovery results.
- Verify real OS-keychain lock/unlock/rotation/deletion and native notification permissions on supported systems; address failures from the CI matrix.
- Add an offline product index, saved searches, revisioned current-state deltas, pagination/export for other histories and multi-account integration scope.
- Add explicit worker recovery controls and health UI, monitoring soak tests, backup/restore and physical disk-full/corruption fault tests.
- Improve simulator backup/restore and order archival; keep missing/inconclusive order evidence blocked.
- Package and sign installers when distribution is authorized.

Any real purchasing would require a separate scope, user approval design, durable idempotency and authoritative reconciliation review. No real checkout, scraping, CAPTCHA bypass, queue bypass or access-control circumvention is implemented.
