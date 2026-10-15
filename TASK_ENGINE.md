# Task lifecycle — Milestone 4

```text
CREATED → MONITORING → STOCK_DETECTED → CARTING → AWAITING_APPROVAL
                                                   ↓ explicit approval + capacity
                                             CHECKING_OUT → COMPLETED
                                                   ↓ uncertainty
                                              UNKNOWN_OUTCOME
```

Created tasks can be cancelled. Monitoring, stock-detected, carting, and approval states can fail or cancel. Checking-out can complete, fail definitively, or become unknown; cancelling after durable submission intent conservatively means unknown. Completed/failed/cancelled tasks can start a new run. Unknown outcomes have no start/restart edge; authoritative reconciliation can resolve them to completed/failed. All other edges are rejected by the exported transition validator.

## Capacity and shared monitoring

Each task retains its own configuration, history, AbortController, and approval context. Execution capacity limits requests, not task count: inventory polls, cart operations, and checkout submissions acquire a FIFO permit. Approval waits release capacity. Approved tasks queue through the bounded scheduler; duplicate approvals are no-ops and cannot create another attempt. Tasks can cancel while waiting for stock, approval, rate policy, or execution capacity.

Compatible tasks share one product-keyed inventory poller. The key includes retailer, product, variant, profile/proxy IDs, interval, retry bound, adapter scope, and sharing capability. Observations have a source stream ID, event ID, sequence, timestamp, product, and availability. Duplicate/non-increasing events, older timestamps, and retired streams are suppressed. In-stock events resolve checkout subscribers once. `MONITOR_ONLY` and `MONITOR_AND_NOTIFY` subscribers stay active: `MONITORING ↔ STOCK_DETECTED`, until stopped or failed. Both states recover as interrupted monitoring for these workflows. Reference-counted cleanup aborts the source when no subscribers remain. Tests exercise 10, 50, and 100 tasks on one subscription and verify exactly three deterministic mock polls.

Per-retailer gates constrain request concurrency and minimum spacing, and apply Retry-After to subsequent requests even if those requests were already queued globally. Global permits are released during rate-policy waits. Increasing the global limit pumps pending operations; lowering it lets active requests finish before admitting more. At most 1,000 task contexts are admitted, with 2,000 pending entries per operation gate.

## Retries and typed adapter results

Retryable normalized errors in inventory/cart operations allow the configured 0–5 retries. Exponential delay is `min(300 × 2^attempt, 10000)` ms, extended by a longer normalized Retry-After. Tests inject a shorter base. Successful out-of-stock observations continue polling; they do not count as failures. Checkout submission is never automatically retried, including for 429, timeout, or unknown transport errors.

Discovery requests use the same bounded scheduler and abort support, with separate request IDs and optional search/lookup capability checks. They use up to two retries and do not reserve a logical purchasing task context. Credential replacement/deletion cancels retailer discovery and stops its tasks before changing credentials.

The SDK provides typed product/variant references, inventory, cart, checkout, capability/authentication declarations, and rate-limit/error contracts. Adapter registration lives outside engine control flow. Inventory-only adapters may omit cart/checkout methods. Real adapters can only monitor/lookup products; purchasing workflows require simulated cart/checkout capabilities. Mock convenience methods remain for compatibility. The HTTP adapter accepts only a `127.0.0.1` HTTP origin, rejects redirects, validates response shapes, applies timeouts, and propagates AbortSignal cancellation.

## Approval, intent, and recovery

The cart is persisted before exposing approval. A user approval only grants permission for the current in-memory execution. Before the adapter submits checkout, the engine atomically records an intent using the run UUID as its idempotency key. The simulator returns the same order for repeated submissions with that key/cart, but Orbit does not use this as permission to retry an uncertain submission automatically.

| Interrupted state                           | Recovery                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| MONITORING                                  | Close interrupted run as cancelled; restart monitoring only when `resumeMonitoring` is enabled |
| STOCK_DETECTED (continuous inventory)       | Same monitoring recovery policy                                                                |
| STOCK_DETECTED (checkout) / CARTING         | Cancel; explicit restart required                                                              |
| AWAITING_APPROVAL with saved cart           | Restore approval context; require user approval again                                          |
| Legacy AWAITING_APPROVAL without saved cart | Cancel; explicit restart required                                                              |
| CHECKING_OUT                                | Mark attempt/run/task UNKNOWN_OUTCOME; never automatically submit again                        |
| UNKNOWN_OUTCOME                             | Remain blocked until an explicit lookup supplies authoritative evidence                        |

Recovery reasons are recorded in run history. Missing optional adapters do not block UI startup: approval data remains saved and cancellable, while automatic monitoring recovery pauses. Stop/restart of an executing checkout can produce an unknown outcome, so restart is then rejected. Do not infer that an unknown outcome means failure or absence of an order.

Graceful shutdown prevents new starts, aborts active/waiting work, drains shared sources, preserves saved approvals, and preserves monitoring for configured recovery. The main-process client has a 10-second fallback termination deadline. Abrupt worker-exit tests demonstrate that a committed checkout intent recovers as unknown without another submission.

## Mock and HTTP simulation

Mock scenarios remain available: third-check availability, indefinitely out of stock, bounded timeout failures, first-two-check rate limiting, and checkout decline. HTTP simulation adds catalog/variants, explicit inventory changes, latency, failures, 429 responses, idempotent orders, and deliberately lost checkout responses. See [SIMULATOR.md](docs/SIMULATOR.md).

## Explicit reconciliation

Order-status requests acquire bounded execution capacity, support cancellation, persist each lookup, and coalesce duplicates per task. The lookup never submits orders. Matching attempt/source/configuration identity, non-regressive fresh evidence, and an authoritative result are required for `UNKNOWN_OUTCOME → COMPLETED/FAILED`. The state/result/history/log writes share one transaction. Inconclusive/error results remain unknown. Interrupted lookups become interrupted history entries and may be requested again. [ORDER_RECONCILIATION.md](ORDER_RECONCILIATION.md) documents the contract and simulator controls.

Simulator order evidence now survives a service restart when the same database and origin are reused. Pending timers resume independently; lookup still cannot submit. Ephemeral test mode, a missing/deleted database, or unverifiable legacy source metadata remains unknown.

Structured logs retain task/run IDs, state, level, timestamp, and message. Debug mode records accepted out-of-stock observations. Revisioned snapshots are coalesced for UI delivery; inventory history uses separate keyset pages rather than snapshot rows. Other state still uses full snapshots. Durable monitoring health records last success and classified error without putting token/profile data in diagnostics.
