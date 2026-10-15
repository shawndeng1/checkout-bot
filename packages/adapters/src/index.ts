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
      capabilities: simulatedCapabilities,
      rateLimit: { minIntervalMs: 10, maxConcurrentRequests: 4 },
      create: () => new HttpSimulatorAdapter(simulatorUrl),
    });
  return registry;
}
