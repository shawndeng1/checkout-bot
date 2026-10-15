import {
  AdapterError,
  simulatedCapabilities,
  productRef,
  type CartResult,
  type CheckoutResult,
  delay,
  type RetailerAdapter,
} from "../../../retailer-sdk/src/index";
import type { Task } from "../../../shared-types/src/index";
export class MockAdapter implements RetailerAdapter {
  readonly id = "mock";
  readonly capabilities = simulatedCapabilities;
  inventoryScope(task: Task) {
    return task.scenario === "checkout-failure" ? "available" : task.scenario;
  }
  async observe(task: Task, signal: AbortSignal) {
    const available = await this.inventory(task, signal);
    return {
      eventId: `mock-${this.polls}`,
      streamId: "mock",
      retailerId: this.id,
      product: productRef(task),
      sequence: this.polls,
      observedAt: Date.now(),
      availability: available
        ? ("in-stock" as const)
        : ("out-of-stock" as const),
    };
  }
  async createCart(task: Task, signal: AbortSignal): Promise<CartResult> {
    return {
      id: await this.cart(task, signal),
      product: productRef(task),
      quantity: 1,
    };
  }
  async submitCheckout(
    task: Task,
    cart: CartResult,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<CheckoutResult> {
    await this.checkout(task, cart.id, signal);
    return {
      orderId: `mock-order-${idempotencyKey}`,
      status: "completed",
      idempotencyKey,
    };
  }
  private polls = 0;
  async inventory(task: Task, signal: AbortSignal) {
    await delay(task.intervalMs, signal);
    this.polls++;
    if (task.scenario === "timeout")
      throw new AdapterError("Simulated network timeout", true);
    if (task.scenario === "rate-limit" && this.polls <= 2)
      throw new AdapterError("Simulated rate limit", true);
    return task.scenario !== "out-of-stock" && this.polls >= 3;
  }
  async cart(task: Task, signal: AbortSignal) {
    await delay(task.intervalMs, signal);
    return `mock-cart-${task.id}`;
  }
  async checkout(task: Task, _cartId: string, signal: AbortSignal) {
    await delay(task.intervalMs, signal);
    if (task.scenario === "checkout-failure")
      throw new AdapterError("Simulated checkout declined", false);
  }
}
