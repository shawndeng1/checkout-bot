import {
  AdapterError,
  delay,
  type RetailerAdapter,
} from "../../../retailer-sdk/src/index";
import type { Task } from "../../../shared-types/src/index";
export class MockAdapter implements RetailerAdapter {
  readonly id = "mock";
  readonly capabilities = {
    inventory: true,
    cart: true,
    checkout: true,
    simulated: true,
  };
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
