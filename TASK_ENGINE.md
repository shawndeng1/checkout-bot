# Task engine

Normal workflow:

```text
CREATED → MONITORING → STOCK_DETECTED → CARTING → AWAITING_APPROVAL
                                                   ↓ explicit approval
                                             CHECKING_OUT → COMPLETED
```

Every active state can transition to `FAILED` or `CANCELLED`. Created tasks can be cancelled without launching. Completed, failed, and cancelled tasks can start a fresh monitoring run. All other edges, including skipping approval, are invalid. The authoritative transition map and validator are exported by `packages/core`.

## Scheduling and cancellation

Start places the task in a FIFO queue. The scheduler launches at most the configured number of active runs (1–20). Approval waits reserve a slot. Reducing concurrency allows active runs to finish; it prevents further launches until occupancy falls below the new limit. Raising it immediately pumps the queue.

Starting an already queued/running task is a no-op. Running task edits/deletes and group deletion with active/queued tasks are rejected. Each launched run has a new UUID and adapter instance. Restart awaits cancellation before starting a fresh run. Cancellation aborts monitoring, adapter calls, exponential-backoff timers, and approval promises; it closes history as cancelled. Stop removes queued requests without starting them. Terminal tasks retain their last outcome if a subsequent queued restart request is removed before it launches.

The approval callback is registered before the approval-state event is published, avoiding a synchronous event subscriber race. Shutdown prevents new launches, drops the queue, aborts active runs, and waits for final persistence. Crash recovery cancels interrupted states and requires explicit restart; checkout is never resumed automatically.

## Retry policy

Only `AdapterError` with `retryable=true` is retried. Each inventory/cart operation allows 0–5 configured retries after its initial attempt. Delays are `min(300 × 2^retryIndex, 10000)` milliseconds. Tests inject a 10ms base. Successful out-of-stock checks continue monitoring at the configured interval and are not failures. Checkout is never retried in this milestone; future implementations require proven idempotency before permitting retries.

## Deterministic mock scenarios

| Scenario         | Behavior                                                                |
| ---------------- | ----------------------------------------------------------------------- |
| available        | First two checks out of stock; third check available                    |
| out-of-stock     | Continues monitoring until stopped                                      |
| timeout          | Every inventory call raises a retryable timeout; fails at retry bound   |
| rate-limit       | First two inventory calls rate-limit; third succeeds if retries permit  |
| checkout-failure | Stock becomes available; approval leads to a terminal simulated decline |

All mock operations use abortable delays and perform zero network requests. Cart IDs are synthetic. Adapter capabilities explicitly declare inventory, cart, checkout, and simulation support. The engine rejects adapters that do not declare simulation support.

Structured logs contain event ID, task ID, run ID, timestamp, state, level, and message. Info mode logs state changes/retries; debug also logs each successful out-of-stock poll. Logs are persisted before snapshot publication.
