import type { Task } from "../../shared-types/src/index";
export class AdapterError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}
export interface RetailerAdapter {
  readonly id: string;
  readonly capabilities: {
    inventory: boolean;
    cart: boolean;
    checkout: boolean;
    simulated: boolean;
  };
  inventory(task: Task, signal: AbortSignal): Promise<boolean>;
  cart(task: Task, signal: AbortSignal): Promise<string>;
  checkout(task: Task, cartId: string, signal: AbortSignal): Promise<void>;
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
