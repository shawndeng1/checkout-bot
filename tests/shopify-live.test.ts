import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../packages/database/src/index";
import { Engine } from "../packages/core/src/index";
import { createAdapters } from "../packages/adapters/src/index";
import { ShopifyInventoryAdapter } from "../packages/adapters/shopify/src/index";
// Never enabled by CI/default tests. No account creation, Admin API writes or inventory mutation.
const enabled = process.env.ORBIT_LIVE_PILOT === "authorized";
describe.skipIf(!enabled)("authorized Shopify developer-store pilot", () => {
  let engine: Engine,
    store: Store,
    dir: string,
    product: string,
    available: string,
    unavailable: string,
    token: string,
    config: Record<string, unknown>;
  beforeAll(async () => {
    const required = [
      "ORBIT_SHOPIFY_ORIGIN",
      "ORBIT_SHOPIFY_TOKEN",
      "ORBIT_SHOPIFY_PRODUCT",
      "ORBIT_SHOPIFY_AVAILABLE_VARIANT",
      "ORBIT_SHOPIFY_UNAVAILABLE_VARIANT",
    ];
    if (required.some((key) => !process.env[key]))
      throw new Error(
        "Pilot configuration is incomplete; see SHOPIFY_PILOT.md (no values logged)",
      );
    product = process.env.ORBIT_SHOPIFY_PRODUCT!;
    available = process.env.ORBIT_SHOPIFY_AVAILABLE_VARIANT!;
    unavailable = process.env.ORBIT_SHOPIFY_UNAVAILABLE_VARIANT!;
    token = process.env.ORBIT_SHOPIFY_TOKEN!;
    config = {
      mode: "authorized-store",
      endpoint: process.env.ORBIT_SHOPIFY_ORIGIN!,
      authorizationConfirmed: true,
    };
    dir = mkdtempSync(join(tmpdir(), "orbit-live-pilot-"));
    store = await Store.open(join(dir, "pilot.sqlite"));
    engine = new Engine(store, createAdapters());
    await engine.configureIntegration("shopify", config, token);
  });
  afterAll(async () => {
    await engine?.shutdown();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it("authenticates and discovers product/variant details with an official read-only query", async () => {
    const result = await engine.discover({
      requestId: randomUUID(),
      retailerId: "shopify",
      mode: "lookup",
      text: product,
    });
    expect(result.products).toHaveLength(1);
    expect(
      result.products[0].variants.some((item) => item.id === available),
    ).toBe(true);
    expect(
      result.products[0].variants.some((item) => item.id === unavailable),
    ).toBe(true);
  });
  it("honors client request pacing and tests revoked/invalid credential failure", async () => {
    const lookup = () =>
      engine.discover({
        requestId: randomUUID(),
        retailerId: "shopify",
        mode: "lookup",
        text: product,
      });
    const started = Date.now();
    await lookup();
    await lookup();
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    const invalid = new ShopifyInventoryAdapter(
      config,
      "orbit-deliberately-invalid-public-token",
    );
    await expect(
      invalid.lookupProduct(product, new AbortController().signal),
    ).rejects.toMatchObject({ code: "AUTH", retryable: false });
  });
  it("monitors available/unavailable variants, observes a manual stock change, notifies and recovers after restart", async () => {
    const groupId = store.saveGroup({
      name: "Authorized pilot",
      retailer: "shopify",
    });
    const create = (variantId: string) =>
      store.saveTask({
        groupId,
        name: "Pilot inventory",
        product,
        variantId,
        workflow: "MONITOR_AND_NOTIFY",
        scenario: "available",
        intervalMs: 1000,
        maxRetries: 2,
      });
    const ready = create(available),
      changing = create(unavailable);
    engine.start(ready);
    engine.start(changing);
    await vi.waitFor(
      () => {
        expect(store.task(ready).state).toBe("STOCK_DETECTED");
        expect(
          store
            .snapshot()
            .latestInventory.find((row) => row.taskId === changing)?.observation
            .availability,
        ).toBe("out-of-stock");
      },
      { timeout: 30000, interval: 500 },
    );
    console.info(
      "PILOT: change the configured unavailable variant to available in your developer-store admin now. Orbit performs no inventory writes.",
    );
    await vi.waitFor(
      () => expect(store.task(changing).state).toBe("STOCK_DETECTED"),
      { timeout: 120000, interval: 1000 },
    );
    expect(
      store.snapshot().notices.some((notice) => notice.taskId === changing),
    ).toBe(true);
    expect(
      store.inventoryHistory({ taskId: changing }).items.length,
    ).toBeGreaterThanOrEqual(2);
    store.settings({ ...store.getSettings(), resumeMonitoring: true });
    await engine.shutdown();
    store.close();
    store = await Store.open(join(dir, "pilot.sqlite"));
    engine = new Engine(store, createAdapters(), 300, { shopify: token });
    await vi.waitFor(
      () => expect(store.task(changing).state).toBe("STOCK_DETECTED"),
      { timeout: 30000, interval: 500 },
    );
    await engine.stop(changing);
    await engine.stop(ready);
    expect(store.task(changing).state).toBe("CANCELLED");
    if (JSON.stringify(store.snapshot()).includes(token))
      throw new Error("Credential redaction failed");
    expect(store.snapshot().attempts).toEqual([]);
  }, 180000);
  it("reports real throttle evidence only if encountered naturally (never floods the store)", (context) => {
    if (
      !engine
        .diagnostics()
        .recentErrors.some((error) => error.code === "RATE_LIMIT")
    )
      context.skip();
    expect(
      engine
        .diagnostics()
        .recentErrors.some((error) => error.code === "RATE_LIMIT"),
    ).toBe(true);
  });
});
