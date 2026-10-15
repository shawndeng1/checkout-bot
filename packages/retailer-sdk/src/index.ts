import { z } from "zod";
export * from "./contracts";
import type {
  OrderStatus,
  ProductDetails,
  ConfigField,
  ProductPage,
} from "./contracts";
import type { Task } from "../../shared-types/src/index";
export interface ProductRef {
  productId: string;
  variantId?: string;
}
export interface InventoryObservation {
  eventId: string;
  streamId: string;
  retailerId: string;
  product: ProductRef;
  sequence: number;
  observedAt: number;
  availability: "in-stock" | "out-of-stock" | "unknown";
  quantity?: number;
  expiresAt?: number;
  details?: z.infer<typeof import("./contracts").observationDetailsSchema>;
}
export interface CartResult {
  sourceId?: string;
  id: string;
  product: ProductRef;
  quantity: number;
  expiresAt?: number;
}
export interface CheckoutResult {
  orderId: string;
  status: "completed";
  idempotencyKey: string;
}
export interface AuthenticationRequirement {
  kind: "none" | "session" | "oauth";
  scopes: string[];
}
export interface RetailerCapabilities {
  productSearch?: boolean;
  productLookup?: boolean;
  variants?: boolean;
  orderStatus?: boolean;
  inventory: boolean;
  cart: boolean;
  checkout: boolean;
  simulated: boolean;
  sharedInventory: boolean;
  authentication: AuthenticationRequirement[];
}
export interface RateLimitInfo {
  retryAfterMs: number;
  remaining?: number;
  limit?: number;
  resetAt?: number;
}
export interface RateLimitPolicy {
  minIntervalMs: number;
  maxConcurrentRequests: number;
}
export type RetailerErrorCode =
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "NETWORK"
  | "AUTH"
  | "DECLINED"
  | "INVALID_RESPONSE"
  | "UNKNOWN";
