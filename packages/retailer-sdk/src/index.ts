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
}
export interface CartResult {
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
  observe(task: Task, signal: AbortSignal): Promise<InventoryObservation>;
  createCart(task: Task, signal: AbortSignal): Promise<CartResult>;
  submitCheckout(
    task: Task,
    cart: CartResult,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<CheckoutResult>;
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
  create(): RetailerAdapter;
}
export class AdapterRegistry {
  private definitions = new Map<string, RetailerDefinition>();
  register(definition: RetailerDefinition) {
    if (
      !/^[a-z0-9-]{1,60}$/.test(definition.id) ||
      this.definitions.has(definition.id)
    )
      throw new Error("Invalid or duplicate retailer registration");
    if (!definition.capabilities.simulated)
      throw new Error("Only simulated adapters are enabled");
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
  create(id: string) {
    const adapter = this.get(id).create();
    if (adapter.id !== id || !adapter.capabilities.simulated)
      throw new Error("Invalid adapter factory");
    return adapter;
  }
  list() {
    return [...this.definitions.values()].map(
      ({ id, name, capabilities, rateLimit }) => ({
        id,
        name,
        capabilities,
        rateLimit,
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
