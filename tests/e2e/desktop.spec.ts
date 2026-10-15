import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("desktop CRUD, live events, stop, logs and restart persistence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-e2e-"));
  let app: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      args: ["dist/electron/main.cjs"],
      env: { ...process.env, RETAIL_DATA_DIR: dir },
    });
  try {
    app = await launch();
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    // Security contract is checked in the actual renderer.
    expect(
      await page.evaluate(() => ({
        node: typeof (window as any).require,
        api: Object.keys(window.retail),
      })),
    ).toEqual({
      node: "undefined",
      api: [
        "discover",
        "cancelDiscovery",
        "history",
        "diagnostics",
        "credentialStatus",
        "deleteCredential",
        "configureIntegration",
        "snapshot",
        "command",
        "subscribe",
      ],
    });
    await page
      .getByRole("button", { name: "Tasks", exact: false })
      .first()
      .click();
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("Group name").fill("Integration group");
    await page.getByRole("button", { name: "Save group" }).click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Task name").fill("Inventory watch");
    await page.getByLabel("Product identifier").fill("TEST-SKU");
    await page.getByLabel("Monitor interval").fill("100");
    await page.getByRole("button", { name: "Save task" }).click();
    await page
      .getByRole("button", { name: "Edit Inventory watch", exact: true })
      .click();
    await page.getByLabel("Task name").fill("Edited watch");
    await page.getByRole("button", { name: "Save task" }).click();
    await page
      .getByRole("button", { name: "Duplicate Edited watch", exact: true })
      .click();
    await expect(
      page.getByText("Edited watch copy", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Start Edited watch", exact: true })
      .click();
    await expect(
      page.getByText("awaiting approval", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("completed", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Logs Edited watch", exact: true })
      .click();
    await expect(
      page.getByText("Inventory available", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Simulation completed; no purchase was made", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close logs" }).click();
    await page
      .getByRole("button", { name: "Start Edited watch copy", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Stop Edited watch copy", exact: true })
      .click();
    await expect(page.getByText("cancelled", { exact: true })).toBeVisible();
    page.on("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Delete Edited watch copy", exact: true })
      .click();
    await expect(
      page.getByText("Edited watch copy", { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: "test-results/desktop-tasks.png",
      fullPage: true,
    });
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened
      .getByRole("button", { name: "Tasks", exact: false })
      .first()
      .click();
    await expect(
      reopened.getByRole("button", {
        name: "Integration group Mock Retailer",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      reopened.getByText("Edited watch", { exact: true }),
    ).toBeVisible();
    await expect(
      reopened.getByText("completed", { exact: true }),
    ).toBeVisible();
    await reopened
      .getByRole("button", { name: "Dashboard", exact: true })
      .click();
    await reopened.screenshot({
      path: "test-results/desktop-dashboard.png",
      fullPage: true,
    });
  } finally {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("profile, proxy and preference forms persist validated configurations", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-forms-"));
  const app = await electron.launch({
    args: ["dist/electron/main.cjs"],
    env: { ...process.env, RETAIL_DATA_DIR: dir },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await page.getByRole("button", { name: "New profile" }).click();
    await page.getByLabel("Profile name").fill("Home profile");
    await page.getByLabel("Profile group").fill("Family");
    await page.getByLabel("Email", { exact: true }).fill("alex@example.com");
    await page.getByLabel("Shipping address").fill("1 Example Street");
    await page.getByLabel("City", { exact: true }).fill("Toronto");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Home profile", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Edit profile Home profile", exact: true })
      .click();
    await page.getByLabel("City", { exact: true }).fill("Ottawa");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText(/1 Example Street, Ottawa/)).toBeVisible();
    await page.getByRole("button", { name: "Proxies", exact: true }).click();
    await page.getByRole("button", { name: "New proxy" }).click();
    await page.getByLabel("Proxy name").fill("Local SOCKS");
    await page.getByLabel("Protocol", { exact: true }).selectOption("socks5");
    await page.getByLabel("Hostname").fill("127.0.0.1");
    await page.getByLabel("Port", { exact: true }).fill("1080");
    await page.getByRole("button", { name: "Save proxy" }).click();
    await expect(
      page.getByText("127.0.0.1:1080", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit proxy Local SOCKS" }).click();
    await page.getByLabel("Port", { exact: true }).fill("1081");
    await page.getByRole("button", { name: "Save proxy" }).click();
    await expect(
      page.getByText("127.0.0.1:1081", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Task concurrency").fill("2");
    await page.getByLabel("Completion notifications").check();
    await page.getByLabel("Logging detail").selectOption("debug");
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(
      page.getByText("Preferences saved", { exact: true }),
    ).toBeVisible();
    const saved = await page.evaluate(() => window.retail.snapshot());
    expect(saved.profiles[0].city).toBe("Ottawa");
    expect(saved.proxies[0].port).toBe(1081);
    expect(saved.settings).toMatchObject({
      concurrency: 2,
      notifications: true,
      logLevel: "debug",
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await page
      .getByRole("button", { name: "Delete profile Home profile" })
      .click();
    await expect(page.getByText("Home profile", { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Proxies", exact: true }).click();
    await page
      .getByRole("button", { name: "Delete proxy Local SOCKS" })
      .click();
    await expect(page.getByText("Local SOCKS", { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("development renderer launches with the secure preload bridge", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: "apps/desktop/vite.config.ts",
  });
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-dev-"));
  let app: ElectronApplication | undefined;
  try {
    await server.listen();
    app = await electron.launch({
      args: ["dist/electron/main.cjs"],
      env: {
        ...process.env,
        RETAIL_DATA_DIR: dir,
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await expect(
      page.getByText("Connecting to local workspace…", { exact: true }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => window.retail.snapshot())).toMatchObject({
      tasks: [],
      groups: [],
    });
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval waits release capacity and survive a full desktop restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-approval-e2e-"));
  let app: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      args: ["dist/electron/main.cjs"],
      env: { ...process.env, RETAIL_DATA_DIR: dir },
    });
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page.evaluate(async () => {
      let data = await window.retail.snapshot();
      await window.retail.command({
        type: "settings",
        data: { ...data.settings, concurrency: 1 },
      });
      data = await window.retail.command({
        type: "saveGroup",
        data: { name: "Approval group", retailer: "mock" },
      });
      const groupId = data.groups[0].id;
      for (let i = 0; i < 3; i++)
        await window.retail.command({
          type: "saveTask",
          data: {
            name: `Approval ${i}`,
            product: "shared",
            variantId: null,
            groupId,
            profileId: null,
            proxyId: null,
            scenario: "available",
            intervalMs: 100,
            maxRetries: 2,
          },
        });
    });
    await page
      .getByRole("button", { name: "Tasks", exact: false })
      .first()
      .click();
    await expect(page.getByText("Approval 2", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select all tasks" }).check();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toHaveCount(3);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Tasks", exact: false })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toHaveCount(3);
    for (let i = 0; i < 3; i++)
      await page
        .getByRole("row")
        .filter({ hasText: `Approval ${i}` })
        .getByRole("button", { name: "Approve", exact: true })
        .click();
    await expect(page.getByText("completed", { exact: true })).toHaveCount(3);
  } finally {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registers the local HTTP adapter and completes a variant workflow through the existing UI", async () => {
  const { startSimulator } = await import("../../packages/simulator/src/index");
  const simulator = await startSimulator();
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-http-e2e-"));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: ["dist/electron/main.cjs"],
      env: {
        ...process.env,
        RETAIL_DATA_DIR: dir,
        ORBIT_SIMULATOR_URL: simulator.url,
      },
    });
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Tasks", exact: false })
      .first()
      .click();
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("Group name").fill("HTTP group");
    await page
      .getByLabel("Retailer", { exact: true })
      .selectOption("simulator");
    await page.getByRole("button", { name: "Save group" }).click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Task name").fill("HTTP variant");
    await page.getByLabel("Product identifier", { exact: true }).fill("SKU-42");
    await page.getByLabel("Variant identifier").fill("blue");
    await page.getByLabel("Monitor interval").fill("100");
    await page.getByRole("button", { name: "Save task" }).click();
    await page
      .getByRole("button", { name: "Start HTTP variant", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("completed", { exact: true })).toBeVisible();
    expect(simulator.metrics.ordersCreated).toBe(1);
  } finally {
    await app?.close();
    await simulator.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inventory-only integration configuration, continuous variant monitoring, notifications and restart", async () => {
  const { startShopifyFixture } =
    await import("../../packages/adapters/shopify/src/fixture");
  const fixture = await startShopifyFixture();
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-inventory-ui-"));
  let app: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      args: ["dist/electron/main.cjs"],
      env: { ...process.env, RETAIL_DATA_DIR: dir },
    });
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Store / fixture origin").fill(fixture.url);
    await page.getByRole("button", { name: "Save integration" }).click();
    await expect(
      page.getByText("Integration saved", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Resume interrupted monitoring").check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await page
      .getByRole("button", { name: "Tasks", exact: false })
      .first()
      .click();
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("Group name").fill("Fixture watches");
    await page.getByLabel("Retailer", { exact: true }).selectOption("shopify");
    await page.getByRole("button", { name: "Save group" }).click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Task name").fill("Blue shirt");
    await page
      .getByLabel("Product identifier", { exact: true })
      .fill("orbit-shirt");
    await page
      .getByLabel("Variant identifier")
      .fill("gid://shopify/ProductVariant/1");
    await page
      .getByLabel("Workflow", { exact: true })
      .selectOption("MONITOR_AND_NOTIFY");
    await page.getByLabel("Monitor interval").fill("100");
    await page.getByRole("button", { name: "Save task" }).click();
    await page
      .getByRole("button", { name: "Start Blue shirt", exact: true })
      .click();
    await page.getByRole("button", { name: "Inventory", exact: true }).click();
    await expect(page.getByText("out-of-stock", { exact: true })).toBeVisible();
    fixture.state.available = true;
    await expect(page.getByText("in-stock", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Inventory notifications",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page
        .getByText("Orbit fixture shirt / Blue is available", { exact: true })
        .last(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop Blue shirt", exact: true }),
    ).toBeVisible();
    const data = await page.evaluate(() => window.retail.snapshot());
    expect(data.notices).toHaveLength(1);
    expect(data.attempts).toEqual([]);
    await page.screenshot({
      path: "test-results/inventory.png",
      fullPage: true,
    });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Inventory", exact: true }).click();
    await expect(page.getByText("in-stock", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Stop Blue shirt", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Start Blue shirt", exact: true }),
    ).toBeVisible();
    expect(fixture.metrics.mutations).toBe(0);
  } finally {
    await app?.close();
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation UI resolves a lost simulated checkout response after restart without resubmission", async () => {
  const { startSimulator } = await import("../../packages/simulator/src/index");
  const simulator = await startSimulator();
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-reconcile-ui-"));
  let app: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      args: ["dist/electron/main.cjs"],
      env: {
        ...process.env,
        RETAIL_DATA_DIR: dir,
        ORBIT_SIMULATOR_URL: simulator.url,
      },
    });
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page.evaluate(async () => {
      let data = await window.retail.command({
        type: "saveGroup",
        data: { name: "Uncertain", retailer: "simulator" },
      });
      data = await window.retail.command({
        type: "saveTask",
        data: {
          name: "Lost response",
          product: "SKU-42",
          variantId: "blue",
          groupId: data.groups[0].id,
          scenario: "available",
          intervalMs: 100,
          maxRetries: 1,
        },
      });
      await window.retail.command({ type: "start", id: data.tasks[0].id });
    });
    await page
      .getByRole("button", { name: "Tasks", exact: false })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeVisible();
    await fetch(simulator.url + "/control/config", {
      method: "POST",
      headers: {
        authorization: `Bearer ${simulator.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ dropCheckoutResponse: true }),
    });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(
      page.getByText("unknown outcome", { exact: true }),
    ).toBeVisible();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Reconciliation", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Lost response", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Submitted", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Check Order Status", exact: true })
      .click();
    await expect(
      page.getByText("completed", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText(/Confirmed order/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Check Order Status", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: "test-results/reconciliation.png",
      fullPage: true,
    });
    expect(simulator.metrics.checkoutRequests).toBe(1);
    expect(simulator.metrics.ordersCreated).toBe(1);
  } finally {
    await app?.close();
    await simulator.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovers products, selects a variant, creates a watch, pages history and exposes diagnostics and credential deletion", async () => {
  const { startShopifyFixture } =
    await import("../../packages/adapters/shopify/src/fixture");
  const fixture = await startShopifyFixture();
  fixture.state.catalogSize = 15;
  fixture.state.image = {
    url: "https://cdn.shopify.com/orbit-fixture.png",
    altText: "Fixture shirt",
  };
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-discovery-ui-"));
  const app = await electron.launch({
    args: ["dist/electron/main.cjs"],
    env: { ...process.env, RETAIL_DATA_DIR: dir },
  });
  try {
    const page = await app.firstWindow();
    await page.route("https://cdn.shopify.com/orbit-fixture.png", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    await expect(
      page.getByRole("heading", { name: "Workspace overview" }),
    ).toBeVisible();
    await page.evaluate(async (endpoint) => {
      const data = await window.retail.configureIntegration({
        retailerId: "shopify",
        config: { endpoint },
      });
      return data.revision;
    }, fixture.url);
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    await page.getByLabel("Product search or identifier").fill("shirt");
    await page
      .getByRole("button", { name: "Search products", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Orbit fixture shirt", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Fixture shirt" }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Next products", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Orbit fixture shirt 13",
        exact: true,
      }),
    ).toBeVisible();
    fixture.state.latencyMs = 1000;
    const before = fixture.metrics.queries;
    await page.getByLabel("Product search or identifier").fill("shirt");
    await page
      .getByRole("button", { name: "Search products", exact: true })
      .click();
    await expect.poll(() => fixture.metrics.queries).toBeGreaterThan(before);
    await page
      .getByRole("button", { name: "Cancel discovery", exact: true })
      .click();
    fixture.state.latencyMs = 0;
    await page.getByLabel("Product search or identifier").fill("orbit-shirt");
    await page
      .getByRole("button", { name: "Look up identifier", exact: true })
      .click();
    await expect(page.getByLabel("Monitoring variant")).toBeVisible();
    await page
      .getByLabel("Monitoring variant")
      .selectOption("gid://shopify/ProductVariant/1");
    await page.getByLabel("New monitoring group").fill("Discovered watches");
    await page.getByLabel("Discovery monitoring interval (ms)").fill("100");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "test-results/discovery.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Create monitoring task", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Inventory", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Start Orbit fixture shirt · Blue",
        exact: true,
      })
      .click();
    await expect(page.getByText("out-of-stock", { exact: true })).toBeVisible();
    fixture.state.available = true;
    await expect(page.getByText("in-stock", { exact: true })).toBeVisible();
    await page.getByLabel("Search monitoring tasks").fill("no-match");
    await expect(
      page.getByRole("button", {
        name: "Stop Orbit fixture shirt · Blue",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByLabel("Search monitoring tasks").fill("shirt");
    await expect(
      page.getByRole("button", {
        name: "Stop Orbit fixture shirt · Blue",
        exact: true,
      }),
    ).toBeVisible();
    await page.evaluate(async () => {
      let data = await window.retail.command({
        type: "saveGroup",
        data: { name: "History pagination", retailer: "mock" },
      });
      const groupId = data.groups.find(
        (group) => group.name === "History pagination",
      )!.id;
      for (let i = 0; i < 22; i++) {
        data = await window.retail.command({
          type: "saveTask",
          data: {
            name: `History ${i}`,
            groupId,
            product: "history-product",
            workflow: "MONITOR_ONLY",
            scenario: "out-of-stock",
            intervalMs: 100,
            maxRetries: 1,
          },
        });
        await window.retail.command({
          type: "start",
          id: data.tasks.at(-1)!.id,
        });
      }
    });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.retail.history({ limit: 100 })))
            .items.length,
      )
      .toBeGreaterThan(20);
    await page
      .getByRole("button", { name: "Refresh history", exact: true })
      .click();
    await expect(page.getByText(/Page 1 · 20 observations/)).toBeVisible();
    await page
      .getByRole("button", { name: "Next history", exact: true })
      .click();
    await expect(page.getByText(/Page 2 · 20 observations/)).toBeVisible();
    await page
      .getByRole("button", { name: "Previous history", exact: true })
      .click();
    await expect(page.getByText(/Page 1 · 20 observations/)).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Worker diagnostics", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Available", { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Delete credential", exact: true })
      .click();
    await expect(
      page.getByText("Credential deleted; monitoring stopped", { exact: true }),
    ).toBeVisible();
    const data = await page.evaluate(() => window.retail.snapshot());
    expect(
      data.tasks.find((task) => task.name === "Orbit fixture shirt · Blue")
        ?.state,
    ).toBe("CANCELLED");
    expect(data.inventory).toEqual([]);
    expect(
      (await page.evaluate(() => window.retail.history({ limit: 1 }))).items,
    ).toHaveLength(1);
    expect(fixture.metrics.mutations).toBe(0);
  } finally {
    await app.close();
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
