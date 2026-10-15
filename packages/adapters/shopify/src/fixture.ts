import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { productQuery, searchQuery } from "./index";
/** Contract fixture for the documented Storefront query; never proxies external traffic. */
export async function startShopifyFixture(port = 0) {
  const controlToken = randomUUID();
  const state = {
    available: false,
    denied: false,
    throttled: 0,
    http429: 0,
    retryAfterMs: 1000,
    invalid: false,
    latencyMs: 0,
    variantPageSize: 100,
    catalogSize: 5,
    apiVersion: "2026-07",
    image: null as { url: string; altText: string | null } | null,
  };
  const metrics = { queries: 0, mutations: 0 };
  const server = createServer(async (req, res) => {
    const send = (code: number, data: unknown) => {
      res.writeHead(code, {
        "content-type": "application/json",
        "x-shopify-api-version": state.apiVersion,
        ...(code === 429
          ? { "retry-after": String(state.retryAfterMs / 1000) }
          : {}),
      });
      res.end(JSON.stringify(data));
    };
    if (
      req.headers.origin ||
      req.headers.host !==
        `127.0.0.1:${(server.address() as { port: number }).port}`
    ) {
      send(403, {});
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) {
        send(413, {});
        return;
      }
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url === "/control" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${controlToken}`) {
          send(403, {});
          return;
        }
        for (const key of ["available", "denied", "invalid"] as const)
          if (typeof body[key] === "boolean") state[key] = body[key];
        if (
          Number.isInteger(body.throttled) &&
          body.throttled >= 0 &&
          body.throttled <= 100
        )
          state.throttled = body.throttled;
        if (
          Number.isInteger(body.latencyMs) &&
          body.latencyMs >= 0 &&
          body.latencyMs <= 5000
        )
          state.latencyMs = body.latencyMs;
        send(200, state);
        return;
      }
      if (req.url !== "/api/2026-07/graphql.json" || req.method !== "POST") {
        send(404, {});
        return;
      }
      if (body.query !== productQuery && body.query !== searchQuery) {
        if (String(body.query).includes("mutation")) metrics.mutations++;
        send(400, {
          errors: [{ message: "Only documented inventory query supported" }],
        });
        return;
      }
      metrics.queries++;
      if (state.latencyMs)
        await new Promise((resolve) => setTimeout(resolve, state.latencyMs));
      if (state.denied) {
        send(200, {
          errors: [
            { message: "Access denied", extensions: { code: "ACCESS_DENIED" } },
          ],
        });
        return;
      }
      if (state.http429 > 0) {
        state.http429--;
        send(429, { errors: [{ message: "Rate limited" }] });
        return;
      }
      if (state.throttled > 0) {
        state.throttled--;
        send(200, {
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        });
        return;
      }
      if (state.invalid) {
        send(200, {
          data: body.query === searchQuery ? { search: 42 } : { product: 42 },
        });
        return;
      }
      const catalog = Array.from({ length: state.catalogSize }, (_, index) => ({
        id: `gid://shopify/Product/${index + 1}`,
        handle: index === 0 ? "orbit-shirt" : `orbit-shirt-${index + 1}`,
        title:
          index === 0
            ? "Orbit fixture shirt"
            : `Orbit fixture shirt ${index + 1}`,
        description: "A developer-controlled inventory fixture. Cotton shirt.",
        featuredImage: state.image,
        availableForSale: state.available,
      }));
      if (body.query === searchQuery) {
        const matches = catalog.filter((product) =>
          product.title
            .toLowerCase()
            .includes(String(body.variables?.query ?? "").toLowerCase()),
        );
        const after = body.variables?.after ? Number(body.variables.after) : 0;
        const first = Math.min(50, Number(body.variables?.first ?? 2));
        const nodes = matches.slice(after, after + first);
        send(200, {
          data: {
            search: {
              nodes,
              pageInfo: {
                hasNextPage: after + nodes.length < matches.length,
                endCursor: nodes.length ? String(after + nodes.length) : null,
              },
            },
          },
        });
        return;
      }
      const product = catalog.find(
        (product) =>
          product.handle === body.variables?.handle ||
          product.id === body.variables?.id,
      );
      if (!product) {
        send(200, { data: { product: null } });
        return;
      }
      const baseVariant = catalog.indexOf(product) * 2 + 1;
      const variants = [
        {
          id: `gid://shopify/ProductVariant/${baseVariant}`,
          title: "Blue",
          availableForSale: state.available,
          selectedOptions: [
            { name: "Color", value: "Blue" },
            { name: "Size", value: "M" },
          ],
        },
        {
          id: `gid://shopify/ProductVariant/${baseVariant + 1}`,
          title: "Red",
          availableForSale: false,
          selectedOptions: [
            { name: "Color", value: "Red" },
            { name: "Size", value: "M" },
          ],
        },
      ];
      const offset = Number(body.variables?.after ?? 0);
      const nodes = variants.slice(offset, offset + state.variantPageSize);
      send(200, {
        data: {
          product: {
            ...product,
            variants: {
              nodes,
              pageInfo: {
                hasNextPage: offset + nodes.length < variants.length,
                endCursor: nodes.length ? String(offset + nodes.length) : null,
              },
            },
          },
        },
      });
    } catch {
      send(400, { errors: [{ message: "Invalid request" }] });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    controlToken,
    state,
    metrics,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
