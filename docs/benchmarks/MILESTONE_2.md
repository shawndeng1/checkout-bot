# Milestone 2 measured monitoring benchmark

Runtime: v24.19.0; darwin/x64; Intel(R) Core(TM) i5-1038NG7 CPU @ 2.00GHz; 8 logical CPUs.

| Tasks | Polls before stock | Stock latency p50 / p95 / max (ms) | All carts awaiting approval (ms) | Steady monitoring CPU ms / one-core % | Peak process RSS (MiB) | Worker heap (MiB) |
| ----- | ------------------ | ---------------------------------- | -------------------------------- | ------------------------------------- | ---------------------- | ----------------- |
| 10    | 25                 | 93 / 100 / 100                     | 209.32                           | 103.3 / 5.16%                         | 103.63                 | 16.05             |
| 50    | 25                 | 43 / 73 / 76                       | 618.6                            | 102.4 / 5.12%                         | 115.52                 | 18.17             |
| 100   | 27                 | 170 / 220 / 225                    | 1307.28                          | 142.68 / 7.13%                        | 131.42                 | 19.38             |

One fresh backend worker and one parent-process loopback simulator per scale, run sequentially in a single parent process; RSS can include parent allocator/JIT retention from earlier cases. Concurrency 10; shared inventory poll interval 100ms; simulator policy 10ms minimum request spacing / 4 concurrent requests. 500ms warm-up then 2000ms steady out-of-stock CPU sample. CPU is process CPU including worker and simulator, expressed against one core. RSS is total process memory (parent + worker + simulator), sampled every 10ms from steady-state through approval readiness; worker heap sampled before stock. Stock latency uses persisted STOCK_DETECTED event timestamps relative to sending the local inventory change; allApprovalReady includes cart queueing plus snapshot IPC. No approvals or order submissions are sent. One sample per scale, no baseline or statistical regression claim.

All runs verified one shared subscription, correct subscriber counts, cleanup after stock fan-out, configured capacity bounds, and zero simulated orders. Raw measurements: [milestone-2.json](milestone-2.json). Rerun with `pnpm benchmark`. These measurements characterize this local workload; they do not establish cross-platform performance or an improvement over an unmeasured baseline.
