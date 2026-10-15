# Local HTTP simulator and adapter registry

Run `pnpm simulator` with Node 24.15+ to start an in-memory HTTP retailer on `127.0.0.1:4318`. The CLI prints its base URL and a temporary control token. `ORBIT_SIMULATOR_PORT` selects another port; port 0 chooses an ephemeral port. The service only binds loopback, rejects browser Origin headers, validates Host, bounds request body size, and requires its ephemeral token for administrative controls. It makes no outbound requests.

Public endpoints:

- `GET /catalog`: products and variants (demo product `SKU-42`, variants `default` and `blue`).
- `GET /inventory?productId=SKU-42&variantId=blue`: normalized availability observation.
- `POST /carts` with `{ "productId": "SKU-42", "variantId": "blue" }`: a simulated cart.
- `POST /checkout` with `{ "cartId": "...", "idempotencyKey": "..." }`: a simulated order. Repeating the same key/cart returns the same result; reusing the key for another cart returns 409.

Administrative endpoints require `Authorization: Bearer <printed-token>`:

- `POST /control/inventory`: `{ "productId": "SKU-42", "available": true }` (optional `variantId`). Changes increment the source sequence.
- `POST /control/config`: optional `latencyMs`, `failNext`, `rateLimitNext`, `retryAfterMs`, `checkoutFailure`, and `dropCheckoutResponse` settings. Dropping a checkout response simulates an order being recorded while its client cannot determine the result.
- `GET /control/metrics`: request counts and number of simulated orders created.

Data and idempotency records are in memory and reset on simulator shutdown. This is a deterministic local development service, not a durable order system or a production authentication design.

`packages/retailer-sdk` defines normalized capabilities, authentication requirements, product/variant references, observations with source sequence and timestamps, cart/checkout results, retailer errors, rate information and policies. `AdapterRegistry` registers named factories and rejects duplicate identifiers and non-simulated adapters. Application composition lives in `packages/adapters/src/index.ts`; future adapter registration does not require changing engine state-machine logic. The mock and HTTP adapters retain milestone-one convenience methods for compatibility.
