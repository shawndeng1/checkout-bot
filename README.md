# Orbit — Retail Automation Workspace

A working Electron desktop application through Milestone 2 for managing simulated retail workflows. Independent implementation with original branding. All inventory, carts, and checkouts run through the deterministic mock adapter or the loopback HTTP simulator; no retailer traffic or purchases occur.

## Requirements

- Node.js 24.15+ (Node 24 LTS recommended)
- pnpm 11.25 (`npm install -g pnpm@11.25.0`)
- macOS, Windows, or Linux desktop environment

## Run

```sh
pnpm install
pnpm dev
```

The development command builds the main process, preload, and backend worker, starts Vite on `127.0.0.1:5173`, and launches Electron. Renderer edits hot-reload. Restart the command after main-process or package changes.

```sh
pnpm build
pnpm start
```

This runs the bundled production renderer without a development server. Distribution installers and signing are future work.

## First workflow

1. Open **Tasks**, click the **+** beside Task groups, and save a group.
2. Click **New task**, enter a name and product identifier, choose the group, and save.
3. Start the task using its play button. The default scenario reports stock on the third inventory check.
4. Click **Approve** when the simulated cart is ready. The task completes without a real purchase.
5. Open the terminal icon to see structured execution logs. Use checkboxes for bulk start, stop, restart, and delete.

Profiles accept shipping/contact details and `mock_` payment placeholders only. Proxies accept HTTP/SOCKS5 host and port configurations, without credentials. Profile/proxy groups are named in their forms and shown in the lists. Assign these configurations through the task form. The mock adapter does not use proxy routing or profile data.

Settings control concurrency (1–20), startup view, in-app completion notices, and inventory log detail. Approval waits release execution capacity. Approval resumes through a bounded queue; duplicate approvals cannot submit twice. Lowering concurrency does not interrupt active operations. The resume-monitoring preference only resumes inventory checks; checkout is never retried automatically.

## Validation

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
```

Vitest exercises scheduling, shared inventory, the HTTP simulator, snapshot ordering, migrations, write failures, and worker recovery with isolated temporary directories and deterministic clocks. Tests that bind localhost require local network/listening permission. Playwright launches Electron directly; no separate browser download is required. GUI access is required; on headless Linux use `xvfb-run pnpm test:e2e`. Tests use a temporary data directory and do not change your workspace data. Screenshots/traces are written to `test-results/`.

## Data and security

The database is `retail.sqlite` in Electron's per-user application data directory. `RETAIL_DATA_DIR` overrides the directory for tests or isolated development. One application instance owns the database. The worker is the only database owner and uses incremental native SQLite WAL writes. A v1 database is backed up once as `retail.sqlite.v1.bak` before schema migration. Monitoring may resume when configured; saved approvals require approval again. Interrupted checkout becomes `UNKNOWN_OUTCOME` and start/restart remains blocked until future reconciliation tooling resolves it. Configuration, run history, and logs survive restart.

No card, password, or authentication-token fields exist. Placeholder payment tokens must start with `mock_`. Contact data is local and not encrypted at rest; protect the operating-system account. Logs retain the latest 10,000 events; snapshots expose the latest 500 logs and runs.

## Repository

- `apps/desktop`: React/Zustand/Tailwind renderer, secure Electron main process and preload
- `packages/shared-types`: domain types, strict Zod schemas, narrow IPC contract
- `packages/database`: versioned SQLite migrations and incremental native SQLite persistence
- `packages/core`: task state machine, operation scheduler, shared inventory subscriptions, cancellation, retry and command service
- `packages/retailer-sdk`: adapter interface and abortable delay/error primitives
- `packages/adapters`: registry composition, deterministic mock retailer, and loopback HTTP adapter
- `packages/simulator`: localhost catalog/inventory/cart/idempotent checkout service
- `packages/ui`: reusable buttons, status badges, empty states
- `tests`: engine/database integration and Electron end-to-end tests
- `scripts`: development and production bundling
- `docs`: validation record and implementation notes

Milestone 2 validation and limitations are recorded in [docs/MILESTONE_2.md](docs/MILESTONE_2.md). [docs/VALIDATION.md](docs/VALIDATION.md) is the historical Milestone 1 record.

## HTTP simulation and benchmarks

```sh
pnpm simulator
# In another terminal, point the desktop at the loopback service:
ORBIT_SIMULATOR_URL=http://127.0.0.1:4318 pnpm dev
pnpm benchmark
```

The HTTP retailer appears in the group form only when registered through `ORBIT_SIMULATOR_URL`. Its catalog includes `SKU-42`, with an available `blue` variant. Enter `blue` in the optional variant field to exercise it. The default variant starts out of stock and can be changed with the authenticated local control API. See [simulator instructions](docs/SIMULATOR.md) and [measured backend benchmarks](docs/benchmarks/MILESTONE_2.md). The service and adapters never make real retailer requests or purchases.

See [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md), [TASK_ENGINE.md](TASK_ENGINE.md), and [ROADMAP.md](ROADMAP.md).
