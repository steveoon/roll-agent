import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

const TRACE = process.env.ROLL_BENCH_TRACE ?? "";
const INTERVAL_MS = Number(process.env.ROLL_BENCH_TRACE_MS ?? 5_000);

if (TRACE) {
  const startedAt = Date.now();
  const heapLimitMB = Math.round(getHeapStatistics().heap_size_limit / 1_048_576);
  const timer = setInterval(() => {
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
    }
    const usage = process.memoryUsage();
    const record = {
      t: Math.round((Date.now() - startedAt) / 1000),
      rssMB: Math.round(usage.rss / 1_048_576),
      heapUsedMB: Math.round(usage.heapUsed / 1_048_576),
      heapTotalMB: Math.round(usage.heapTotal / 1_048_576),
      heapLimitMB,
      perfMeasures: performance.getEntriesByType("measure").length,
      nodeEnv: process.env.NODE_ENV ?? "",
    };
    appendFileSync(TRACE, `${JSON.stringify(record)}\n`);
  }, INTERVAL_MS);
  timer.unref();
}
