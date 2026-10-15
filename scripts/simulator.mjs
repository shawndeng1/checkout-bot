import { build } from "esbuild";
await build({
  entryPoints: ["packages/simulator/src/index.ts"],
  outfile: "dist/simulator/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
});
const { startSimulator } = await import("../dist/simulator/index.mjs");
const simulator = await startSimulator(
  Number(process.env.ORBIT_SIMULATOR_PORT ?? 4318),
  {
    databasePath:
      process.env.ORBIT_SIMULATOR_DB ?? ".orbit-simulator/state.sqlite",
  },
);
console.log(
  `Orbit simulator: ${simulator.url}\nControl token: ${simulator.token}`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await simulator.close();
    process.exit(0);
  });
