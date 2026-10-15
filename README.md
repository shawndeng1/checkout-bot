# Orbit — Retail Automation Workspace

A working Electron desktop milestone for managing simulated retail workflows. Independent implementation with original branding. All inventory, carts, and checkouts run through the deterministic mock adapter; no retailer traffic or purchases occur.

## Requirements

- Node.js 22.12+ (Node 24 LTS recommended)
- pnpm 11.25 (`npm install -g pnpm@11.25.0`)
- macOS, Windows, or Linux desktop environment

## Run

```sh
pnpm install
pnpm dev
```

The development command builds the main process/preload, starts Vite on `127.0.0.1:5173`, and launches Electron. Renderer edits hot-reload. Restart the command after main-process or package changes.

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

Settings control concurrency (1–20), startup view, in-app completion notices, and inventory log detail. Approval waits count toward concurrency. Lowering the limit does not interrupt existing runs.

## Validation

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
```

Vitest exercises the engine and real SQLite file persistence with isolated temporary directories and deterministic clocks. Playwright launches Electron directly; no separate browser download is required. GUI access is required; on headless Linux use `xvfb-run pnpm test:e2e`. Tests use a temporary data directory and do not change your workspace data. Screenshots/traces are written to `test-results/`.

## Data and security

The database is `retail.sqlite` in Electron's per-user application data directory. `RETAIL_DATA_DIR` overrides the directory for tests or isolated development. One application instance owns the database. Interrupted active tasks become cancelled on restart and never resume automatically. Configuration, run history, and logs survive restart.

No card, password, or authentication-token fields exist. Placeholder payment tokens must start with `mock_`. Contact data is local and not encrypted at rest; protect the operating-system account. Logs retain the latest 10,000 events; snapshots expose the latest 500 logs and runs.

## Repository

- `apps/desktop`: React/Zustand/Tailwind renderer, secure Electron main process and preload
- `packages/shared-types`: domain types, strict Zod schemas, narrow IPC contract
- `packages/database`: versioned SQLite migrations and atomic local file persistence
- `packages/core`: task state machine, scheduler, cancellation, retry and command service
- `packages/retailer-sdk`: adapter interface and abortable delay/error primitives
- `packages/adapters/mock`: deterministic simulated retailer
- `packages/ui`: reusable buttons, status badges, empty states
- `tests`: engine/database integration and Electron end-to-end tests
- `scripts`: development and production bundling
- `docs`: validation record and implementation notes

The executed validation results are recorded in [docs/VALIDATION.md](docs/VALIDATION.md).

See [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md), [TASK_ENGINE.md](TASK_ENGINE.md), and [ROADMAP.md](ROADMAP.md).
