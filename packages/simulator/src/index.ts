import { SimulatorStorage } from "./storage";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import type { CartResult, CheckoutResult } from "../../retailer-sdk/src/index";
const productSchema = z
  .object({
    productId: z.string().min(1).max(120),
    variantId: z.string().min(1).max(120).optional(),
  })
  .strict();
const controlSchema = z
  .object({
    latencyMs: z.number().int().min(0).max(10000).optional(),
    failNext: z.number().int().min(0).max(100).optional(),
    rateLimitNext: z.number().int().min(0).max(100).optional(),
    retryAfterMs: z.number().int().min(0).max(60000).optional(),
    checkoutFailure: z.boolean().optional(),
    dropCheckoutResponse: z.boolean().optional(),
    completionDelayMs: z.number().int().min(0).max(60000).optional(),
    invalidStatus: z.boolean().optional(),
    statusAgeMs: z.number().int().min(0).max(120000).optional(),
  })
  .strict();
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
/** Loopback-only simulator, with an optional durable service database. */
export async function startSimulator(
  port = 0,
  options: { databasePath?: string } = {},
) {
  const storage = new SimulatorStorage(options.databasePath);
  const token = randomUUID();
  const streamId = storage.sourceId;
  const inventoryStreamId = randomUUID();
  const completions = new Set<ReturnType<typeof setTimeout>>();
  const defaultProducts = [
    {
      id: "SKU-42",
      name: "Orbit demo product",
      variants: [
        { id: "default", available: false, sequence: 1 },
        { id: "blue", available: true, sequence: 1 },
      ],
    },
  ];
  const products =
    storage.get<typeof defaultProducts>("metadata", "inventory") ??
    defaultProducts;
  type Order = {
    cartId: string;
    result?: CheckoutResult;
    status: "completed" | "failed" | "pending";
    dueAt?: number;
    sequence: number;
  };
  const carts = {
    get: (id: string) => storage.get<CartResult>("carts", id),
    has: (id: string) => !!storage.get("carts", id),
    set: (id: string, cart: CartResult) => storage.set("carts", id, cart),
  };
  const orders = {
    get: (id: string) => storage.get<Order>("orders", id),
    set: (id: string, order: Order) =>
      storage.insertOrder(id, order.cartId, order),
  };
  const scheduleCompletion = (id: string, record: Order) => {
    if (record.status !== "pending" || record.dueAt === undefined) return;
    const timer = setTimeout(
      () => {
        const current = orders.get(id);
        if (current?.status === "pending") {
          try {
            storage.updateOrder(id, {
              ...current,
              status: "completed",
              sequence: current.sequence + 1,
            });
          } catch {
            /* Durable pending evidence survives; restart can resume processing. */
          }
        }
        completions.delete(timer);
      },
      Math.max(0, Math.min(2147483647, record.dueAt - Date.now())),
    );
    completions.add(timer);
  };
  for (const [id, order] of storage.pendingOrders<Order>())
    scheduleCompletion(id, order);
  const controls = {
    latencyMs: 0,
    failNext: 0,
    rateLimitNext: 0,
    retryAfterMs: 100,
    checkoutFailure: false,
    dropCheckoutResponse: false,
    completionDelayMs: 0,
    invalidStatus: false,
    statusAgeMs: 0,
  };
  const metrics = {
    inventoryRequests: 0,
    cartRequests: 0,
    checkoutRequests: 0,
    ordersCreated: storage.orderCount(),
    statusRequests: 0,
  };
  const server = createServer(async (request, response) => {
    const send = (
      status: number,
      data: unknown,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      response.end(JSON.stringify(data));
    };
    try {
      // Reject browser cross-origin requests and DNS-rebinding-style Host headers.
      if (
        request.headers.origin ||
        request.headers.host !==
          `127.0.0.1:${(server.address() as { port: number }).port}`
      ) {
        send(403, { error: "Loopback clients only" });
        return;
      }
      const url = new URL(request.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/control")) {
        if (request.headers.authorization !== `Bearer ${token}`) {
          send(403, { error: "Control token required" });
          return;
        }
        if (request.method === "POST" && url.pathname === "/control/config") {
          Object.assign(controls, controlSchema.parse(await body(request)));
          send(200, controls);
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === "/control/inventory"
        ) {
          const change = productSchema
            .extend({ available: z.boolean() })
            .parse(await body(request));
          const variant = products
            .find((p) => p.id === change.productId)
            ?.variants.find((v) => v.id === (change.variantId ?? "default"));
          if (!variant) {
            send(404, { error: "Unknown product/variant" });
            return;
          }
          variant.available = change.available;
          variant.sequence++;
          storage.set("metadata", "inventory", products);
          send(200, variant);
          return;
        }
        if (request.method === "GET" && url.pathname === "/control/metrics") {
          send(200, metrics);
          return;
        }
        send(404, { error: "Unknown control" });
        return;
      }
      if (controls.latencyMs)
        await new Promise((resolve) => setTimeout(resolve, controls.latencyMs));
      if (controls.rateLimitNext > 0) {
        controls.rateLimitNext--;
        send(
          429,
          { error: "Simulated rate limit" },
          { "retry-after": String(controls.retryAfterMs / 1000) },
        );
        return;
      }
      if (controls.failNext > 0) {
        controls.failNext--;
        send(503, { error: "Simulated service failure" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/catalog") {
        send(200, products);
        return;
      }
      if (request.method === "GET" && url.pathname === "/inventory") {
        metrics.inventoryRequests++;
        const ref = productSchema.parse(Object.fromEntries(url.searchParams));
        const variant = products
          .find((p) => p.id === ref.productId)
          ?.variants.find((v) => v.id === (ref.variantId ?? "default"));
        if (!variant) {
          send(404, { error: "Unknown product/variant" });
          return;
        }
        send(200, {
          streamId: inventoryStreamId,
          eventId: `${ref.productId}:${variant.id}:${variant.sequence}`,
          retailerId: "simulator",
          product: ref,
          sequence: variant.sequence,
          observedAt: Date.now(),
          availability: variant.available ? "in-stock" : "out-of-stock",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/orders/status") {
        metrics.statusRequests++;
        const key = z
          .string()
          .min(1)
          .max(200)
          .parse(url.searchParams.get("idempotencyKey"));
        if (controls.invalidStatus) {
          send(200, { status: "completed", orderId: 42 });
          return;
        }
        const order = orders.get(key);
        const base = {
          idempotencyKey: key,
          sourceId: streamId,
          sequence: order?.sequence ?? 0,
          checkedAt: Date.now() - controls.statusAgeMs,
        };
        if (!order)
          send(200, {
            ...base,
            status: "unresolved",
            authoritative: false,
            reason:
              "No record in this simulator instance; absence is not failure evidence",
          });
        else if (order.status === "completed")
          send(200, {
            ...base,
            status: "completed",
            authoritative: true,
            orderId: order.result!.orderId,
          });
        else if (order.status === "failed")
          send(200, {
            ...base,
            status: "failed",
            authoritative: true,
            reason: "Simulated checkout declined",
          });
        else
          send(200, {
            ...base,
            status: "pending",
            authoritative: false,
            reason: "Simulated order is still processing",
          });
        return;
      }
      if (request.method === "POST" && url.pathname === "/carts") {
        metrics.cartRequests++;
        const ref = productSchema.parse(await body(request));
        const variant = products
          .find((p) => p.id === ref.productId)
          ?.variants.find((v) => v.id === (ref.variantId ?? "default"));
        if (!variant?.available) {
          send(409, { error: "Out of stock" });
          return;
        }
        const cart: CartResult = {
          id: randomUUID(),
          product: ref,
          quantity: 1,
          sourceId: streamId,
        };
        carts.set(cart.id, cart);
        send(201, cart);
        return;
      }
      if (request.method === "POST" && url.pathname === "/checkout") {
        metrics.checkoutRequests++;
        const input = z
          .object({
            cartId: z.string(),
            idempotencyKey: z.string().min(1).max(200),
          })
          .strict()
          .parse(await body(request));
        const existing = orders.get(input.idempotencyKey);
        if (existing) {
          if (existing.cartId !== input.cartId)
            send(409, { error: "Idempotency key conflict" });
          else if (existing.status === "failed")
            send(402, { error: "Simulated checkout declined" });
          else if (existing.status === "pending")
            send(202, { status: "pending" });
          else send(200, existing.result);
          return;
        }
        if (!carts.has(input.cartId)) {
          send(404, { error: "Unknown cart" });
          return;
        }
        if (controls.checkoutFailure) {
          orders.set(input.idempotencyKey, {
            cartId: input.cartId,
            status: "failed",
            sequence: 1,
          });
          if (controls.dropCheckoutResponse) {
            request.socket.destroy();
            return;
          }
          send(402, { error: "Simulated checkout declined" });
          return;
        }
        const result: CheckoutResult = {
          orderId: randomUUID(),
          status: "completed",
          idempotencyKey: input.idempotencyKey,
        };
        const record: Order = {
          cartId: input.cartId,
          result,
          status: controls.completionDelayMs > 0 ? "pending" : "completed",
          sequence: 1,
          dueAt:
            controls.completionDelayMs > 0
              ? Date.now() + controls.completionDelayMs
              : undefined,
        };
        orders.set(input.idempotencyKey, record);
        metrics.ordersCreated++;
        scheduleCompletion(input.idempotencyKey, record);
        if (controls.dropCheckoutResponse) {
          request.socket.destroy();
          return;
        }
        if (controls.completionDelayMs > 0) send(202, { status: "pending" });
        else send(200, result);
        return;
      }
      send(404, { error: "Unknown route" });
    } catch (error) {
      if (!response.headersSent)
        send(400, {
          error: error instanceof Error ? error.message : "Invalid input",
        });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(port, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (error) {
    for (const timer of completions) clearTimeout(timer);
    storage.close();
    throw error;
  }
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: address,
    token,
    metrics,
    async close() {
      for (const timer of completions) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      storage.close();
    },
  };
}
