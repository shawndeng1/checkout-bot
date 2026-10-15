import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { productQuery } from "./index";
/** Contract fixture for the documented Storefront query; never proxies external traffic. */
export async function startShopifyFixture(port = 0) {
  const controlToken = randomUUID();
  const state = {
    available: false,
    denied: false,
    throttled: 0,
    invalid: false,
    latencyMs: 0,
  };
  const metrics = { queries: 0, mutations: 0 };
  const server = createServer(async (req, res) => {
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
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
      if (body.query !== productQuery) {
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
      if (state.throttled > 0) {
        state.throttled--;
        send(200, {
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        });
        return;
      }
      if (state.invalid) {
        send(200, { data: { product: 42 } });
        return;
      }
      if (
        body.variables?.handle !== "orbit-shirt" &&
        body.variables?.id !== "gid://shopify/Product/1"
      ) {
        send(200, { data: { product: null } });
        return;
      }
      send(200, {
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Orbit fixture shirt",
            variants: {
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/1",
                  title: "Blue",
                  availableForSale: state.available,
                },
                {
                  id: "gid://shopify/ProductVariant/2",
                  title: "Red",
                  availableForSale: false,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
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
