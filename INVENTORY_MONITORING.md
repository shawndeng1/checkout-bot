# Inventory monitoring

Orbit supports three explicit task workflows. Existing records without a workflow continue to use `MONITOR_AND_CHECKOUT`.

| Workflow               | Behavior                                                               | Required adapter capabilities       |
| ---------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| `MONITOR_ONLY`         | Observe continuously, persist availability and history                 | Inventory                           |
| `MONITOR_AND_NOTIFY`   | Observe continuously and notify on transitions to available            | Inventory                           |
| `MONITOR_AND_CHECKOUT` | Wait for stock, create a simulated cart, require approval, submit once | Simulated inventory, cart, checkout |

## Desktop workflow

Use **Discover** to search/look up a configured product, inspect variants and create an inventory task, or configure the retailer under **Settings**, create a retailer task group under **Tasks**, and select a workflow in the task form. Choose a product identifier and optional variant identifier. Blank variant means the adapter's aggregate/default product observation: Shopify aggregates availability across variants, while the local HTTP simulator uses its default variant. Inventory-only groups default new tasks to monitor-and-notify.

Open **Inventory** for current availability, observation freshness, start/stop controls, notification history, and paginated change history (20 entries per page). A stock detection leaves continuous tasks running in `STOCK_DETECTED`; an unavailable/unknown observation returns them to `MONITORING`. They never create a cart, request purchase approval, or submit checkout. Stopped tasks retain their last observation, which is visibly marked expired when its TTL elapses. Missing products, permissions, or invalid responses fail the task with a structured log; an expired event is ignored rather than interpreted as stock or no stock.

Intervals are configurable from 100 to 60,000 ms, subject to each registered retailer's request policy. The Shopify adapter has a conservative 500 ms minimum between scheduled operations and one operation at a time. Additional variant pages are paced at 500 ms. Retryable inventory failures use bounded exponential backoff and normalized Retry-After cooldowns; permission failures stop immediately.

## One observation pipeline

Compatible subscriptions share one poller keyed by retailer, product, variant, profile/proxy identity, requested interval, retry bound, adapter scope, and sharing capability. Workflows can share the same source: checkout subscribers leave on stock detection; continuous subscribers remain. Cancellation removes one reference, and the last unsubscribe aborts the HTTP request or wait. Polls acquire operation capacity only while executing; continuous tasks do not reserve a permit between polls.

Runtime-validated observations contain product/variant identity, retailer, stream ID, event ID, source sequence, timestamp, optional expiry/quantity, and normalized availability. Events for the wrong product/retailer are rejected. Expired observations, decreasing sequences/timestamps, duplicate IDs, and retired streams cannot cause stock transitions. A repeated current source event with a refreshed timestamp is a heartbeat: it refreshes latest-observation freshness without duplicating history or notifications. The default TTL is 30 seconds when an adapter does not supply one. Shopify returns a fresh observation sequence on each successful read.

Each accepted event transaction writes the latest per-task observation, bounded history, lifecycle changes/logs, and any new notice. SQLite retains 10,000 inventory history rows and 1,000 notices; snapshots contain no inventory history rows and 100 notices. History is a bounded SQL keyset query, independently filtered/refreshed in the UI, not a complete export. Unchanged successful reads refresh latest observation and last-success time without adding change rows. Data remains local.

## Notifications

Only monitor-and-notify tasks generate alerts. A transition from unobserved/unavailable to available creates one in-app notice per shared source event/product/variant. Repeated available observations are suppressed. Preferences can disable inventory notices or additionally enable native desktop notifications. The native event is emitted only after the same observation transaction commits; there is no notification polling loop. Payloads contain product/variant, retailer, task identifier, timestamp, and a stock message, never profile/contact/payment information.

Notice history survives restart. Native delivery is best effort and depends on OS permission/support; it is not a durable delivery queue. Disabling notifications does not delete historical notices. To reduce duplicate delivery, already recorded stock does not trigger another notice solely because the app restarted.

The Inventory view supports name/identifier search, availability/active filters, product/variant metadata, last-success time and the last classified monitoring error. See [product discovery and history](PRODUCT_DISCOVERY.md).

## Recovery

With **Resume interrupted monitoring** enabled, both `MONITORING` and continuous `STOCK_DETECTED` tasks close the interrupted run and start a new monitoring run. Without it, they remain cancelled until started explicitly. Observation history survives either policy. Missing adapters or inaccessible secure credentials pause automatic recovery without preventing startup. Checkout permission and unknown purchase outcomes are never resumed as submissions.

See [retailer activation](RETAILER_INTEGRATION_GUIDE.md) and [order reconciliation](ORDER_RECONCILIATION.md).
