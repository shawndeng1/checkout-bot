import { parentPort, workerData } from "node:worker_threads";
import { Store } from "../../../packages/database/src/index";
import { createAdapters } from "../../../packages/adapters/src/index";
import { Engine } from "../../../packages/core/src/index";
import { ZodError } from "zod";
async function boot() {
  const store = await Store.open(workerData.databasePath);
  const engine = new Engine(
    store,
    createAdapters(process.env.ORBIT_SIMULATOR_URL),
  );
  engine.on("fault", (error) =>
    parentPort!.postMessage({ type: "fatal", error: String(error) }),
  );
  engine.on("snapshot", (data) =>
    parentPort!.postMessage({ type: "snapshot", data }),
  );
  let commands = Promise.resolve();
  parentPort!.on("message", (request) => {
    commands = commands.then(async () => {
      try {
        let data;
        if (request.type === "snapshot") data = engine.snapshot();
        else if (request.type === "metrics") data = engine.diagnostics();
        else if (request.type === "command")
          data = await engine.command(request.command);
        else if (request.type === "shutdown") {
          await engine.shutdown();
          data = engine.snapshot();
          store.close();
        } else throw new Error("Unknown backend request");
        parentPort!.postMessage({ id: request.id, data });
        if (request.type === "shutdown") parentPort!.close();
      } catch (error) {
        const message =
          error instanceof ZodError
            ? error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")
            : error instanceof Error
              ? error.message
              : "Backend operation failed";
        parentPort!.postMessage({ id: request.id, error: message });
      }
    });
  });
  parentPort!.postMessage({ type: "ready" });
}
void boot().catch((error) => {
  parentPort!.postMessage({ type: "fatal", error: String(error) });
  parentPort!.close();
});
