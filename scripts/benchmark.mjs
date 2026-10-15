import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const output = await mkdtemp(path.join(tmpdir(), "orbit-benchmark-build-"));
try {
  await build({
    entryPoints: ["scripts/benchmark-runner.ts"],
    outfile: path.join(output, "runner.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  await build({
    entryPoints: ["apps/desktop/electron/backend-worker.ts"],
    outfile: path.join(output, "backend.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const { runBenchmarks } = await import(
    pathToFileURL(path.join(output, "runner.mjs")).href
  );
  await runBenchmarks(path.join(output, "backend.cjs"));
} finally {
  await rm(output, { recursive: true, force: true });
}
