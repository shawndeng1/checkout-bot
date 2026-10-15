import { build } from "esbuild";
await build({
  entryPoints: ["packages/adapters/shopify/src/fixture.ts"],
  outfile: "dist/shopify-fixture/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
});
const { startShopifyFixture } =
  await import("../dist/shopify-fixture/index.mjs");
const fixture = await startShopifyFixture(
  Number(process.env.ORBIT_FIXTURE_PORT ?? 4319),
);
console.log(
  `Shopify contract fixture: ${fixture.url}\nControl token: ${fixture.controlToken}`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await fixture.close();
    process.exit(0);
  });
