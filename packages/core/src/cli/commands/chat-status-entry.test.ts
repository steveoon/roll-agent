import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CASES = [
  { name: "enabled basic", tty: [true, true, true], hc: "t-fixture", args: [], enabled: true },
  { name: "no HC identity", tty: [true, true, true], hc: "", args: [], enabled: false },
  { name: "stdin pipe", tty: [false, true, true], hc: "t-fixture", args: [], enabled: false },
  { name: "stdout pipe", tty: [true, false, true], hc: "t-fixture", args: [], enabled: false },
  { name: "stderr pipe", tty: [true, true, false], hc: "t-fixture", args: [], enabled: false },
  {
    name: "JSON interactive",
    tty: [true, true, true],
    hc: "t-fixture",
    args: ["--json"],
    enabled: false,
  },
  { name: "one shot", tty: [true, true, true], hc: "t-fixture", args: ["hello"], enabled: false },
  {
    name: "JSON one shot",
    tty: [true, true, true],
    hc: "t-fixture",
    args: ["hello", "--json"],
    enabled: false,
  },
  { name: "server", tty: [true, true, true], hc: "t-fixture", args: ["--server"], enabled: false },
  { name: "runtime stdio", tty: [true, true, true], hc: "t-fixture", args: [], enabled: false },
  {
    name: "Ink startup fallback",
    tty: [true, true, true],
    hc: "t-fixture",
    args: ["--screen-mode", "fullscreen"],
    enabled: true,
  },
] as const;

for (const entry of CASES) {
  test(`actual CLI OSC exclusion: ${entry.name}`, { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-status-entry-"));
    const preload = join(dir, "preload.mjs");
    writeFileSync(
      join(dir, "loader.mjs"),
      `export async function load(url, context, next) {
      if (url.endsWith('/chat/ink/run-ink-repl.ts')) return { format:'module',shortCircuit:true,
        source:'export async function runInkRepl() { throw new Error("FIXTURE_INK_STARTUP_FAILURE"); }' };
      return next(url, context);
    }`,
    );
    writeFileSync(
      preload,
      `import os from 'node:os';
import { syncBuiltinESMExports, register } from 'node:module';
if (${entry.name === "Ink startup fallback"}) register(new URL('./loader.mjs', import.meta.url));
process.stdin.setRawMode = () => process.stdin;
os.homedir = () => ${JSON.stringify(dir)}; syncBuiltinESMExports();
process.env.HC_TERMINAL_ID = ${JSON.stringify(entry.hc)};
for (const [i, stream] of [process.stdin, process.stdout, process.stderr].entries())
  Object.defineProperty(stream, 'isTTY', {value: ${JSON.stringify(entry.tty)}[i]});
globalThis.fetch = async () => new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{content:'ok'},finish_reason:null}]})+'\\n\\ndata: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
`,
    );
    writeFileSync(
      join(dir, "roll.config.yaml"),
      JSON.stringify({
        llm: {
          defaultProvider: "deepseek",
          defaultModel: "fixture",
          providers: { deepseek: { apiKey: "fixture" } },
        },
        runtime: { threadsDir: join(dir, "threads"), shell: { enabled: false } },
        agents: { dataDir: join(dir, "agents") },
        scheduler: { dataDir: join(dir, "scheduler") },
        chat: { instructions: "off" },
      }),
    );
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-sqlite",
        "--import",
        preload,
        fileURLToPath(new URL("../index.ts", import.meta.url)),
        ...(entry.name === "runtime stdio" ? ["runtime", "serve", "--stdio"] : ["chat"]),
        ...(entry.args.length === 0 && entry.name !== "runtime stdio"
          ? ["--screen-mode", "inline"]
          : []),
        ...entry.args,
      ],
      // This is an entry/gating matrix, not a terminal emulator. Keep ora off
      // even when the parent has no CI markers; real rendering is covered by PTY tests.
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "1" } },
    );
    let stdout = "";
    let stderr = "";
    let entered = false;
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!entered && stderr.includes("进入多轮对话")) {
        entered = true;
        // Let readline install its next question after the readiness banner.
        setTimeout(() => child.stdin.write("exit\n"), 20);
      }
      if (stderr.includes("stdio JSON-RPC")) child.stdin.end();
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      assert.equal(await finished, entry.name === "JSON interactive" ? 1 : 0, stderr + stdout);
      if (entry.name === "JSON interactive") {
        assert.ok(stderr.includes("--json 模式需要消息"), stderr + stdout);
      }
      if (entry.name === "one shot") {
        assert.ok(stdout.includes("ok"), stderr + stdout);
      }
      if (entry.name === "JSON one shot") {
        const result: unknown = JSON.parse(stdout);
        assert.ok(
          result !== null &&
            typeof result === "object" &&
            "status" in result &&
            result.status === "completed" &&
            "output" in result &&
            result.output === "ok",
          stderr + stdout,
        );
      }
      if (entry.name === "server" || entry.name === "runtime stdio") {
        assert.ok(stderr.includes("stdio JSON-RPC，等待客户端连接"), stderr + stdout);
      }
      assert.ok(!stdout.includes("\u001B]7501;"));
      if (entry.enabled) {
        assert.ok(stderr.includes("\u001B]7501;state=idle:app=roll\u001B\\"));
        assert.equal(stderr.split("\u001B]7501;state=clear\u001B\\").length - 1, 1);
      } else assert.ok(!stderr.includes("\u001B]7501;"));
      if (entry.args.length === 0 && entry.name !== "runtime stdio") assert.equal(entered, true);
      if (entry.name === "Ink startup fallback") {
        assert.ok(stderr.includes("FIXTURE_INK_STARTUP_FAILURE"));
      }
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
