import {
  ShopifyInventoryAdapter,
  shopifyCapabilities,
  shopifyConfig,
} from "../shopify/src/index";
import {
  AdapterRegistry,
  simulatedCapabilities,
} from "../../retailer-sdk/src/index";
import { MockAdapter } from "../mock/src/index";
import { HttpSimulatorAdapter } from "../http/src/index";
/** Application composition belongs here, never in engine control flow. */
export function createAdapters(simulatorUrl?: string) {
  const registry = new AdapterRegistry().register({
    id: "mock",
    name: "Mock Retailer",
    capabilities: simulatedCapabilities,
    rateLimit: { minIntervalMs: 0, maxConcurrentRequests: 20 },
    create: () => new MockAdapter(),
  });
  if (simulatorUrl)
    registry.register({
      id: "simulator",
      name: "Local HTTP Simulator",
      capabilities: { ...simulatedCapabilities, orderStatus: true },
      rateLimit: { minIntervalMs: 10, maxConcurrentRequests: 4 },
      create: () => new HttpSimulatorAdapter(simulatorUrl),
    });
  registry.register({
    id: "shopify",
    name: "Shopify authorized inventory",
    capabilities: shopifyCapabilities,
    rateLimit: { minIntervalMs: 500, maxConcurrentRequests: 1 },
    configurationSchema: shopifyConfig,
    configurationFields: [
      {
        key: "mode",
        label: "API mode",
        type: "select",
        defaultValue: "fixture",
        options: [
          { value: "fixture", label: "Local contract fixture" },
          { value: "authorized-store", label: "Authorized developer store" },
        ],
      },
      {
        key: "endpoint",
        label: "Store / fixture origin",
        type: "text",
        defaultValue: "http://127.0.0.1:4319",
      },
      {
        key: "authorizationConfirmed",
        label: "I am authorized to access this developer store",
        type: "checkbox",
        defaultValue: false,
      },
    ],
    create: (config, credential) =>
      new ShopifyInventoryAdapter(config, credential),
  });
  return registry;
}
