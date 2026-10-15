# Local HTTP simulator and adapter registry

Run `pnpm simulator` with Node 24.15+ to start a durable HTTP retailer on `127.0.0.1:4318`. The CLI prints its base URL and a temporary control token. `ORBIT_SIMULATOR_PORT` selects another port; port 0 chooses an ephemeral port. The service only binds loopback, rejects browser Origin headers, validates Host, bounds request body size, and requires its ephemeral token for administrative controls. It makes no outbound requests.

Public endpoints:

- `GET /catalog`: products and variants (demo product `SKU-42`, variants `default` and `blue`).
- `GET /inventory?productId=SKU-42&variantId=blue`: normalized availability observation.
- `GET /orders/status?idempotencyKey=<key>`: read-only completed/failed/pending/unresolved evidence; never submits an order.
- `POST /carts` with `{ "productId": "SKU-42", "variantId": "blue" }`: a simulated cart.
- `POST /checkout` with `{ "cartId": "...", "idempotencyKey": "..." }`: a simulated order. Repeating the same key/cart returns the same result; reusing the key for another cart returns 409.

Administrative endpoints require `Authorization: Bearer <printed-token>`:

- `POST /control/inventory`: `{ "productId": "SKU-42", "available": true }` (optional `variantId`). Changes increment the source sequence.
- `POST /control/config`: optional `latencyMs`, `failNext`, `rateLimitNext`, `retryAfterMs`, `checkoutFailure`, `dropCheckoutResponse`, `completionDelayMs`, `invalidStatus`, and `statusAgeMs` settings. Dropping a checkout response simulates an order being recorded while its client cannot determine the result.
- `GET /control/metrics`: request counts and number of simulated orders created.

To register this adapter in the desktop, set `ORBIT_SIMULATOR_URL` to the printed loopback origin when running `pnpm dev` or `pnpm start`. The existing group form will then list Local HTTP Simulator; choose `SKU-42` and optional variant `blue` for an initially available product. Mock scenarios apply to the mock adapter; the HTTP simulator uses its control API instead.

The CLI defaults to `.orbit-simulator/state.sqlite`; override `ORBIT_SIMULATOR_DB` with a separate path, or explicitly use `:memory:` for ephemeral testing. Never point it at the desktop database. SQLite WAL/FULL commits preserve carts, orders, idempotency keys, source ID, inventory values/sequences and delayed due times. Restart with the same origin/path to reconcile an existing attempt. Startup reschedules pending completion timers; the inventory stream changes independently so active subscriptions can accept fresh events. A missing/deleted/ephemeral database changes order identity and leaves reconciliation unknown rather than inferring failure. Delayed completion uses an independent submission timer; status GET requests do not complete or insert orders. [ORDER_RECONCILIATION.md](../ORDER_RECONCILIATION.md) describes the workflow and controls. This is a deterministic local development service, not a production commerce system or authentication design. Control tokens rotate each launch and are not persisted. The storage owner rejects foreign/future schemas and uses exclusive SQLite locking. Tests send SIGKILL between submission and delayed completion, restart the process, reconcile through GET only, and verify idempotent replay creates no second order. Physical power-loss/corruption repair and multi-server access are not supported.

`packages/retailer-sdk` defines normalized capabilities, authentication requirements, product/variant references, observations with source sequence and timestamps, cart/checkout results, retailer errors, rate information and policies. `AdapterRegistry` registers named factories and rejects duplicate identifiers and real purchasing capabilities. Inventory-only non-simulated registrations are supported. Application composition lives in `packages/adapters/src/index.ts`; future adapter registration does not require changing engine state-machine logic. The mock and HTTP adapters retain milestone-one convenience methods for compatibility.
