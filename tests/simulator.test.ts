import { it, expect } from "vitest";
import { startSimulator } from "../packages/simulator/src/index";
import { HttpSimulatorAdapter } from "../packages/adapters/http/src/index";
import {
  AdapterRegistry,
  simulatedCapabilities,
} from "../packages/retailer-sdk/src/index";
import { Store } from "../packages/database/src/index";
async function fixture() {
  const server = await startSimulator();
  const store = await Store.open(":memory:");
  const groupId = store.saveGroup({ name: "HTTP", retailer: "simulator" });
  const id = store.saveTask({
    name: "HTTP task",
    product: "SKU-42",
    groupId,
    scenario: "available",
    intervalMs: 100,
    maxRetries: 2,
  });
  const task = store.task(id);
  const adapter = new HttpSimulatorAdapter(server.url);
  const control = async (path: string, data: unknown) => {
    const response = await fetch(server.url + "/control/" + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    });
    expect(response.ok).toBe(true);
  };
  return {
    server,
    store,
    task,
    adapter,
    control,
    signal: new AbortController().signal,
    async close() {
      store.close();
      await server.close();
    },
  };
}
it("serves catalog variants, inventory changes, carts and idempotent simulated orders", async () => {
  const f = await fixture();
  try {
    expect(
      (await (await fetch(f.server.url + "/catalog")).json())[0].variants,
    ).toHaveLength(2);
    expect((await f.adapter.observe(f.task, f.signal)).availability).toBe(
      "out-of-stock",
    );
    await f.control("inventory", { productId: "SKU-42", available: true });
    const observation = await f.adapter.observe(f.task, f.signal);
    expect(observation.availability).toBe("in-stock");
    expect(observation.sequence).toBe(2);
    const cart = await f.adapter.createCart(f.task, f.signal);
    const one = await f.adapter.submitCheckout(
      f.task,
      cart,
      "idempotent-order",
      f.signal,
    );
    const two = await f.adapter.submitCheckout(
      f.task,
      cart,
      "idempotent-order",
      f.signal,
    );
    expect(two).toEqual(one);
    expect(f.server.metrics.ordersCreated).toBe(1);
    const other = await f.adapter.createCart(f.task, f.signal);
    await expect(
      f.adapter.submitCheckout(f.task, other, "idempotent-order", f.signal),
    ).rejects.toMatchObject({ retryable: false });
  } finally {
    await f.close();
  }
});
it("normalizes rate limiting, failures, definite declines, and unknown checkout outcomes", async () => {
  const f = await fixture();
  try {
    await f.control("config", { rateLimitNext: 1, retryAfterMs: 50 });
    await expect(f.adapter.observe(f.task, f.signal)).rejects.toMatchObject({
      code: "RATE_LIMIT",
      retryable: true,
      rateLimit: { retryAfterMs: 50 },
    });
    await f.control("config", { failNext: 1 });
    await expect(f.adapter.observe(f.task, f.signal)).rejects.toMatchObject({
      code: "NETWORK",
      retryable: true,
    });
    await f.control("inventory", { productId: "SKU-42", available: true });
    const cart = await f.adapter.createCart(f.task, f.signal);
    await f.control("config", { checkoutFailure: true });
    await expect(
      f.adapter.submitCheckout(f.task, cart, "decline", f.signal),
    ).rejects.toMatchObject({ code: "DECLINED", outcome: "not-submitted" });
    await f.control("config", {
      checkoutFailure: false,
      dropCheckoutResponse: true,
    });
    await expect(
      f.adapter.submitCheckout(f.task, cart, "lost-response", f.signal),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(f.server.metrics.ordersCreated).toBe(1);
  } finally {
    await f.close();
  }
});
it("supports cancellation/timeouts and rejects external simulator URLs and browser requests", async () => {
  const f = await fixture();
  try {
    expect(() => new HttpSimulatorAdapter("https://example.com")).toThrow(
      "loopback",
    );
    expect(() => new HttpSimulatorAdapter("http://127.0.0.1:80/path")).toThrow(
      "loopback",
    );
    expect(
      (
        await fetch(f.server.url + "/catalog", {
          headers: { origin: "https://example.com" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(f.server.url + "/control/metrics")).status).toBe(403);
    await f.control("config", { latencyMs: 100 });
    const adapter = new HttpSimulatorAdapter(f.server.url, 10);
    await expect(adapter.observe(f.task, f.signal)).rejects.toMatchObject({
      code: "NETWORK",
    });
  } finally {
    await f.close();
  }
});
it("registers adapters with capability and rate-policy validation", () => {
  const definition = {
    id: "other",
    name: "Other",
    capabilities: simulatedCapabilities,
    rateLimit: { minIntervalMs: 10, maxConcurrentRequests: 1 },
    create: () => ({}) as any,
  };
  const registry = new AdapterRegistry().register(definition);
  expect(registry.list()[0].id).toBe("other");
  expect(() => registry.register(definition)).toThrow("duplicate");
  expect(() => registry.get("missing")).toThrow("not registered");
  expect(() => registry.create("other")).toThrow("factory");
  expect(() =>
    new AdapterRegistry().register({
      ...definition,
      capabilities: { ...simulatedCapabilities, simulated: false },
    }),
  ).toThrow("inventory-only");
});
