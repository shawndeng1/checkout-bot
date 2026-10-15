# Architecture

## Components and boundaries

```text
React screens → Zustand snapshot store → window.retail preload API
                                            ↓ validated IPC
                                  Electron command service
                                            ↓
                                    Engine + SQLite Store
                                            ↓
                                  RetailerAdapter → MockAdapter
```

The renderer has no Node.js access. It receives sanitized domain snapshots through exactly three preload methods: `snapshot`, `command`, and `subscribe`. Unsubscribe removes only the listener it registered. The main process verifies the sender window, top-level frame, and trusted renderer URL before every request. Zod validates strict command unions, entity fields, UUIDs, and numeric bounds. Inputs cannot select a channel, file path, SQL statement, or shell command.

Context isolation, renderer sandboxing, disabled Node integration, disabled webviews/popups/navigation, denied permission requests, and a content security policy restrict the renderer. Development trusts only the fixed loopback Vite URL; production loads local bundled assets. The development-only Vite HTML transform permits inline scripts for React Refresh; the production policy permits only bundled scripts. No external sites load in the window. This follows Electron's security recommendations: https://www.electronjs.org/docs/latest/tutorial/security/.

The core engine is independent of Electron and React. Tests construct it with the SQLite store and an adapter factory. Each run gets its own adapter instance, AbortController, and UUID. A process-local active map and FIFO queue prevent duplicate execution. Electron's single-instance lock prevents a second normal desktop process from running the same workspace. The store assumes a single writer; direct multiple-store writes to the same path are unsupported.

State transitions emit full snapshots. For this milestone, full snapshots make renderer reconnection simple and avoid event ordering/patch bugs. The UI subscribes before requesting initial data; IPC responses and events use the same schema. Future work should introduce revisioned incremental events and pagination for large workspaces.

## Persistence choice

SQL.js runs actual SQLite compiled to WASM. It avoids native addon rebuilds across Electron ABIs and OSes. The main process owns an in-memory SQLite connection and atomically exports it to a mode-0600 temporary file followed by rename. Lifecycle changes use SQL transactions to persist task state, event, and terminal run outcome together. After each export, foreign-key enforcement is restored because SQL.js reopens its connection.

This is suited to the first local milestone. Exporting the complete database synchronously has a scaling cost. A future persistence worker/native SQLite implementation should add incremental writes, WAL, backup rotation, and power-loss durability testing. Atomic rename protects against an interrupted process replacing the database with a partial file; this implementation does not fsync for power-loss guarantees.

## Workspaces and build

pnpm registers desktop and each domain package as a workspace. Dependencies are centralized at the root; source imports cross package boundaries directly, and esbuild bundles the main process to CommonJS. Vite bundles React; esbuild creates a sandbox-compatible preload with Electron externalized. The SQLite WASM file is copied beside the main bundle. Libraries can gain independent builds and public package exports when external consumers exist.

## UI

Original dark Orbit branding, sidebar navigation, dashboard counters and seven-day execution chart, task groups, table/bulk actions, live logs, profile/proxy forms, settings, and error notices. The app starts empty rather than inserting synthetic persisted tasks or statistics. All observed counts and chart values come from stored data. Completion notifications are in-app notices, not OS notifications.
