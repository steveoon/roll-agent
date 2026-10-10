import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("interactive API-key chat reaches its prompt without accessing subscription auth or networking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-chat-startup-"));
  const preload = join(dir, "preload.mjs");
  writeFileSync(
    join(dir, "loader.mjs"),
    `export async function load(url, context, next) {
    if (url.endsWith('/auth/chatgpt/service.ts')) return { format: 'module', shortCircuit: true,
      source: 'export function getChatGptAuthService() { throw new Error("SUBSCRIPTION_STARTUP_ACCESS"); }' };
    return next(url, context);
  }`,
  );
  writeFileSync(
    preload,
    `import { register } from 'node:module';
    register(new URL('./loader.mjs', import.meta.url));
    Object.defineProperty(process.stdin, 'isTTY', {value:true});
    Object.defineProperty(process.stderr, 'isTTY', {value:true});
    globalThis.fetch = async () => { throw new Error('NETWORK_ISOLATED'); };
  `,
  );
  writeFileSync(
    join(dir, "roll.config.yaml"),
    JSON.stringify({
      llm: {
        defaultProvider: "openai",
        defaultModel: "api-startup-model",
        providers: { openai: { apiKey: "fixture" } },
      },
      runtime: { threadsDir: join(dir, "threads"), shell: { enabled: false } },
      agents: { dataDir: join(dir, "agents") },
      scheduler: { dataDir: join(dir, "scheduler") },
      chat: { instructions: "off" },
    }),
  );
  try {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-sqlite",
        "--import",
        preload,
        fileURLToPath(new URL("../index.ts", import.meta.url)),
        "chat",
        "--screen-mode",
        "inline",
      ],
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    let sawPrompt = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!sawPrompt && stderr.includes("api-startup-model")) {
        sawPrompt = true;
        child.stdin.write("exit\n");
      }
    });
    child.stdout.resume();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }).finally(() => clearTimeout(timeout));
    assert.equal(code, 0, stderr);
    assert.equal(sawPrompt, true, stderr);
    assert.doesNotMatch(stderr, /SUBSCRIPTION_STARTUP_ACCESS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
