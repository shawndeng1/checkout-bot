import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir, cpus, platform, arch } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { BackendClient } from "../apps/desktop/electron/backend-client";
import { startSimulator } from "../packages/simulator/src/index";
import type { Snapshot } from "../packages/shared-types/src/index";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n: number) => Math.round(n * 100) / 100;
const percentile = (values: number[], p: number) =>
  values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
async function measure(count: number, workerPath: string) {
  const server = await startSimulator();
  const dir = mkdtempSync(path.join(tmpdir(), "orbit-benchmark-"));
  const database = path.join(dir, "db.sqlite");
  const previous = process.env.ORBIT_SIMULATOR_URL;
  process.env.ORBIT_SIMULATOR_URL = server.url;
  const backend = new BackendClient(workerPath, database);
  let sample: ReturnType<typeof setInterval> | undefined;
  try {
    await backend.ready;
    let data = await backend.command({
      type: "saveGroup",
      data: { name: "Benchmark", retailer: "simulator" },
    });
    const groupId = data.groups[0].id;
    data = await backend.command({
      type: "settings",
      data: { ...data.settings, concurrency: 10 },
    });
    for (let i = 0; i < count; i++)
      data = await backend.command({
        type: "saveTask",
        data: {
          name: `Monitor ${i}`,
          groupId,
          product: "SKU-42",
          variantId: null,
          profileId: null,
          proxyId: null,
          scenario: "available",
          intervalMs: 100,
          maxRetries: 2,
        },
      });
    const ids = data.tasks.map((task) => task.id);
    let latest: Snapshot = data;
    const stockTimes = new Map<string, number>();
    backend.on("snapshot", (snapshot: Snapshot) => {
      latest = snapshot;
      for (const log of snapshot.logs)
        if (log.state === "STOCK_DETECTED" && !stockTimes.has(log.taskId))
          stockTimes.set(log.taskId, Date.parse(log.at));
    });
    const started = performance.now();
    for (const id of ids) await backend.command({ type: "start", id });
    await sleep(500);
    const rssBaseline = process.memoryUsage().rss;
    let peakRss = rssBaseline;
    sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 10);
    const cpuStart = process.cpuUsage();
    const monitorStart = performance.now();
    await sleep(2000);
    const monitorMs = performance.now() - monitorStart;
    const cpu = process.cpuUsage(cpuStart);
    const metrics = await backend.metrics();
    if (metrics.subscriptions !== 1 || metrics.subscribers !== count)
      throw new Error(`Sharing assertion failed at ${count} tasks`);
    const changedAt = Date.now();
    const changedPerf = performance.now();
    const control = await fetch(server.url + "/control/inventory", {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ productId: "SKU-42", available: true }),
    });
    if (!control.ok) throw new Error("Control update failed");
    const deadline = performance.now() + 15000;
    while (!latest.tasks.every((task) => task.state === "AWAITING_APPROVAL")) {
      if (performance.now() > deadline) throw new Error("Benchmark timed out");
      await sleep(10);
    }
    const approvalLatency = performance.now() - changedPerf;
    const finalMetrics = await backend.metrics();
    const latencies = [...stockTimes.values()]
      .map((at) => Math.max(0, at - changedAt))
      .sort((a, b) => a - b);
    if (latencies.length !== count)
      throw new Error("Missing stock event measurements");
    const result = {
      tasks: count,
      sharedSubscriptions: metrics.subscriptions,
      monitoringPolls: metrics.inventoryPolls,
      monitoringWindowMs: round(monitorMs),
      monitoringCpuMs: round((cpu.user + cpu.system) / 1000),
      monitoringCpuPercentOneCore: round(
        ((cpu.user + cpu.system) / 1000 / monitorMs) * 100,
      ),
      rssBaselineMiB: round(rssBaseline / 2 ** 20),
      peakProcessRssMiB: round(peakRss / 2 ** 20),
      workerHeapMiB: round(metrics.workerHeapBytes / 2 ** 20),
      stockLatencyP50Ms: percentile(latencies, 0.5),
      stockLatencyP95Ms: percentile(latencies, 0.95),
      stockLatencyMaxMs: Math.max(...latencies),
      allApprovalReadyMs: round(approvalLatency),
      totalWorkloadMs: round(performance.now() - started),
      peakOperations: finalMetrics.peakOperations,
      ordersCreated: server.metrics.ordersCreated,
      walBytes: statSync(database + "-wal").size,
    };
    if (
      result.peakOperations > 10 ||
      result.ordersCreated !== 0 ||
      finalMetrics.subscriptions !== 0
    )
      throw new Error("Safety or capacity assertion failed");
    return result;
  } finally {
    if (sample) clearInterval(sample);
    await backend.shutdown();
    await server.close();
    if (previous === undefined) delete process.env.ORBIT_SIMULATOR_URL;
    else process.env.ORBIT_SIMULATOR_URL = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
export async function runBenchmarks(workerPath: string) {
  const results = [];
  for (const count of [10, 50, 100]) {
    const result = await measure(count, workerPath);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const report = {
    recordedAt: new Date().toISOString(),
    runtime: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    methodology:
      "One fresh backend worker and one parent-process loopback simulator per scale, run sequentially in a single parent process; RSS can include parent allocator/JIT retention from earlier cases. Concurrency 10; shared inventory poll interval 100ms; simulator policy 10ms minimum request spacing / 4 concurrent requests. 500ms warm-up then 2000ms steady out-of-stock CPU sample. CPU is process CPU including worker and simulator, expressed against one core. RSS is total process memory (parent + worker + simulator), sampled every 10ms from steady-state through approval readiness; worker heap sampled before stock. Stock latency uses persisted STOCK_DETECTED event timestamps relative to sending the local inventory change; allApprovalReady includes cart queueing plus snapshot IPC. No approvals or order submissions are sent. One sample per scale, no baseline or statistical regression claim.",
    results,
  };
  mkdirSync("docs/benchmarks", { recursive: true });
  writeFileSync(
    "docs/benchmarks/milestone-2.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  const rows = results
    .map(
      (r) =>
        `| ${r.tasks} | ${r.monitoringPolls} | ${r.stockLatencyP50Ms} / ${r.stockLatencyP95Ms} / ${r.stockLatencyMaxMs} | ${r.allApprovalReadyMs} | ${r.monitoringCpuMs} / ${r.monitoringCpuPercentOneCore}% | ${r.peakProcessRssMiB} | ${r.workerHeapMiB} |`,
    )
    .join("\n");
  writeFileSync(
    "docs/benchmarks/MILESTONE_2.md",
    `# Milestone 2 measured monitoring benchmark\n\nRuntime: ${report.runtime}; ${report.platform}/${report.arch}; ${report.cpu}; ${report.logicalCpus} logical CPUs.\n\n| Tasks | Polls before stock | Stock latency p50 / p95 / max (ms) | All carts awaiting approval (ms) | Steady monitoring CPU ms / one-core % | Peak process RSS (MiB) | Worker heap (MiB) |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\n${report.methodology}\n\nAll runs verified one shared subscription, correct subscriber counts, cleanup after stock fan-out, configured capacity bounds, and zero simulated orders. Raw measurements: [milestone-2.json](milestone-2.json). Rerun with \`pnpm benchmark\`. These measurements characterize this local workload; they do not establish cross-platform performance or an improvement over an unmeasured baseline.\n`,
  );
}
