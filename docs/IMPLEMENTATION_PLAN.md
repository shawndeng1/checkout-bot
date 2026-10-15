# Milestone 1 implementation plan (historical)

1. Inspect the existing repository and available runtime; initialize the empty pnpm workspace.
2. Define shared domain schemas, validated commands, and retailer capabilities.
3. Implement versioned SQLite persistence and restart recovery.
4. Implement the UI-independent state machine, concurrency queue, cancellation, retries, and mock adapter.
5. Build the secure Electron shell and dark React dashboard, tasks, profiles, proxies, and settings screens.
6. Publish persisted live task snapshots to Zustand and expose execution logs.
7. Run core/database tests, type checks, production build, and real Electron Playwright scenarios; repair failures.
8. Document architecture, data model, lifecycle, limitations, and the next reliability milestone.

The first milestone deliberately has no live retailer integration. SQL.js avoids native Electron addon rebuilds; transactions and atomic exports preserve local data. Profile/proxy group names are configuration labels. The main process owns execution and persistence; a worker process is a future scaling step.

Milestone 2 replaces the original persistence and scheduling choices; see [MILESTONE_2.md](MILESTONE_2.md) for the current implementation and validation.
