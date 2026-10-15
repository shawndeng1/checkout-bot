import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  RetailerError,
  productRef,
  type RetailerAdapter,
  type RetailerCapabilities,
  type ProductDetails,
} from "../../../retailer-sdk/src/index";
import type { Task } from "../../../shared-types/src/index";
export const shopifyCapabilities: RetailerCapabilities = {
  inventory: true,
  productLookup: true,
  variants: true,
  cart: false,
  checkout: false,
  orderStatus: false,
  simulated: false,
  sharedInventory: true,
  authentication: [
    { kind: "session", scopes: ["unauthenticated_read_product_listings"] },
  ],
};
export const shopifyConfig = z
  .object({
    mode: z.enum(["fixture", "authorized-store"]).default("fixture"),
    endpoint: z.string().default("http://127.0.0.1:4319"),
    authorizationConfirmed: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value.endpoint);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Enter a valid API origin",
        path: ["endpoint"],
      });
      return;
    }
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      ctx.addIssue({
        code: "custom",
        message: "Use an origin without credentials or paths",
        path: ["endpoint"],
      });
    if (
      value.mode === "fixture" &&
      (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    )
      ctx.addIssue({
        code: "custom",
        message: "Fixture must be loopback HTTP",
        path: ["endpoint"],
      });
    if (
      value.mode === "authorized-store" &&
      (url.protocol !== "https:" ||
        !/^[-a-z0-9]+\.myshopify\.com$/.test(url.hostname) ||
        url.port ||
        !value.authorizationConfirmed)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Authorized mode requires a confirmed developer-controlled myshopify.com HTTPS store",
        path: ["endpoint"],
      });
  });
export const productQuery = `query OrbitInventory($id: ID, $handle: String, $after: String) { product(id: $id, handle: $handle) { id title variants(first: 100, after: $after) { nodes { id title availableForSale } pageInfo { hasNextPage endCursor } } } }`;
const responseSchema = z.object({
  data: z
    .object({
      product: z
        .object({
          id: z.string(),
          title: z.string(),
          variants: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                availableForSale: z.boolean(),
              }),
            ),
            pageInfo: z.object({
              hasNextPage: z.boolean(),
              endCursor: z.string().nullable(),
            }),
          }),
        })
        .nullable(),
    })
    .optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z.object({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});
export class ShopifyInventoryAdapter implements RetailerAdapter {
  readonly id = "shopify";
  readonly capabilities = shopifyCapabilities;
  private sequence = 0;
  private stream = randomUUID();
  private config: z.infer<typeof shopifyConfig>;
  constructor(
    config: Record<string, unknown> = {},
    private credential?: string,
  ) {
    this.config = shopifyConfig.parse(config);
    if (this.config.mode === "authorized-store" && !credential)
      throw new RetailerError(
        "Storefront token required; configure secure credentials",
        "AUTH",
        false,
      );
  }
  inventoryScope() {
    return JSON.stringify(this.config);
  }
  async lookupProduct(
    identifier: string,
    signal: AbortSignal,
  ): Promise<ProductDetails> {
    const variants: ProductDetails["variants"] = [];
    let after: string | null = null;
    let details: ProductDetails | undefined;
    for (let page = 0; page < 20; page++) {
      let response: Response;
      try {
        response = await fetch(
          this.config.endpoint.replace(/\/$/, "") + "/api/2026-07/graphql.json",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.credential
                ? { "X-Shopify-Storefront-Access-Token": this.credential }
                : {}),
            },
            body: JSON.stringify({
              query: productQuery,
              variables: {
                id: identifier.startsWith("gid://shopify/Product/")
                  ? identifier
                  : null,
                handle: identifier.startsWith("gid://") ? null : identifier,
                after,
              },
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            redirect: "error",
          },
        );
      } catch {
        throw new RetailerError(
          signal.aborted
            ? "Inventory request cancelled"
            : "Inventory request timed out or failed",
          "NETWORK",
          !signal.aborted,
        );
      }
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 430
      )
        throw new RetailerError(
          "Storefront access denied; verify store authorization and token permissions",
          "AUTH",
          false,
        );
      if (response.status === 429)
        throw new RetailerError("Storefront rate limit", "RATE_LIMIT", true, {
          retryAfterMs: Math.min(
            60000,
            Math.max(
              500,
              Number(response.headers.get("retry-after") ?? 1) * 1000 || 1000,
            ),
          ),
        });
      if (!response.ok)
        throw new RetailerError(
          "Storefront service error",
          "NETWORK",
          response.status >= 500,
        );
      const result = responseSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!result.success)
        throw new RetailerError(
          "Invalid Storefront response",
          "INVALID_RESPONSE",
          false,
        );
      if (result.data.errors?.length) {
        const limited = result.data.errors.some(
          (error) => error.extensions?.code === "THROTTLED",
        );
        throw new RetailerError(
          limited
            ? "Storefront throttled inventory lookup"
            : "Storefront query denied or invalid",
          limited ? "RATE_LIMIT" : "AUTH",
          limited,
          limited ? { retryAfterMs: 1000 } : undefined,
        );
      }
      const product = result.data.data?.product;
      if (!product)
        throw new RetailerError(
          "Product not found or not published to this Storefront",
          "INVALID_RESPONSE",
          false,
        );
      variants.push(
        ...product.variants.nodes.map((variant) => ({
          id: variant.id,
          title: variant.title,
          available: variant.availableForSale,
        })),
      );
      details = { id: product.id, title: product.title, variants };
      if (!product.variants.pageInfo.hasNextPage) return details;
      const cursor = product.variants.pageInfo.endCursor;
      if (!cursor || cursor === after)
        throw new RetailerError(
          "Invalid variant pagination",
          "INVALID_RESPONSE",
          false,
        );
      after = cursor;
      // Pagination is part of one scheduled operation; pace additional API requests too.
      const { delay } = await import("../../../retailer-sdk/src/index");
      await delay(500, signal);
    }
    throw new RetailerError(
      "Product variant pagination limit reached",
      "INVALID_RESPONSE",
      false,
    );
  }
  async observe(task: Task, signal: AbortSignal) {
    const product = await this.lookupProduct(task.product, signal);
    const variant = task.variantId
      ? product.variants.find((item) => item.id === task.variantId)
      : undefined;
    if (task.variantId && !variant)
      throw new RetailerError(
        "Variant not found in product",
        "INVALID_RESPONSE",
        false,
      );
    const available = variant
      ? variant.available
      : product.variants.some((item) => item.available);
    const sequence = ++this.sequence;
    return {
      eventId: `${this.stream}:${sequence}`,
      streamId: this.stream,
      retailerId: this.id,
      product: productRef(task),
      sequence,
      observedAt: Date.now(),
      expiresAt: Date.now() + 30000,
      availability: available
        ? ("in-stock" as const)
        : ("out-of-stock" as const),
    };
  }
}