export class RetailerError extends Error {
  constructor(
    message: string,
    readonly code: RetailerErrorCode,
    readonly retryable: boolean,
    readonly rateLimit?: RateLimitInfo,
    readonly outcome: "not-submitted" | "unknown" = "not-submitted",
  ) {
    super(message);
    this.name = "RetailerError";
  }
}
/** Legacy error constructor retained for adapter compatibility. */
export class AdapterError extends RetailerError {
  constructor(message: string, retryable: boolean) {
    super(
      message,
      message.includes("rate limit") ? "RATE_LIMIT" : "TIMEOUT",
      retryable,
    );
  }
}
export const simulatedCapabilities: RetailerCapabilities = {
  inventory: true,
  cart: true,
  checkout: true,
  simulated: true,
  sharedInventory: true,
  productLookup: false,
  variants: true,
  orderStatus: false,
  authentication: [{ kind: "none", scopes: [] }],
};
export function productRef(task: Task): ProductRef {
  return {
    productId: task.product,
    ...(task.variantId ? { variantId: task.variantId } : {}),
  };
}
export interface RetailerAdapter {
  readonly id: string;
  readonly capabilities: RetailerCapabilities;
  /** Extra compatibility scope (account/region/scenario). Product and configuration are keyed by the engine. */
  inventoryScope(task: Task): string;
  observe?(task: Task, signal: AbortSignal): Promise<InventoryObservation>;
  createCart?(task: Task, signal: AbortSignal): Promise<CartResult>;
  submitCheckout?(
    task: Task,
    cart: CartResult,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<CheckoutResult>;
  searchProducts?(
    query: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<ProductPage>;
  lookupProduct?(
    identifier: string,
    signal: AbortSignal,
  ): Promise<ProductDetails>;
  lookupOrder?(
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<OrderStatus>;
  /** Compatibility facade for milestone-one consumers. */
  inventory?(task: Task, signal: AbortSignal): Promise<boolean>;
  cart?(task: Task, signal: AbortSignal): Promise<string>;
  checkout?(task: Task, cartId: string, signal: AbortSignal): Promise<void>;
}
export interface RetailerDefinition {
  id: string;
  name: string;
  capabilities: RetailerCapabilities;
  rateLimit: RateLimitPolicy;
  configurationSchema?: z.ZodType<Record<string, unknown>>;
  configurationFields?: ConfigField[];
  create(config: Record<string, unknown>, credential?: string): RetailerAdapter;
}
export class AdapterRegistry {
  private definitions = new Map<string, RetailerDefinition>();
  register(definition: RetailerDefinition) {
    if (
      !/^[a-z0-9-]{1,60}$/.test(definition.id) ||
      this.definitions.has(definition.id)
    )
      throw new Error("Invalid or duplicate retailer registration");
    z.object({
      inventory: z.boolean(),
      cart: z.boolean(),
      checkout: z.boolean(),
      simulated: z.boolean(),
      sharedInventory: z.boolean(),
      productLookup: z.boolean().optional(),
      productSearch: z.boolean().optional(),
      variants: z.boolean().optional(),
      orderStatus: z.boolean().optional(),
      authentication: z.array(
        z
          .object({
            kind: z.enum(["none", "session", "oauth"]),
            scopes: z.array(z.string()),
          })
          .strict(),
      ),
    })
      .strict()
      .parse(definition.capabilities);
    if (
      !definition.capabilities.simulated &&
      (definition.capabilities.cart ||
        definition.capabilities.checkout ||
        definition.capabilities.orderStatus)
    )
      throw new Error("Real adapters must be inventory-only");
    if (
      ![
        "inventory",
        "cart",
        "checkout",
        "productLookup",
        "productSearch",
        "orderStatus",
      ].some(
        (key) =>
          definition.capabilities[key as keyof RetailerCapabilities] === true,
      )
    )
      throw new Error("At least one retailer capability is required");
    if (
      !Number.isInteger(definition.rateLimit.maxConcurrentRequests) ||
      definition.rateLimit.maxConcurrentRequests < 1 ||
      !Number.isFinite(definition.rateLimit.minIntervalMs) ||
      definition.rateLimit.minIntervalMs < 0
    )
      throw new Error("Invalid retailer rate policy");
    this.definitions.set(definition.id, definition);
    return this;
  }
  has(id: string) {
    return this.definitions.has(id);
  }
  get(id: string) {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Retailer is not registered: ${id}`);
    return definition;
  }
  create(
    id: string,
    config: Record<string, unknown> = {},
    credential?: string,
  ) {
    const definition = this.get(id);
    const validated = this.validateConfig(id, config);
    const adapter = definition.create(validated, credential);
    if (
      adapter.id !== id ||
      JSON.stringify(adapter.capabilities) !==
        JSON.stringify(definition.capabilities) ||
      (adapter.capabilities.inventory &&
        typeof adapter.observe !== "function") ||
      typeof adapter.inventoryScope !== "function" ||
      (adapter.capabilities.cart && typeof adapter.createCart !== "function") ||
      (adapter.capabilities.checkout &&
        typeof adapter.submitCheckout !== "function") ||
      (adapter.capabilities.orderStatus &&
        typeof adapter.lookupOrder !== "function") ||
      (adapter.capabilities.productSearch &&
        typeof adapter.searchProducts !== "function") ||
      (adapter.capabilities.productLookup &&
        typeof adapter.lookupProduct !== "function")
    )
      throw new Error("Invalid adapter factory");
    return adapter;
  }
  validateConfig(id: string, config: Record<string, unknown>) {
    return (this.get(id).configurationSchema ?? z.object({}).strict()).parse(
      config,
    );
  }
  list() {
    return [...this.definitions.values()].map(
      ({ id, name, capabilities, rateLimit, configurationFields }) => ({
        id,
        name,
        capabilities,
        rateLimit,
        configurationFields: configurationFields ?? [],
      }),
    );
  }
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
