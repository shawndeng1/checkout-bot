import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { startShopifyFixture } from "../packages/adapters/shopify/src/fixture";
import {
  ShopifyInventoryAdapter,
  shopifyConfig,
} from "../packages/adapters/shopify/src/index";
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
  await engine.configureIntegration("shopify", {
    mode: "fixture",
    endpoint: fixture.url,
  });
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  await fixture.close();
});
function add(variantId: string | null = "gid://shopify/ProductVariant/1") {
  const groupId = store.saveGroup({
    name: "Authorized inventory",
    retailer: "shopify",
  });
  return store.saveTask({
    name: "Shirt",
    groupId,
    product: "orbit-shirt",
    variantId,
    workflow: "MONITOR_AND_NOTIFY",
    scenario: "available",
    intervalMs: 100,
    maxRetries: 2,
  });
}
it("looks up a product by handle or ID and selects independent variants without any purchase methods", async () => {
  const adapter = new ShopifyInventoryAdapter({ endpoint: fixture.url });
  const signal = new AbortController().signal;
  const product = await adapter.lookupProduct("orbit-shirt", signal);
  expect(product.variants.map((v) => v.id)).toEqual([
    "gid://shopify/ProductVariant/1",
    "gid://shopify/ProductVariant/2",
  ]);
  expect((await adapter.lookupProduct(product.id, signal)).title).toBe(
    "Orbit fixture shirt",
  );
  fixture.state.available = true;
  const id = add();
  expect((await adapter.observe(store.task(id), signal)).availability).toBe(
    "in-stock",
  );
  const other = {
    ...store.task(id),
    variantId: "gid://shopify/ProductVariant/2",
  };
  expect((await adapter.observe(other, signal)).availability).toBe(
    "out-of-stock",
  );
  expect("createCart" in adapter).toBe(false);
  expect("submitCheckout" in adapter).toBe(false);
  expect(fixture.metrics.mutations).toBe(0);
});
it("monitors and notifies through the shared pipeline, honoring the integration request floor", async () => {
  const id = add();
  engine.start(id);
  await vi.waitFor(() => expect(store.inventoryHistory().items.length).toBe(1));
  const first = fixture.metrics.queries;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(fixture.metrics.queries).toBe(first);
  fixture.state.available = true;
  await vi.waitFor(() => expect(store.task(id).state).toBe("STOCK_DETECTED"), {
    timeout: 3000,
  });
  expect(store.snapshot().notices).toHaveLength(1);
  expect(store.snapshot().attempts).toHaveLength(0);
  expect(fixture.metrics.mutations).toBe(0);
});
it("honors GraphQL throttling even with HTTP 200 and retries inventory safely", async () => {
  fixture.state.throttled = 1;
  const id = add();
  engine.start(id);
  await vi.waitFor(() =>
    expect(
      store.snapshot().logs.some((row) => row.message.includes("retry")),
    ).toBe(true),
  );
  const first = fixture.metrics.queries;
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(fixture.metrics.queries).toBe(first);
  await vi.waitFor(
    () => expect(store.snapshot().latestInventory.length).toBe(1),
    { timeout: 3000 },
  );
});
it("normalizes missing products, missing variants, permissions, invalid responses and cancellation", async () => {
  const adapter = new ShopifyInventoryAdapter({ endpoint: fixture.url });
  const signal = new AbortController().signal;
  await expect(adapter.lookupProduct("missing", signal)).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    retryable: false,
  });
  const id = add("missing");
  await expect(adapter.observe(store.task(id), signal)).rejects.toThrow(
    "Variant not found",
  );
  fixture.state.denied = true;
  await expect(
    adapter.lookupProduct("orbit-shirt", signal),
  ).rejects.toMatchObject({ code: "AUTH", retryable: false });
  fixture.state.denied = false;
  fixture.state.invalid = true;
  await expect(
    adapter.lookupProduct("orbit-shirt", signal),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  fixture.state.invalid = false;
  fixture.state.latencyMs = 1000;
  const controller = new AbortController();
  const pending = adapter.lookupProduct("orbit-shirt", controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    code: "NETWORK",
    retryable: false,
  });
});
it("requires confirmed authorized HTTPS stores and never saves credentials in public configuration or snapshots", async () => {
  for (const endpoint of [
    "https://example.com",
    "http://test.myshopify.com",
    "https://user:secret@test.myshopify.com",
    "https://test.myshopify.com/path",
    "https://test.myshopify.com?token=secret",
  ]) {
    expect(
      shopifyConfig.safeParse({
        mode: "authorized-store",
        endpoint,
        authorizationConfirmed: true,
      }).success,
    ).toBe(false);
  }
  expect(
    shopifyConfig.safeParse({
      mode: "fixture",
      endpoint: "https://remote.example",
    }).success,
  ).toBe(false);
  expect(
    () =>
      new ShopifyInventoryAdapter({
        mode: "authorized-store",
        endpoint: "https://orbit-dev.myshopify.com",
        authorizationConfirmed: true,
      }),
  ).toThrow("token required");
  await expect(
    engine.configureIntegration("shopify", {
      endpoint: fixture.url,
      token: "secret",
    }),
  ).rejects.toThrow();
  await engine.configureIntegration(
    "shopify",
    {
      mode: "authorized-store",
      endpoint: "https://orbit-dev.myshopify.com",
      authorizationConfirmed: true,
    },
    "test-secret-never-persist",
  );
  expect(
    engine.snapshot().retailers.find((row) => row.id === "shopify")
      ?.credentialConfigured,
  ).toBe(true);
  expect(JSON.stringify(engine.snapshot())).not.toContain(
    "test-secret-never-persist",
  );
  expect(JSON.stringify(store.retailerConfig("shopify"))).not.toContain(
    "test-secret-never-persist",
  );
});
it("prevents checkout workflows on the real inventory adapter and prevents reconfiguration while monitoring", async () => {
  const id = add();
  const { state, runId, updatedAt, ...task } = store.task(id);
  await expect(
    engine.command({
      type: "saveTask",
      data: { ...task, workflow: "MONITOR_AND_CHECKOUT" },
    }),
  ).rejects.toThrow("inventory workflows only");
  engine.start(id);
  await expect(
    engine.configureIntegration("shopify", { endpoint: fixture.url }),
  ).rejects.toThrow("Stop retailer tasks");
});

it("pauses recovery without crashing when secure credentials are unavailable after restart", async () => {
  const id = add();
  store.settings({ ...store.getSettings(), resumeMonitoring: true });
  store.begin(id);
  await engine.shutdown();
  store.saveRetailerConfig("shopify", {
    mode: "authorized-store",
    endpoint: "https://orbit-dev.myshopify.com",
    authorizationConfirmed: true,
  });
  engine = new Engine(store, createAdapters(), 10);
  expect(store.task(id).state).toBe("CANCELLED");
  expect(engine.isBusy(id)).toBe(false);
  expect(store.snapshot().logs[0].message).toContain("secure credentials");
  expect(fixture.metrics.queries).toBe(0);
});
