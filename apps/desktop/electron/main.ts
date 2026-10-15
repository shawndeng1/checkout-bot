import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BackendClient } from "./backend-client";
import { commandSchema } from "../../../packages/shared-types/src/index";
import { ZodError } from "zod";
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
      engine = new BackendClient(
        path.join(__dirname, "backend-worker.cjs"),
        path.join(
          process.env.RETAIL_DATA_DIR || app.getPath("userData"),
          "retail.sqlite",
        ),
      );
      engine.on("failure", (error) => {
        console.error("Backend unavailable", error);
        app.exit(1);
      });
      await engine.ready;
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
          return await engine.command(commandSchema.parse(input));
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
