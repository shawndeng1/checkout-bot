import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { startShopifyFixture } from "../packages/adapters/shopify/src/fixture";
import { ShopifyInventoryAdapter } from "../packages/adapters/shopify/src/index";
import { Store } from "../packages/database/src/index";
import { Engine } from "../packages/core/src/index";
import { createAdapters } from "../packages/adapters/src/index";
let fixture: Awaited<ReturnType<typeof startShopifyFixture>>,
  store: Store,
  engine: Engine;
beforeEach(async () => {
  fixture = await startShopifyFixture();
  store = await Store.open(":memory:");
  engine = new Engine(store, createAdapters(), 10);
  await engine.configureIntegration("shopify", { endpoint: fixture.url });
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  await fixture.close();
});
const search = (text = "shirt", cursor: string | null = null) =>
  engine.discover({
    requestId: randomUUID(),
    retailerId: "shopify",
    mode: "search",
    text,
    cursor,
    limit: 2,
  });
it("searches authorized products with bounded cursor pages and no cart capability", async () => {
  const one = await search();
  expect(one.products).toHaveLength(2);
  expect(one.nextCursor).toBe("2");
  expect(one.products[0]).toMatchObject({
    title: "Orbit fixture shirt",
    description: expect.stringContaining("Cotton"),
    variantsComplete: false,
  });
  const two = await search("shirt", one.nextCursor);
  const three = await search("shirt", two.nextCursor);
  expect(three.products).toHaveLength(1);
  expect(three.nextCursor).toBeNull();
  expect(
    new Set(
      [...one.products, ...two.products, ...three.products].map(
        (item) => item.id,
      ),
    ).size,
  ).toBe(5);
  expect(fixture.metrics.mutations).toBe(0);
});
it("supports empty search, direct ID/handle lookup, paginated variants and image metadata", async () => {
  expect((await search("missing")).products).toEqual([]);
  fixture.state.variantPageSize = 1;
  fixture.state.image = {
    url: "https://cdn.shopify.com/orbit-fixture.png",
    altText: "Fixture shirt",
  };
  const adapter = new ShopifyInventoryAdapter({ endpoint: fixture.url });
  const product = await adapter.lookupProduct(
    "orbit-shirt",
    new AbortController().signal,
  );
  expect(product.variants).toHaveLength(2);
  expect(product.variants[0].attributes).toContainEqual({
    name: "Color",
    value: "Blue",
  });
  expect(product.image?.alt).toBe("Fixture shirt");
  expect(product.variantsComplete).toBe(true);
  const result = await engine.discover({
    requestId: randomUUID(),
    retailerId: "shopify",
    mode: "lookup",
    text: product.id,
  });
  expect(result.products[0].id).toBe(product.id);
});
it("cancels discovery without blocking commands or delivering stale results", async () => {
  fixture.state.latencyMs = 1000;
  const requestId = randomUUID();
  const pending = engine.discover({
    requestId,
    retailerId: "shopify",
    mode: "search",
    text: "shirt",
  });
  const rejection = expect(pending).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(engine.diagnostics().activeOperations).toBe(1));
  engine.cancelDiscovery(requestId);
  await rejection;
  expect(engine.diagnostics().activeOperations).toBe(0);
  expect(store.snapshot().tasks).toEqual([]);
});
it("handles invalid credentials, throttling and malformed search responses with safe diagnostics", async () => {
  fixture.state.denied = true;
  await expect(search()).rejects.toMatchObject({ code: "AUTH" });
  fixture.state.denied = false;
  fixture.state.invalid = true;
  await expect(search()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  fixture.state.invalid = false;
  fixture.state.throttled = 1;
  expect((await search()).products.length).toBe(2);
  const health = engine.diagnostics();
  expect(health.database.available).toBe(true);
  expect(health.recentErrors.map((row) => row.code)).toContain("AUTH");
  expect(JSON.stringify(health)).not.toContain("profile");
});
it("keeps unsupported adapters usable through manual task identifiers", async () => {
  await expect(
    engine.discover({
      requestId: randomUUID(),
      retailerId: "mock",
      mode: "search",
      text: "shirt",
    }),
  ).rejects.toThrow("does not support");
  const groupId = store.saveGroup({ name: "Direct", retailer: "mock" });
  const id = store.saveTask({
    name: "Direct",
    groupId,
    product: "manual",
    workflow: "MONITOR_ONLY",
    scenario: "available",
    intervalMs: 100,
    maxRetries: 1,
  });
  engine.start(id);
  await engine.stop(id);
  expect(store.task(id).state).toBe("CANCELLED");
});
it("suspends active watches and discovery on credential deletion without exposing or auto-resuming a token", async () => {
  await engine.configureIntegration(
    "shopify",
    { endpoint: fixture.url },
    "fake-secret",
  );
  const groupId = store.saveGroup({ name: "Watches", retailer: "shopify" });
  const id = store.saveTask({
    name: "Watch",
    groupId,
    product: "orbit-shirt",
    workflow: "MONITOR_ONLY",
    scenario: "available",
    intervalMs: 100,
    maxRetries: 1,
  });
  engine.start(id);
  await vi.waitFor(() =>
    expect(store.snapshot().latestInventory).toHaveLength(1),
  );
  await engine.clearCredential("shopify");
  expect(store.task(id).state).toBe("CANCELLED");
  expect(
    engine.snapshot().retailers.find((item) => item.id === "shopify")
      ?.credentialConfigured,
  ).toBe(false);
  expect(JSON.stringify(store.snapshot())).not.toContain("fake-secret");
  expect(engine.diagnostics().subscriptions).toBe(0);
});

it("rejects API-version drift and refuses configuration changes while discovery is running", async () => {
  fixture.state.apiVersion = "2026-10";
  await expect(search()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  fixture.state.apiVersion = "2026-07";
  fixture.state.latencyMs = 1000;
  const requestId = randomUUID();
  const pending = engine.discover({
    requestId,
    retailerId: "shopify",
    mode: "search",
    text: "shirt",
  });
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await expect(
    engine.configureIntegration("shopify", { endpoint: fixture.url }),
  ).rejects.toThrow("Cancel retailer discovery");
  engine.cancelDiscovery(requestId);
  await rejected;
});

it("normalizes Shopify HTTP 429 Retry-After independently of GraphQL throttling", async () => {
  fixture.state.http429 = 1;
  fixture.state.retryAfterMs = 2000;
  const adapter = new ShopifyInventoryAdapter({ endpoint: fixture.url });
  await expect(
    adapter.lookupProduct("orbit-shirt", new AbortController().signal),
  ).rejects.toMatchObject({
    code: "RATE_LIMIT",
    retryable: true,
    rateLimit: { retryAfterMs: 2000 },
  });
});
it("times out a slow authorized inventory read without returning partial data", async () => {
  fixture.state.latencyMs = 5500;
  const adapter = new ShopifyInventoryAdapter({ endpoint: fixture.url });
  await expect(
    adapter.lookupProduct("orbit-shirt", new AbortController().signal),
  ).rejects.toMatchObject({ code: "NETWORK", retryable: true });
}, 15000);
