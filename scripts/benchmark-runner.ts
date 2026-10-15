import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
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
          workflow: "MONITOR_ONLY",
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
    while (!latest.tasks.every((task) => task.state === "STOCK_DETECTED")) {
      if (performance.now() > deadline) throw new Error("Benchmark timed out");
      await sleep(10);
    }
    const stockVisibleLatency = performance.now() - changedPerf;
    const finalMetrics = await backend.metrics();
    const latencies = [...stockTimes.values()]
      .map((at) => Math.max(0, at - changedAt))
      .sort((a, b) => a - b);
    if (latencies.length !== count)
      throw new Error("Missing stock event measurements");
    const result = {
      tasks: count,
      processId: process.pid,
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
      rawLatenciesMs: latencies,
      stockLatencyP50Ms: percentile(latencies, 0.5),
      stockLatencyP95Ms: percentile(latencies, 0.95),
      stockLatencyMaxMs: Math.max(...latencies),
      allStockVisibleMs: round(stockVisibleLatency),
      totalWorkloadMs: round(performance.now() - started),
      peakOperations: finalMetrics.peakOperations,
      ordersCreated: server.metrics.ordersCreated,
      walBytes: statSync(database + "-wal").size,
    };
    if (
      result.peakOperations > 10 ||
      result.ordersCreated !== 0 ||
      finalMetrics.subscriptions !== 1
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
async function isolatedTrial(
  count: number,
  workerPath: string,
): Promise<Awaited<ReturnType<typeof measure>>> {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(import.meta.url),
      ["--trial", String(count), workerPath],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] },
    );
    let result: Awaited<ReturnType<typeof measure>> | undefined;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Benchmark trial timed out"));
    }, 30000);
    child.on("message", (message) => {
      result = message as typeof result;
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Benchmark trial failed to launch"));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && result) resolve(result);
      else reject(new Error("Benchmark trial failed"));
    });
  });
}
if (process.argv[2] === "--trial")
  void measure(Number(process.argv[3]), process.argv[4])
    .then((result) => {
      process.send?.(result);
      process.disconnect?.();
    })
    .catch(() => {
      process.exitCode = 1;
      process.disconnect?.();
    });
export async function runBenchmarks(workerPath: string) {
  const iterations = Number(process.env.ORBIT_BENCHMARK_ITERATIONS ?? 3);
  if (!Number.isInteger(iterations) || iterations < 2 || iterations > 20)
    throw new Error("Use 2–20 benchmark iterations");
  const results: (Awaited<ReturnType<typeof measure>> & {
    iteration: number;
  })[] = [];
  for (let iteration = 1; iteration <= iterations; iteration++)
    for (const count of [10, 50, 100]) {
      const result = { iteration, ...(await isolatedTrial(count, workerPath)) };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  const summary = [10, 50, 100].map((tasks) => {
    const samples = results.filter((result) => result.tasks === tasks);
    const latencies = samples
      .flatMap((sample) => sample.rawLatenciesMs)
      .sort((a, b) => a - b);
    const cpu = samples
      .map((sample) => sample.monitoringCpuPercentOneCore)
      .sort((a, b) => a - b);
    return {
      tasks,
      iterations: samples.length,
      latencySamples: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      cpuP50PercentOneCore: percentile(cpu, 0.5),
      cpuP95PercentOneCore: percentile(cpu, 0.95),
      peakRssMiB: Math.max(
        ...samples.map((sample) => sample.peakProcessRssMiB),
      ),
      workerHeapP50MiB: percentile(
        samples.map((sample) => sample.workerHeapMiB).sort((a, b) => a - b),
        0.5,
      ),
    };
  });
  const methodology =
    "Each trial runs in a fresh child process with a fresh backend worker and in-memory loopback HTTP simulator, with temporary on-disk desktop SQLite/WAL. Trials run sequentially; process IDs are recorded to verify isolation, avoiding parent allocator/JIT retention across scales. Continuous MONITOR_ONLY tasks share one product/default-variant subscription; interval 100 ms, concurrency 10, simulator policy 10 ms / 4 requests. After all task starts, warm up 500 ms, then sample steady monitoring CPU for 2000 ms. CPU includes the measured trial process, its worker and simulator (not the orchestrator) and is normalized to one core. RSS is whole trial-process memory sampled every 10 ms from steady monitoring through stock snapshot receipt; worker heap is sampled before stock. Task latencies use persisted STOCK_DETECTED log timestamps minus the local inventory-change request send time. Pooled latency samples are correlated within each shared fan-out, not independent network samples. Per-scale p50/p95 are nearest-rank across pooled task events; CPU p50/p95 use trial-window percentages. Peak RSS is the maximum over trials. Full-snapshot IPC is included in overall readiness, not log-timestamp latency. Sources remain subscribed after stock and are cancelled on shutdown. Every trial verifies sharing, subscriber count, capacity and zero orders. These fixture measurements do not establish production Shopify, GUI rendering, cross-platform performance or an improvement over a differently defined historical workload.";
  const report = {
    recordedAt: new Date().toISOString(),
    runtime: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    iterations,
    methodology,
    summary,
    results,
  };
  mkdirSync("docs/benchmarks", { recursive: true });
  writeFileSync(
    "docs/benchmarks/milestone-4.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  const rows = summary
    .map(
      (row) =>
        `| ${row.tasks} | ${row.iterations} / ${row.latencySamples} | ${row.p50Ms} / ${row.p95Ms} | ${row.cpuP50PercentOneCore}% / ${row.cpuP95PercentOneCore}% | ${row.peakRssMiB} | ${row.workerHeapP50MiB} |`,
    )
    .join("\n");
  writeFileSync(
    "PERFORMANCE.md",
    `# Milestone 4 measured inventory performance\n\nRecorded ${report.recordedAt}; ${report.runtime}; ${report.platform}/${report.arch}; ${report.cpu}.\n\n| Tasks | Trials / task-event samples | Stock p50 / p95 ms | CPU p50 / p95 one-core | Peak RSS MiB | Median worker heap MiB |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n\n${methodology}\n\nRaw per-trial measurements and task latencies: [milestone-4.json](docs/benchmarks/milestone-4.json). Run with Node 24.15+ using \`pnpm benchmark\`; \`ORBIT_BENCHMARK_ITERATIONS\` defaults to 3 (minimum 2). Historical [Milestone 2 samples](docs/benchmarks/MILESTONE_2.md) used a different checkout workflow and single samples; they are not a controlled regression baseline.\n`,
  );
}
