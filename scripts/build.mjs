import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("dist/electron", { recursive: true });
await build({
  entryPoints: ["apps/desktop/electron/main.ts"],
  outfile: "dist/electron/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});
await build({
  entryPoints: ["apps/desktop/electron/preload.ts"],
  outfile: "dist/electron/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
await build({
  entryPoints: ["apps/desktop/electron/backend-worker.ts"],
  outfile: "dist/electron/backend-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: true,
});
