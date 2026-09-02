#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";

const repoRoot = resolvePath(import.meta.dirname, "../..");
const benchDir = resolvePath(import.meta.dirname);

const rawArgs = process.argv.slice(2);
const { values: options } = parseArgs({
  args: rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs,
  options: {
    mode: { type: "string", default: "fixed" },
    entry: { type: "string", default: "src" },
    duration: { type: "string", default: "180" },
    warmup: { type: "string", default: "30" },
    "max-slope": { type: "string", default: "30" },
    "reasoning-chars": { type: "string", default: "8000" },
    "delta-ms": { type: "string", default: "25" },
    columns: { type: "string", default: "170" },
    rows: { type: "string", default: "45" },
    keep: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (options.help) {
  process.stdout.write(`用法: node scripts/bench/chat-heap-growth.mjs [选项]

在 tmux 里启动真实的 roll chat（Ink 全屏 REPL），用本地假 DashScope SSE 服务持续输出长 reasoning +
工具调用，采样 GC 后的堆占用，输出堆增长斜率并给出 PASS/FAIL。

选项:
  --mode fixed|baseline   fixed: 使用 CLI 默认（NODE_ENV=production）；baseline: 强制 NODE_ENV=development 复现修复前行为
  --entry src|dist        运行源码入口（默认）或 packages/core/dist 构建产物
  --duration <秒>         采样总时长，默认 180
  --warmup <秒>           计算斜率时跳过的起始秒数，默认 30
  --max-slope <MB/min>    PASS 阈值，默认 30（修复后本机约 14，修复前约 150）
  --reasoning-chars <n>   每步 reasoning 字数，默认 8000
  --delta-ms <ms>         SSE 增量间隔，默认 25（每 10 字）
  --columns/--rows        tmux 窗口尺寸，默认 170x45
  --keep                  保留临时目录与日志
  --json                  额外输出一行 JSON 结果
`);
  process.exit(0);
}

const MODES = new Set(["fixed", "baseline"]);
const ENTRIES = new Set(["src", "dist"]);
if (!MODES.has(options.mode) || !ENTRIES.has(options.entry)) {
  fail(`--mode 只接受 fixed|baseline，--entry 只接受 src|dist`);
}

const durationSeconds = Number(options.duration);
const warmupSeconds = Number(options.warmup);
const maxSlope = Number(options["max-slope"]);
const columns = Number(options.columns);
const rows = Number(options.rows);
if (![durationSeconds, warmupSeconds, maxSlope, columns, rows].every(Number.isFinite)) {
  fail("数值参数必须是数字");
}
if (durationSeconds <= warmupSeconds + 20) {
  fail("--duration 至少要比 --warmup 多 20 秒");
}

function fail(message) {
  process.stderr.write(`[chat-heap-growth] ${message}\n`);
  process.exit(2);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmux(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFailure) {
      return undefined;
    }
    throw error;
  }
}

function requireTmux() {
  if (tmux(["-V"], { allowFailure: true }) === undefined) {
    fail("需要 tmux（Ink 全屏 REPL 只在真实 PTY 下启用）");
  }
}

function resolveEntry() {
  if (options.entry === "dist") {
    const dist = join(repoRoot, "packages/core/dist/cli/index.js");
    if (!existsSync(dist)) {
      fail("--entry dist 需要先执行 pnpm --filter @roll-agent/core build");
    }
    return dist;
  }
  return join(repoRoot, "packages/core/src/cli/index.ts");
}

function startFakeServer(logsDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(benchDir, "fake-dashscope-server.mjs")], {
      env: {
        ...process.env,
        FAKE_LLM_PORT: "0",
        FAKE_LLM_LOG: join(logsDir, "fake-llm.log"),
        FAKE_LLM_REASONING_CHARS: options["reasoning-chars"],
        FAKE_LLM_DELTA_MS: options["delta-ms"],
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part) => {
      buffered += part;
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        resolve({ child, port: Number(buffered.slice(0, newline)) });
      }
    });
    child.on("exit", (code) => reject(new Error(`fake server exited early (code ${code})`)));
  });
}

function writeConfig(root, port) {
  const config = [
    "llm:",
    "  default-provider: qwen",
    "  default-model: bench-fake-reasoning",
    "  providers:",
    "    qwen:",
    "      api-key: bench",
    `      base-url: http://127.0.0.1:${port}`,
    "ask: {}",
    "agents:",
    `  data-dir: ${join(root, "home/agents-data")}`,
    "runtime:",
    "  max-steps: 100000",
    "  turn-timeout-ms: 86400000",
    `  threads-dir: ${join(root, "home/threads")}`,
    "",
  ].join("\n");
  writeFileSync(join(root, "work/roll.config.yaml"), config);
  writeFileSync(join(root, "work/probe.txt"), "probe line 1\nprobe line 2\nprobe line 3\n");
}

