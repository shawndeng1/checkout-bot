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
    ).toEqual({ node: "undefined", api: ["snapshot", "command", "subscribe"] });
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
      page.getByText("Mock inventory available", { exact: true }),
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
