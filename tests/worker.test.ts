import { it, expect } from "vitest";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendClient } from "../apps/desktop/electron/backend-client";
it("owns SQLite in a backend worker and persists IPC commands across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-worker-"));
  const workerPath = join(dir, "backend.cjs");
  await build({
    entryPoints: ["apps/desktop/electron/backend-worker.ts"],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  let backend = new BackendClient(workerPath, join(dir, "db.sqlite"));
  try {
    await backend.ready;
    await backend.command({
      type: "saveGroup",
      data: { name: "Worker group", retailer: "mock" },
    });
    expect((await backend.snapshot()).groups[0].name).toBe("Worker group");
    await backend.shutdown();
    backend = new BackendClient(workerPath, join(dir, "db.sqlite"));
    await backend.ready;
    expect((await backend.snapshot()).groups[0].name).toBe("Worker group");
  } finally {
    await backend.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
