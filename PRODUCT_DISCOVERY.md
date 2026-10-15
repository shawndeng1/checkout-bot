# Product discovery and inventory history

Open **Discover**, select a configured retailer, and search through its authorized API. Orbit's Shopify adapter uses Storefront API `2026-07` `search` with product-only results and unavailable products included. Search is optional in the SDK: adapters that only support lookup can use handles/IDs, and adapters with neither capability keep the existing direct-entry task form in Tasks. No HTML scraping or browser session automation is used.

## Discover and monitor

1. Start `pnpm fixture:shopify`, then `pnpm dev` in another terminal. In Settings save the printed loopback fixture origin for Shopify, with fixture mode and no access token.
2. Open Discover and search `shirt`. Select a result, or enter `orbit-shirt` and choose **Look up identifier**. Search pages contain up to 12 products; **Next products** uses the returned opaque cursor. A new search starts from the beginning.
3. Lookup loads the product description, optional image, all supported variant pages, variant names/attributes, current availability, and observation time. Select a variant or any available variant.
4. Select an existing matching retailer group, or name a new one. Choose monitor-only/notify and an interval, then create the task. Creating a task does not silently start it: Inventory provides the explicit Start action.
5. Inventory shows live availability, product/variant details, freshness, last successful check, and the last classified monitoring error. Search filters match task/product names and identifiers. Availability and active-task filters narrow the watch list.

Descriptions are plain text rendered through React escaping. Images come only from normalized API metadata, use HTTPS without URL credentials, and load without a referrer. The worker never fetches arbitrary image URLs. The renderer CSP allows HTTPS images while keeping network API access behind the preload bridge. Missing/failed images do not block selection. The fixture normally omits images; desktop tests fulfill a fake CDN image locally without external requests.

## SDK and IPC

`RetailerCapabilities.productSearch` advertises optional `searchProducts(query, cursor, limit, signal)`. Existing `lookupProduct` returns expanded `ProductDetails`: IDs, title, optional handle/description/image/time, optional aggregate availability, completeness, and typed variants with attributes. Search results are summaries with `variantsComplete=false`; selecting a product performs full lookup before variant selection. Existing minimal adapter results remain valid.

The preload exposes narrowly scoped discovery/cancel/history/diagnostics/credential methods. Main verifies the trusted main frame and strict Zod inputs. Discovery uses a UUID request ID, a registered retailer, bounded text/cursor/page size, and search/lookup mode. The backend runs it through the existing retailer/global scheduler, with two bounded retries for retryable errors and a 110-second overall cancellation deadline. There are at most 20 discovery requests and 256 pending transport RPCs. Shutdown, cancellation, and credential suspension abort requests. Ordinary task commands are not serialized behind network discovery.

React cancels previous requests when typing/changing retailer, on explicit cancel, and on unmount. Request IDs gate responses so cancelled/older results cannot replace a newer selection. Changing configuration while discovery is active is rejected; credential rotation/deletion suspends retailer work first. Permission, unavailable-token, missing-product, invalid-schema/version, empty-result, loading and cancellation states are explicit. Full catalog browsing, arbitrary query URLs, saved searches, and multi-account discovery are not implemented.

## Paginated change history

Snapshots retain current observations and per-task monitoring health, but contain **no inventory history rows** (`inventory: []` is a deprecated compatibility field). Use `history({taskId?, cursor?, limit?})`; limits are 1–100, default 20. The response has items, a next row cursor, and the database revision. SQL applies the task filter and a descending keyset cursor with a bounded LIMIT; it does not export all history.

The Inventory history panel requests 20 rows, supports task filtering, previous/next pages, and explicit refresh. New events do not move an existing page; Refresh returns to the newest page. Query results live separately from Zustand snapshots and cannot overwrite revision-gated application state. An effect-generation guard rejects responses for an old filter/page. Retention or task deletion may shorten an old page.

Latest observations and successful-check time refresh on each accepted read. History records initial observations per run, availability changes, and quantity changes, rather than unchanged poll results. It retains the existing 10,000-row global limit. Existing v3 history remains readable, including previously retained unchanged reads. Monitoring errors are durable classifications/timestamps; successful reads do not erase the last error, allowing users to distinguish its time from later successful checks.

See [inventory lifecycle](INVENTORY_MONITORING.md), [pilot procedure](SHOPIFY_PILOT.md), and [integration authorization](RETAILER_INTEGRATION_GUIDE.md).
