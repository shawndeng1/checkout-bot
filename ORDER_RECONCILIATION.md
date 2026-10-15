# Simulated order reconciliation

`UNKNOWN_OUTCOME` means a checkout intent was committed, but Orbit cannot establish the result. It does not mean failure. Start/restart cannot leave this state. Reconciliation is a separate, explicit status lookup; it never calls cart creation or checkout submission.

## Use the desktop

Start the HTTP simulator with `pnpm simulator` and register it using `ORBIT_SIMULATOR_URL=http://127.0.0.1:4318 pnpm dev`. Create a simulator task for `SKU-42`, variant `blue`, with the simulated-checkout workflow. Configure the simulator to drop the checkout response, then approve the task. The task becomes unknown after one submission.

Open **Reconciliation** and choose **Check Order Status**. Each card shows task identifier, original retailer/product/variant, checkout attempt/idempotency key, submission timestamp, last reported result, last lookup time, and recent reconciliation history. The button is disabled while checking or after definitive resolution. Historical cards cannot operate on a newer attempt for the same task.

| Status evidence                                                                                          | Task result                                    |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Authoritative completed result with matching identity and order ID                                       | `COMPLETED`                                    |
| Authoritative recorded failure                                                                           | `FAILED`                                       |
| Pending or unresolved                                                                                    | Remain `UNKNOWN_OUTCOME`; user may check again |
| Missing adapter, source mismatch, stale/invalid response, rate limit, cancellation, or transport failure | Record error; remain blocked                   |

## Durable intent and evidence

The run UUID is the checkout idempotency key. Before submission, one transaction persists intent, original retailer, adapter configuration scope, typed cart, and simulator source identity. Existing Milestone 2 attempts remain readable. An old attempt lacking verifiable source metadata cannot be authoritatively reconciled and remains blocked; a missing record cannot safely be treated as failure.

Each lookup starts with a persisted `started` reconciliation row. It uses the normal bounded operation scheduler, releases capacity while queued, and honors AbortSignal. Overlapping requests for one task share a promise, including overlapping worker RPC requests. A completed authoritative attempt is a no-op on repeat requests. Pending/error outcomes can be checked again explicitly.

Responses are runtime validated. The attempt key and source must match; configuration scope must still match the original adapter. Evidence older than the lookup/submission, more than 30 seconds old, more than 5 seconds in the future, regressive in sequence/time, or contradictory at the same sequence is rejected. These checks are appropriate for the local simulator's common clock. A future remote order adapter would need an explicit server-clock/version strategy.

The evidence, reconciliation row, attempt result, task state, run outcome, and log are committed in one SQLite transaction. A statement failure rolls back them together. Interrupted `started` rows become `interrupted` on recovery; they do not grant permission to submit or change an unknown outcome. Shutdown cancels active and capacity-queued lookups. A database failure may require restart/recovery before retrying; Orbit does not hide worker failures.

## Simulator contract

`GET /orders/status?idempotencyKey=<run-uuid>` only reads status. It returns a source ID, sequence, checked timestamp, and one of completed/failed/pending/unresolved. It never inserts, submits, or completes an order. A separate timer implements delayed simulated completion after the original submission.

Use authenticated `POST /control/config` with:

```json
{ "dropCheckoutResponse": true, "completionDelayMs": 5000 }
```

A lost successful response can later resolve to completed. Add `checkoutFailure: true` to record a definite decline while dropping its response. `invalidStatus: true` and `statusAgeMs: 60000` exercise invalid/stale evidence. Reset those controls to check again. `GET /control/metrics` exposes status requests, checkout requests, and order count; repeated reconciliation never raises checkout/order counts.

The simulator CLI now persists source identity, carts, order/idempotency records, inventory, and delayed-completion due times in its separate SQLite database. Keep the same database and origin on restart. Pending timers resume independently and status lookup can reconcile the original attempt without resubmission. Programmatic test mode can still use `:memory:`; a missing/deleted database creates a different source and remains inconclusive. A missing record is never failure evidence. Physical corruption recovery, manual override, real order status, and automatic resubmission remain unsupported. See [simulator storage](docs/SIMULATOR.md).
