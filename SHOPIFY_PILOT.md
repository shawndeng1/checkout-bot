# Authorized Shopify development-store pilot

**Live status: NOT EXECUTED — no developer-store credentials or test-store access were supplied.** No Shopify account was created, credentials requested, or real store traffic/purchases performed during this milestone. Fixture-backed discovery/monitoring and deterministic rate/error behavior are exercised by the automated suite. The live suite is runnable and deliberately skipped unless explicitly enabled.

## Manual setup before enabling live access

Use a development/test store you control or have explicit permission to access. Follow Shopify's supported Storefront API setup to obtain a **public Storefront access token**, with `unauthenticated_read_product_listings`. Orbit uses `X-Shopify-Storefront-Access-Token`, not an Admin or private Storefront token. Publish a test product to that Storefront channel. No Admin API credentials or mutations are needed.

Create two tracked test variants on one product. Give one available stock, disable continue-selling-when-out-of-stock, and set the other to zero stock. Record the product handle/GID and both full variant GIDs. The unavailable variant must initially report `availableForSale=false`; fulfillment/location/channel policy can affect that result. Availability is storefront sellability, not exact warehouse stock.

Read [the integration guide](RETAILER_INTEGRATION_GUIDE.md) before configuring the desktop. In Settings choose authorized-store mode, enter the exact `https://<developer-store>.myshopify.com` origin without paths/query/credentials, confirm authorization, and supply the public token through the password field. Main encrypts desktop credentials through OS safeStorage; never put tokens in task identifiers, public config, logs, screenshots, or repository files. Verify OS encryption availability in Diagnostics. Replacement/deletion stops this retailer's tasks; start them explicitly after replacement.

## Runnable live suite

Use Node 24.15+ and an interactive terminal. Populate only public test identifiers in the visible configuration; read the token silently rather than pasting it into a shell command/history:

```sh
export ORBIT_LIVE_PILOT=authorized
export ORBIT_SHOPIFY_ORIGIN=https://your-developer-store.myshopify.com
export ORBIT_SHOPIFY_PRODUCT=your-test-product-handle
export ORBIT_SHOPIFY_AVAILABLE_VARIANT=gid://shopify/ProductVariant/AVAILABLE_ID
export ORBIT_SHOPIFY_UNAVAILABLE_VARIANT=gid://shopify/ProductVariant/UNAVAILABLE_ID
read -r -s ORBIT_SHOPIFY_TOKEN
export ORBIT_SHOPIFY_TOKEN
pnpm test:pilot
unset ORBIT_SHOPIFY_TOKEN ORBIT_LIVE_PILOT
```

`read -s` suppresses terminal echo in Bash/zsh. Enter the token only at that silent read. On PowerShell use `Read-Host -AsSecureString`, assign its value to the process environment using `System.Net.NetworkCredential`, and clear `$env:ORBIT_SHOPIFY_TOKEN` and `$env:ORBIT_LIVE_PILOT` after the command. Do not use an `.env` file or print either token value. These environment credentials are transient pilot-process input, not the desktop's at-rest credential store. Run on a trusted workstation and remove inherited pilot enablement before normal tests.

The suite is `tests/shopify-live.test.ts`. `pnpm test:pilot` alone does not enable live mode; it reports skipped tests. Normal tests and CI do not provide the flag or credentials. Missing required configuration after explicit enablement fails without printing values. The suite creates an isolated temporary SQLite database and deletes it after completion; it never changes your desktop data.

When prompted during the monitoring test, manually change the initially unavailable variant to available in your test-store admin. Orbit only reads. The test waits up to 120 seconds for the change, verifies a durable in-app notice/history, closes and reopens SQLite/engine with monitoring recovery, then cancels the tasks. Restore test stock manually afterward.

| Check                              | Automated live procedure                                                          | Current live result |
| ---------------------------------- | --------------------------------------------------------------------------------- | ------------------- |
| Authentication / pinned API        | Authorized lookup; reject an unexpected reported API version                      | NOT EXECUTED        |
| Product and variant lookup         | Verify both configured variants exist in product lookup                           | NOT EXECUTED        |
| Available/unavailable observations | Two inventory-only tasks verify initial availability                              | NOT EXECUTED        |
| Inventory change / in-app notice   | Operator changes test inventory; observe transition and persisted notice          | NOT EXECUTED        |
| Client pacing                      | Successive scheduled lookups enforce the conservative request floor               | NOT EXECUTED        |
| Credential failure                 | One deliberately invalid public-token read must yield a non-retryable AUTH error  | NOT EXECUTED        |
| Monitoring cancellation            | Abort both watches; verify cancelled state and no checkout attempts               | NOT EXECUTED        |
| Persistence/restart                | Reopen the same temporary database, restore configured monitoring, retain history | NOT EXECUTED        |
| Native notification                | Manual desktop/OS-permission check described below                                | NOT EXECUTED        |
| Actual Shopify throttle response   | Observational only; skipped if none occurs naturally                              | NOT EXECUTED        |

Do not flood Shopify to manufacture a throttle. Fixture tests deterministically exercise GraphQL HTTP-200 `THROTTLED` and the adapter's bounded retry behavior. The live suite validates client pacing and reports real throttling only if naturally encountered; a skipped observational case does not prove Shopify rate-limit handling in a live environment. HTTP 430/permission rejection stops rather than attempting circumvention.

## Manual desktop acceptance

With explicit authorized desktop configuration, search/select the test product and variant, create a monitor-and-notify watch, and confirm names, descriptions, images, attributes, availability and timestamps. Test cancel during discovery, missing product, and revoked/replaced token behavior. Rotate a token without revealing the old one; verify its watch is stopped and requires explicit restart. Delete it and confirm credential status becomes missing and active retailer work stops. A locked/unavailable OS credential service must not fall back to plaintext.

Enable native notifications in Settings, grant normal OS notification permission, and change test stock from unavailable to available. Confirm one in-app notice and, where supported, one native notice without profile/payment data. Toggle stock again only after an observed unavailable state to test duplicate suppression. Quit/reopen the desktop with monitoring recovery enabled and verify freshness, history and subsequent cancellation. Record OS/runtime, token scope (not token), product publication, timestamp, expected/actual result, and relevant classified errors in a separate pilot report. Do not include credentials in screenshots or exported logs.

## Official contract references

- [Storefront product lookup, 2026-07](https://shopify.dev/docs/api/storefront/2026-07/queries/product)
- [Storefront product search, 2026-07](https://shopify.dev/docs/api/storefront/2026-07/queries/search)
- [ProductVariant attributes and availability](https://shopify.dev/docs/api/storefront/2026-07/objects/ProductVariant)
- [Supported authentication](https://shopify.dev/docs/api/usage/authentication)
- [API limits](https://shopify.dev/docs/api/usage/limits), [error codes](https://shopify.dev/docs/api/usage/response-codes)

The adapter remains inventory/discovery only. Real cart, checkout, order submission, private Admin inventory, CAPTCHA/queue bypass and access-control circumvention are unsupported.
