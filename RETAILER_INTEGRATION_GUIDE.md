# Authorized inventory integration guide

Orbit includes an inventory-only Shopify Storefront adapter and a functioning loopback contract fixture. No developer-controlled store credentials were provided for this milestone, so integration validation used the fixture. Live store activation requires the developer's explicit authorization and credentials. No real store request or real order was made during validation.

## Contract and registration

Register factories in `packages/adapters/src/index.ts`; the engine has no retailer-name branches. The SDK declares product lookup, variants, inventory, cart, checkout, and order-status capabilities independently. Inventory-only adapters implement `observe` and `inventoryScope`, and may implement `lookupProduct`; cart, checkout, and status methods are optional. Registry registration validates capability shapes, IDs, uniqueness, and request policy; factory creation validates matching identity/capabilities and methods required by each advertised capability. The registry permits independent simulated capabilities and prohibits non-simulated cart/checkout/order-status capabilities. Task admission separately requires inventory for monitoring workflows.

Attach a strict Zod `configurationSchema` and generic `configurationFields` descriptors (text/select/checkbox, optional defaults) to the registration. The Settings form renders them without retailer conditions in the core engine. Validate again when constructing an adapter. Unknown configuration keys are rejected. Define sharing scope to include relevant configuration/account/region identity and normalize all failures to `RetailerError`, with retryability, rate information, and submission certainty. Implement cancellation and response validation. Never include secrets in the configuration schema, scope string, logs, or snapshots.

## Try the fixture

```sh
pnpm fixture:shopify
pnpm dev
```

The fixture defaults to `http://127.0.0.1:4319`; `ORBIT_FIXTURE_PORT` selects another port (0 requests an ephemeral port). The command prints the origin and ephemeral control token. In Settings, select **Local contract fixture**, enter that origin, leave the Storefront token blank, and save the integration. No OS credential-service interaction is required without a token.

Create a Shopify task group and a **Monitor and notify** task:

- Product: `orbit-shirt` or `gid://shopify/Product/1`
- Blue variant: `gid://shopify/ProductVariant/1`
- Red variant: `gid://shopify/ProductVariant/2`
- Blank variant: any available variant

Blue starts unavailable; red stays unavailable. Change blue availability using the printed token:

```sh
curl -X POST http://127.0.0.1:4319/control \
  -H 'Authorization: Bearer <fixture-control-token>' \
  -H 'Content-Type: application/json' \
  -d '{"available":true}'
```

Controls also include `denied` (boolean), `throttled` (next N reads), `invalid` (boolean), and `latencyMs` (0–5000). The server accepts only the versioned inventory query, binds loopback, checks Host/Origin, limits bodies, and never forwards traffic. It does not emulate Shopify token issuance, all API schema details, or production limits. Mutation attempts are rejected. Fixture state resets on restart.

## Activate an authorized developer store

1. Use a Shopify development/test store you control, or obtain explicit permission from its owner. Create the appropriate Storefront API access through Shopify's supported tooling. Obtain a **public Storefront access token**, the token type used by `X-Shopify-Storefront-Access-Token`; do not supply an Admin token or a private Storefront token.
2. Grant the documented `unauthenticated_read_product_listings` scope and publish test products to the relevant Storefront sales channel. Use product handles or product GIDs and variant GIDs available to that token. Orbit reads `availableForSale`, not precise warehouse stock quantities.
3. Stop this retailer's tasks. In Settings choose **Authorized developer store**, enter `https://<store>.myshopify.com` without path/query/embedded credentials, confirm authorization, and enter the token. A credential is required; custom domains, HTTP, redirects, and non-Shopify origins are rejected.
4. Save. Orbit validates configuration first, encrypts the credential through Electron `safeStorage`, and commits public configuration in the worker. Start a monitor-only/notify task and verify inventory. Shopify cart and checkout operations do not exist in this adapter, and the engine rejects checkout workflows for it.
5. If access is denied, verify token scope, channel publication, and authorization. Revoked/expired credentials fail monitoring; replace them in Settings. Respect Shopify access denials and security responses rather than retrying around them.

The adapter pins Storefront API `2026-07`, pages variants (100/page, maximum 20 pages), and checks response schemas. It uses a conservative 500 ms request floor and one scheduled operation at a time, including paced pagination. HTTP 429/Retry-After and GraphQL HTTP-200 `THROTTLED` errors feed the shared rate-limit scheduler; AUTH/403/430 fail without retry. Timeouts and service errors use bounded inventory retries. This is a conservative client policy, not a claim that Shopify publishes a fixed two-requests-per-second Storefront quota.

## Credential handling

The renderer exposes only a password input. Its value is sent over sender-validated IPC, cleared after save, and never returned. Main uses OS-backed `safeStorage` (Keychain on macOS, DPAPI on Windows, supported secret-service/keyring backend on Linux) to encrypt credential values into `credentials.enc.json`, mode 0600 where supported, using an atomic rename. The worker receives decrypted credentials only in memory. Public configuration stays in SQLite. There is no plaintext fallback: unavailable encryption and Linux `basic_text`/unknown backends are rejected. Existing encrypted credentials are retained when encryption fails; inaccessible credentials pause monitoring recovery.

Configuration commands are serialized. Validation happens before credential persistence; database commit failure attempts to restore the prior encrypted credential set. SQLite and the OS credential file are separate durability domains, so a process crash between their commits can require re-entering the correct token. Such a mismatch cannot enable purchasing. Token replacement is supported; dedicated credential deletion/rotation management is future work. Tests use an injected encryption provider; live OS-keychain round trips and Linux/Windows secret services were not exercised.

## Official references

- [Storefront product query, version 2026-07](https://shopify.dev/docs/api/storefront/2026-07/queries/product)
- [Storefront ProductVariant and availableForSale](https://shopify.dev/docs/api/storefront/2026-07/objects/ProductVariant)
- [Storefront API access tokens](https://shopify.dev/docs/api/usage/authentication)
- [Shopify API limits](https://shopify.dev/docs/api/usage/limits)
- [Shopify API response codes](https://shopify.dev/docs/api/usage/response-codes)
- [Electron safeStorage behavior](https://www.electronjs.org/docs/latest/api/safe-storage)

Unsupported: Admin inventory mutations, quantity/warehouse tracking, OAuth enrollment, webhook ingestion, arbitrary retailer URLs, browser scraping, CAPTCHA/queue/access-control bypass, real cart/checkout/order submission, remote order reconciliation, and a product-catalog browser in the desktop. Product/variant lookup is available through the adapter; the task form currently accepts identifiers directly.