async function waitForPrompt(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = tmux(["capture-pane", "-p", "-t", session], { allowFailure: true });
    if (screen === undefined) {
      return false;
    }
    if (screen.includes("›")) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

function leastSquaresSlopePerMinute(samples) {
  const n = samples.length;
  const meanT = samples.reduce((sum, sample) => sum + sample.t, 0) / n;
  const meanHeap = samples.reduce((sum, sample) => sum + sample.heapUsedMB, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += (sample.t - meanT) * (sample.heapUsedMB - meanHeap);
    denominator += (sample.t - meanT) ** 2;
  }
  return denominator === 0 ? 0 : (numerator / denominator) * 60;
}

function readTrace(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function countCompletedSteps(logPath) {
  if (!existsSync(logPath)) {
    return 0;
  }
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => / done$/.test(line)).length;
}

async function main() {
  requireTmux();
  const entry = resolveEntry();
  const root = mkdtempSync(join(tmpdir(), "roll-chat-heap-bench-"));
  const logsDir = join(root, "logs");
  for (const dir of ["home/threads", "work", "logs"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const session = `roll-heap-bench-${process.pid}`;
  let server;
  try {
    server = await startFakeServer(logsDir);
    writeConfig(root, server.port);
    const tracePath = join(logsDir, "trace.jsonl");
    const env = {
      HOME: join(root, "home"),
      ROLL_BENCH_TRACE: tracePath,
      NODE_OPTIONS: `--import ${join(benchDir, "heap-sampler.mjs")} --expose-gc`,
      ...(options.mode === "baseline" ? { NODE_ENV: "development" } : {}),
    };
    const envPrefix = Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const nodeFlags =
      options.entry === "src"
        ? "--disable-warning=ExperimentalWarning --experimental-strip-types --experimental-sqlite"
        : "--disable-warning=ExperimentalWarning --experimental-sqlite";
    const command = `cd ${shellQuote(join(root, "work"))} && env -u NODE_ENV ${envPrefix} ${shellQuote(process.execPath)} ${nodeFlags} ${shellQuote(entry)} chat 2> ${shellQuote(join(logsDir, "chat-stderr.log"))}; sleep 5`;
    tmux(["new-session", "-d", "-s", session, "-x", String(columns), "-y", String(rows), command]);
    if (!(await waitForPrompt(session, 30_000))) {
      const stderr = existsSync(join(logsDir, "chat-stderr.log"))
        ? readFileSync(join(logsDir, "chat-stderr.log"), "utf8")
        : "";
      throw new Error(`roll chat 未在 30s 内进入输入状态\n${stderr}`);
    }
    tmux(["send-keys", "-t", session, "-l", "开始连续工作，读取 probe.txt"]);
    tmux(["send-keys", "-t", session, "Enter"]);
    process.stderr.write(
      `[chat-heap-growth] mode=${options.mode} entry=${options.entry} 采样 ${durationSeconds}s（tmux 会话 ${session}）\n`,
    );
    const deadline = Date.now() + durationSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(5_000);
      if (tmux(["has-session", "-t", session], { allowFailure: true }) === undefined) {
        throw new Error("roll chat 进程提前退出，见 logs/chat-stderr.log");
      }
    }
    tmux(["kill-session", "-t", session], { allowFailure: true });
    await sleep(500);

    const trace = readTrace(tracePath);
    const measured = trace.filter((sample) => sample.t >= warmupSeconds);
    if (measured.length < 4) {
      throw new Error(`采样点不足（${measured.length}），无法计算斜率`);
    }
    const slope = leastSquaresSlopePerMinute(measured);
    const first = measured[0];
    const last = measured[measured.length - 1];
    const projectedMinutes =
      slope > 0.5 ? Math.round((last.heapLimitMB - last.heapUsedMB) / slope) : Infinity;
    const result = {
      mode: options.mode,
      entry: options.entry,
      nodeEnv: last.nodeEnv,
      samples: measured.length,
      windowSeconds: last.t - first.t,
      heapStartMB: first.heapUsedMB,
      heapEndMB: last.heapUsedMB,
      rssEndMB: last.rssMB,
      heapLimitMB: last.heapLimitMB,
      slopeMBPerMinute: Number(slope.toFixed(1)),
      projectedMinutesToHeapLimit: projectedMinutes,
      perfMeasureEntries: last.perfMeasures,
      completedSteps: countCompletedSteps(join(logsDir, "fake-llm.log")),
      pass: slope <= maxSlope,
    };
    const lines = [
      `模式            ${result.mode}（NODE_ENV=${result.nodeEnv || "<未设置>"}，entry=${result.entry}）`,
      `采样窗口        ${result.windowSeconds}s / ${result.samples} 个点（跳过前 ${warmupSeconds}s）`,
      `完成步数        ${result.completedSteps}`,
      `堆占用(GC 后)   ${result.heapStartMB}MB → ${result.heapEndMB}MB（RSS ${result.rssEndMB}MB，堆上限 ${result.heapLimitMB}MB）`,
      `堆增长斜率      ${result.slopeMBPerMinute} MB/min（阈值 ${maxSlope}）`,
      `撞上限预计      ${Number.isFinite(projectedMinutes) ? `${projectedMinutes} 分钟` : "不会（增长≈0）"}`,
      `perf measure    ${result.perfMeasureEntries} 条滞留（production 构建应为 0）`,
      `结论            ${result.pass ? "PASS" : "FAIL"}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    if (options.keep) {
      process.stderr.write(`[chat-heap-growth] 已保留: ${root}\n`);
    }
    process.exitCode = result.pass ? 0 : 1;
  } finally {
    tmux(["kill-session", "-t", session], { allowFailure: true });
    server?.child.kill();
    if (!options.keep) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
