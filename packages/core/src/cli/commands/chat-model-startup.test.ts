import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const screenMode of ["inline", "auto"] as const) {
  test(`actual ${screenMode} chat selects a missing subscription model before entering the basic REPL`, async () => {
    const result = await runStartup(screenMode, true);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /MODEL_SELECTION_PROMPT/);
    assert.match(result.output, /进入多轮对话/);
    assert.match(result.output, /fixture-model/);
    assert.doesNotMatch(result.output, /未选择 ChatGPT 模型|model_unavailable/);
  });
}

test("non-interactive basic chat without a model explains --model before accessing auth", async () => {
  const result = await runStartup("inline", false);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /--model <slug>/);
  assert.doesNotMatch(result.output, /AUTH_ACCESS|进入多轮对话|未选择 ChatGPT 模型/);
});

async function runStartup(screenMode: "inline" | "auto", interactive: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "roll-chat-model-startup-"));
  try {
    const clackUrl = import.meta.resolve("@clack/prompts");
    const authSource = `export function getChatGptAuthService() {
      process.stderr.write('AUTH_ACCESS\\n');
      return {
        status: async () => ({ currentAccountId: 'fixture-account' }),
        models: async () => [{ slug: 'fixture-model', displayName: 'Fixture', reasoningEfforts: ['medium'] }],
        cachedModels: () => [],
        getAccessToken: async () => 'synthetic-token'
      };
    }`;
    const clackSource = `export * from ${JSON.stringify(`${clackUrl}?original`)};
      export async function select(options) {
        if (options.message !== '选择 ChatGPT 订阅模型') throw new Error('Unexpected selection');
        process.stderr.write('MODEL_SELECTION_PROMPT\\n');
        return options.options[0].value;
      }`;
    writeFileSync(
      join(directory, "loader.mjs"),
      `export async function load(url, context, next) {
      if (url.endsWith('/auth/chatgpt/service.ts')) return {format:'module',shortCircuit:true,source:${JSON.stringify(authSource)}};
      if (url === ${JSON.stringify(clackUrl)}) return {format:'module',shortCircuit:true,source:${JSON.stringify(clackSource)}};
      return next(url, context);
    }`,
    );
    const preload = join(directory, "preload.mjs");
    writeFileSync(
      preload,
      `import os from 'node:os';
      import { register, syncBuiltinESMExports } from 'node:module';
      os.homedir = () => ${JSON.stringify(directory)};
      syncBuiltinESMExports();
      register(new URL('./loader.mjs', import.meta.url));
      Object.defineProperty(process.stdin, 'isTTY', {value:${interactive}});
      Object.defineProperty(process.stdout, 'isTTY', {value:${interactive}});
      Object.defineProperty(process.stderr, 'isTTY', {value:${interactive}});
      process.stdin.setRawMode = () => process.stdin;
      globalThis.fetch = async () => { throw new Error('NETWORK_ISOLATED'); };
    `,
    );
    writeFileSync(
      join(directory, "roll.config.yaml"),
      JSON.stringify({
        llm: { defaultProvider: "openai", defaultModel: "api-model", providers: {} },
        runtime: {
          provider: "chatgpt",
          threadsDir: join(directory, "threads"),
          shell: { enabled: false },
        },
        agents: { dataDir: join(directory, "agents") },
        scheduler: { dataDir: join(directory, "scheduler") },
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
        "chat",
        "--screen-mode",
        screenMode,
      ],
      { cwd: directory, env: { ...process.env, TERM: "dumb" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let exiting = false;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (!exiting && output.includes("进入多轮对话")) {
        exiting = true;
        child.stdin.write("exit\n");
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, output };
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
