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
  productSearch: true,
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
const fields = `id title handle availableForSale description(truncateAt: 10000) featuredImage { url altText }`;
export const productQuery = `query OrbitInventory($id: ID, $handle: String, $after: String) { product(id: $id, handle: $handle) { ${fields} variants(first: 100, after: $after) { nodes { id title availableForSale selectedOptions { name value } } pageInfo { hasNextPage endCursor } } } }`;
export const searchQuery = `query OrbitSearch($query: String!, $first: Int!, $after: String) { search(query: $query, types: [PRODUCT], unavailableProducts: SHOW, first: $first, after: $after) { nodes { ... on Product { ${fields} } } pageInfo { hasNextPage endCursor } } }`;
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().max(2000).nullable(),
});
const summary = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(500),
  handle: z.string().max(200),
  description: z.string().max(10000),
  availableForSale: z.boolean(),
  featuredImage: z
    .object({ url: z.string().url(), altText: z.string().max(500).nullable() })
    .nullable(),
});
const productResponse = z.object({
  product: summary
    .extend({
      variants: z.object({
        nodes: z
          .array(
            z.object({
              id: z.string().min(1).max(200),
              title: z.string().max(500),
              availableForSale: z.boolean(),
              selectedOptions: z
                .array(
                  z.object({
                    name: z.string().max(200),
                    value: z.string().max(500),
                  }),
                )
                .max(100),
            }),
          )
          .max(100),
        pageInfo,
      }),
    })
    .nullable(),
});
const searchResponse = z.object({
  search: z.object({ nodes: z.array(summary).max(50), pageInfo }),
});
function normalize(product: z.infer<typeof summary>): ProductDetails {
  const url = product.featuredImage ? new URL(product.featuredImage.url) : null;
  // A retailer image is display-only. Drop non-HTTPS URLs; never fetch it in the worker.
  const image =
    url && url.protocol === "https:" && !url.username && !url.password
      ? { url: url.href, alt: product.featuredImage!.altText }
      : null;
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    description: product.description,
    image,
    observedAt: Date.now(),
    variants: [],
    variantsComplete: false,
    available: product.availableForSale,
  };
}
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
  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
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
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          redirect: "error",
        },
      );
      const apiVersion = response.headers.get("x-shopify-api-version");
      if (apiVersion && apiVersion !== "2026-07")
        throw new RetailerError(
          "Unexpected Storefront API version; update adapter contract before continuing",
          "INVALID_RESPONSE",
          false,
        );
      if ([401, 403, 430].includes(response.status))
        throw new RetailerError(
          "Storefront access denied; verify store authorization and token permissions",
          "AUTH",
          false,
        );
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const parsed = Number(retry);
        const ms =
          retry && !Number.isFinite(parsed)
            ? Date.parse(retry) - Date.now()
            : (parsed || 1) * 1000;
        throw new RetailerError("Storefront rate limit", "RATE_LIMIT", true, {
          retryAfterMs: Math.max(
            500,
            Math.min(60000, Number.isFinite(ms) ? ms : 1000),
          ),
        });
      }
      if (!response.ok)
        throw new RetailerError(
          "Storefront service error",
          "NETWORK",
          response.status >= 500,
        );
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response");
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 2 * 1024 * 1024)
            throw new RetailerError(
              "Storefront response too large",
              "INVALID_RESPONSE",
              false,
            );
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const payload = z
        .object({
          data: z.unknown().optional(),
          errors: z
            .array(
              z.object({
                extensions: z
                  .object({ code: z.string().optional() })
                  .optional(),
              }),
            )
            .optional(),
        })
        .safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!payload.success)
        throw new RetailerError(
          "Invalid Storefront response",
          "INVALID_RESPONSE",
          false,
        );
      if (payload.data.errors?.length) {
        const limited = payload.data.errors.some(
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
      const result = schema.safeParse(payload.data.data);
      if (!result.success)
        throw new RetailerError(
          "Invalid Storefront response",
          "INVALID_RESPONSE",
          false,
        );
      return result.data;
    } catch (error) {
      if (error instanceof RetailerError) throw error;
      if (error instanceof SyntaxError)
        throw new RetailerError(
          "Invalid Storefront response",
          "INVALID_RESPONSE",
          false,
        );
      throw new RetailerError(
        signal.aborted
          ? "Inventory request cancelled"
          : "Inventory request timed out or failed",
        "NETWORK",
        !signal.aborted,
      );
    }
  }
  async searchProducts(
    query: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ) {
    const input = z
      .object({
        query: z.string().trim().min(1).max(200),
        cursor: z.string().max(2000).nullable(),
        limit: z.number().int().min(1).max(50),
      })
      .parse({ query, cursor, limit });
    const { search } = await this.request(
      searchQuery,
      { query: input.query, first: input.limit, after: input.cursor },
      searchResponse,
      signal,
    );
    if (
      search.nodes.length > input.limit ||
      new Set(search.nodes.map((product) => product.id)).size !==
        search.nodes.length
    )
      throw new RetailerError(
        "Invalid product page",
        "INVALID_RESPONSE",
        false,
      );
    if (
      search.pageInfo.hasNextPage &&
      (!search.pageInfo.endCursor || search.pageInfo.endCursor === cursor)
    )
      throw new RetailerError(
        "Invalid product pagination",
        "INVALID_RESPONSE",
        false,
      );
    return {
      products: search.nodes.map(normalize),
      nextCursor: search.pageInfo.hasNextPage
        ? search.pageInfo.endCursor
        : null,
    };
  }
  async lookupProduct(
    identifier: string,
    signal: AbortSignal,
  ): Promise<ProductDetails> {
    const variants: ProductDetails["variants"] = [];
    let after: string | null = null;
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let details: ProductDetails | undefined;
    for (let page = 0; page < 20; page++) {
      const { product }: z.infer<typeof productResponse> = await this.request(
        productQuery,
        {
          id: identifier.startsWith("gid://shopify/Product/")
            ? identifier
            : null,
          handle: identifier.startsWith("gid://") ? null : identifier,
          after,
        },
        productResponse,
        signal,
      );
      if (!product)
        throw new RetailerError(
          "Product not found or not published to this Storefront",
          "INVALID_RESPONSE",
          false,
        );
      if (
        identifier.startsWith("gid://")
          ? product.id !== identifier
          : product.handle.toLowerCase() !== identifier.toLowerCase()
      )
        throw new RetailerError(
          "Product lookup identity mismatch",
          "INVALID_RESPONSE",
          false,
        );
      if (details && details.id !== product.id)
        throw new RetailerError(
          "Product pagination identity mismatch",
          "INVALID_RESPONSE",
          false,
        );
      for (const variant of product.variants.nodes) {
        if (ids.has(variant.id))
          throw new RetailerError(
            "Duplicate variant page",
            "INVALID_RESPONSE",
            false,
          );
        ids.add(variant.id);
        variants.push({
          id: variant.id,
          title: variant.title,
          available: variant.availableForSale,
          attributes: variant.selectedOptions,
        });
      }
      details = { ...normalize(product), variants, variantsComplete: true };
      if (!product.variants.pageInfo.hasNextPage) return details;
      const cursor: string | null = product.variants.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor))
        throw new RetailerError(
          "Invalid variant pagination",
          "INVALID_RESPONSE",
          false,
        );
      cursors.add(cursor);
      after = cursor;
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
      details: {
        title: product.title,
        description: product.description,
        image: product.image,
        ...(variant
          ? { variantTitle: variant.title, attributes: variant.attributes }
          : {}),
      },
    };
  }
}
