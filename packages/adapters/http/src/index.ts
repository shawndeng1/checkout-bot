import { z } from "zod";
import {
  RetailerError,
  orderStatusSchema,
  productRef,
  simulatedCapabilities,
  type RetailerAdapter,
  type CartResult,
} from "../../../retailer-sdk/src/index";
import type { Task } from "../../../shared-types/src/index";
const product = z.object({
  productId: z.string(),
  variantId: z.string().optional(),
});
const observation = z.object({
  eventId: z.string(),
  streamId: z.string(),
  retailerId: z.literal("simulator"),
  product,
  sequence: z.number().int().min(0),
  observedAt: z.number().finite(),
  availability: z.enum(["in-stock", "out-of-stock", "unknown"]),
});
const cart = z.object({
  sourceId: z.string(),
  id: z.string(),
  product,
  quantity: z.number().int().positive(),
});
const checkout = z.object({
  orderId: z.string(),
  status: z.literal("completed"),
  idempotencyKey: z.string(),
});
export class HttpSimulatorAdapter implements RetailerAdapter {
  readonly id = "simulator";
  readonly capabilities = { ...simulatedCapabilities, orderStatus: true };
  constructor(
    private baseUrl: string,
    private timeoutMs = 3000,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Simulator must use a loopback HTTP origin");
  }
  inventoryScope() {
    return this.baseUrl;
  }
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    data?: unknown,
    isCheckout = false,
  ): Promise<T> {
    try {
      const response = await fetch(this.baseUrl + path, {
        method: data ? "POST" : "GET",
        headers: data ? { "content-type": "application/json" } : undefined,
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        redirect: "error",
      });
      if (!response.ok) {
        const retryAfterMs = Math.max(
          0,
          Math.min(
            60000,
            Number(response.headers.get("retry-after") ?? 0) * 1000 || 0,
          ),
        );
        throw new RetailerError(
          `Simulator HTTP ${response.status}`,
          response.status === 429
            ? "RATE_LIMIT"
            : response.status === 402
              ? "DECLINED"
              : "NETWORK",
          response.status === 429 || response.status >= 500,
          response.status === 429 ? { retryAfterMs } : undefined,
          isCheckout && response.status >= 500 ? "unknown" : "not-submitted",
        );
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success)
        throw new RetailerError(
          "Invalid simulator response",
          "INVALID_RESPONSE",
          false,
          undefined,
          isCheckout ? "unknown" : "not-submitted",
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof RetailerError) throw error;
      throw new RetailerError(
        error instanceof Error ? error.message : "Simulator network failure",
        "NETWORK",
        !isCheckout,
        undefined,
        isCheckout ? "unknown" : "not-submitted",
      );
    }
  }
  observe(task: Task, signal: AbortSignal) {
    return this.request(
      "/inventory?" + new URLSearchParams({ ...productRef(task) }),
      observation,
      signal,
    );
  }
  createCart(task: Task, signal: AbortSignal) {
    return this.request("/carts", cart, signal, productRef(task));
  }
  submitCheckout(
    _task: Task,
    cartResult: CartResult,
    idempotencyKey: string,
    signal: AbortSignal,
  ) {
    return this.request(
      "/checkout",
      checkout,
      signal,
      { cartId: cartResult.id, idempotencyKey },
      true,
    );
  }
  lookupOrder(idempotencyKey: string, signal: AbortSignal) {
    return this.request(
      "/orders/status?" + new URLSearchParams({ idempotencyKey }),
      orderStatusSchema,
      signal,
    );
  }
  async inventory(task: Task, signal: AbortSignal) {
    return (await this.observe(task, signal)).availability === "in-stock";
  }
  async cart(task: Task, signal: AbortSignal) {
    return (await this.createCart(task, signal)).id;
  }
  async checkout(task: Task, cartId: string, signal: AbortSignal) {
    await this.submitCheckout(
      task,
      { id: cartId, product: productRef(task), quantity: 1 },
      task.runId!,
      signal,
    );
  }
}
