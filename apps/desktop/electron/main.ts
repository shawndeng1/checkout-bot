import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  Notification,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BackendClient } from "./backend-client";
import { CredentialVault } from "./credential-vault";
import {
  commandSchema,
  integrationInputSchema,
  discoverySchema,
  historySchema,
} from "../../../packages/shared-types/src/index";
import { z, ZodError } from "zod";
app.setName("OrbitRetail");
let engine: BackendClient;
let window: BrowserWindow | null = null;
let quitting = false;
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const vault = new CredentialVault(
        path.join(
          process.env.RETAIL_DATA_DIR || app.getPath("userData"),
          "credentials.enc.json",
        ),
        safeStorage,
      );
      let credentials: Record<string, string> = {};
      try {
        credentials = await vault.load();
      } catch {
        console.error(
          "Credential store unavailable; inventory integration requires reconfiguration",
        );
      }
      engine = new BackendClient(
        path.join(__dirname, "backend-worker.cjs"),
        path.join(
          process.env.RETAIL_DATA_DIR || app.getPath("userData"),
          "retail.sqlite",
        ),
        credentials,
      );
      engine.on("failure", (error) => {
        console.error("Backend unavailable; restart Orbit to recover safely");
      });
      engine.on("native-notification", (notice) => {
        if (Notification.isSupported())
          try {
            new Notification({
              title: "Orbit inventory",
              body: notice.message,
            }).show();
          } catch {
            /* In-app history remains available. */
          }
      });
      await engine.ready;
      let operations = Promise.resolve();
      const serialize = <T>(action: () => Promise<T>): Promise<T> => {
        const next = operations.then(action);
        operations = next.then(
          () => {},
          () => {},
        );
        return next;
      };
      const renderer = pathToFileURL(
        path.join(__dirname, "../renderer/index.html"),
      ).href;
      const dev =
        process.env.VITE_DEV_SERVER_URL === "http://127.0.0.1:5173"
          ? process.env.VITE_DEV_SERVER_URL
          : undefined;
      const trusted = (event: Electron.IpcMainInvokeEvent) => {
        const url = event.senderFrame?.url;
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !(url === renderer || (dev && url === dev + "/"))
        )
          throw new Error("Untrusted IPC sender");
      };
      ipcMain.handle("retail:snapshot", (event) => {
        trusted(event);
        return engine.snapshot();
      });
      ipcMain.handle("retail:command", async (event, input) => {
        trusted(event);
        try {
          const parsed = commandSchema.parse(input);
          return parsed.type === "reconcile"
            ? await engine.command(parsed)
            : await serialize(() => engine.command(parsed));
        } catch (error) {
          if (error instanceof ZodError)
            throw new Error(
              error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; "),
            );
          throw error;
        }
      });
      ipcMain.handle("retail:configure", (event, input) => {
        trusted(event);
        const parsed = integrationInputSchema.parse(input);
        return serialize(async () => {
          if (parsed.credential !== undefined)
            await engine.suspendRetailer(parsed.retailerId);
          await engine.configureIntegration(parsed, true);
          const checkpoint =
            parsed.credential !== undefined
              ? await vault.checkpoint()
              : undefined;
          const updated =
            parsed.credential !== undefined
              ? { ...credentials, [parsed.retailerId]: parsed.credential }
              : credentials;
          if (parsed.credential !== undefined)
            await vault.replace(parsed.retailerId, parsed.credential);
          try {
            const next = await engine.configureIntegration(parsed);
            credentials = updated;
            return next;
          } catch (error) {
            if (checkpoint) await vault.restore(checkpoint);
            throw error;
          }
        });
      });
      const retailerId = z.string().regex(/^[a-z0-9-]{1,60}$/);
      ipcMain.handle("retail:discover", (event, input) => {
        trusted(event);
        return engine.discover(discoverySchema.parse(input));
      });
      ipcMain.handle("retail:cancel-discovery", (event, id) => {
        trusted(event);
        return engine.cancelDiscovery(z.string().uuid().parse(id));
      });
      ipcMain.handle("retail:history", (event, input) => {
        trusted(event);
        return engine.history(historySchema.parse(input));
      });
      ipcMain.handle("retail:diagnostics", (event) => {
        trusted(event);
        return engine.diagnostics();
      });
      ipcMain.handle("retail:credential-status", async (event) => {
        trusted(event);
        const data = await engine.snapshot();
        let encrypted: Record<string, string> = {};
        let unreadable = false;
        try {
          encrypted = await vault.checkpoint();
        } catch {
          unreadable = true;
        }
        return {
          encryptionAvailable: vault.encryptionAvailable(),
          loadFailed:
            unreadable || Object.keys(encrypted).some((id) => !credentials[id]),
          entries: data.retailers
            .filter((retailer) =>
              retailer.capabilities.authentication.some(
                (auth) => auth.kind !== "none",
              ),
            )
            .map((retailer) => ({
              retailerId: retailer.id,
              status: credentials[retailer.id]
                ? "available"
                : encrypted[retailer.id] || unreadable
                  ? "inaccessible"
                  : "missing",
            })),
        };
      });
      ipcMain.handle("retail:delete-credential", (event, input) => {
        trusted(event);
        const id = retailerId.parse(input);
        return serialize(async () => {
          const data = await engine.snapshot();
          if (
            !data.retailers
              .find((retailer) => retailer.id === id)
              ?.capabilities.authentication.some((auth) => auth.kind !== "none")
          )
            throw new Error("Retailer has no credential configuration");
          await engine.suspendRetailer(id);
          await vault.remove(id);
          delete credentials[id];
          return engine.clearCredential(id);
        });
      });
      engine.on("snapshot", (snapshot) => {
        if (window && !window.isDestroyed())
          window.webContents.send("retail:update", snapshot);
      });
      function createWindow() {
        window = new BrowserWindow({
          width: 1440,
          height: 940,
          minWidth: 1100,
          minHeight: 720,
          backgroundColor: "#101117",
          title: "Orbit · Retail Workspace",
          webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) =>
          event.preventDefault(),
        );
        window.webContents.on("will-attach-webview", (event) =>
          event.preventDefault(),
        );
        window.webContents.session.setPermissionRequestHandler(
          (_contents, _permission, callback) => callback(false),
        );
        window.on("closed", () => {
          window = null;
        });
        if (dev) void window.loadURL(dev);
        else
          void window.loadFile(path.join(__dirname, "../renderer/index.html"));
      }
      createWindow();
      app.on("activate", () => {
        if (!window) createWindow();
      });
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!quitting && engine) {
      event.preventDefault();
      quitting = true;
      void engine
        .shutdown()
        .catch((error) => console.error(error))
        .then(() => {
          app.quit();
        });
    }
  });
}
