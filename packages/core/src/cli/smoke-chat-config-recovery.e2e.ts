import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { loadRuntimeConfig } from "../config/runtime-context.ts";
import {
  cleanupSpawnedRollProcess,
  exitRollChat,
  formatSpawnedRollProcess,
  waitForSmokeCondition,
  type SpawnedRollProcess,
} from "./smoke.e2e-harness.ts";

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roll chat config recovery-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const settings = join(root, "settings");
  for (const dir of [home, project, settings]) mkdirSync(dir);
  const calls: Array<{ path: string; body: unknown; authorization: string | undefined }> = [];
  const registryCalls: string[] = [];
  const failures: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    if (request.method === "GET" && path.startsWith("/registry/")) {
      registryCalls.push(path);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture has no installable packages" }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        calls.push({ path, body, authorization: request.headers.authorization });
        const text = `fixture-reply-${String(calls.length)}`;
        const frames =
          path === "/responses"
            ? [
                {
                  type: "response.created",
                  response: { id: "response-fixture", created_at: 1, model: "review-model" },
                },
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "message", id: "message-fixture" },
                },
                {
                  type: "response.output_text.delta",
                  item_id: "message-fixture",
                  output_index: 0,
                  delta: text,
                },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: { type: "message", id: "message-fixture" },
                },
                {
                  type: "response.completed",
                  response: { status: "completed", usage: { input_tokens: 10, output_tokens: 3 } },
                },
              ]
            : [
                {
                  id: "chat-fixture",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "qwen3.7-plus",
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                },
                {
                  id: "chat-fixture",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "qwen3.7-plus",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                },
              ];
        assert.ok(path === "/responses" || path === "/v1/chat/completions", path);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
            (path === "/responses" ? "" : "data: [DONE]\n\n"),
        );
      } catch (error) {
        failures.push(String(error));
        response.writeHead(500);
        response.end("fixture failed");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${String(address.port)}`;
  const preload = join(root, "preload.mjs");
  const source = (path: string) =>
    JSON.stringify(pathToFileURL(resolve(import.meta.dirname, path)).href);
  writeFileSync(
    preload,
    `
import { ChatGptAuthService } from ${source("../auth/chatgpt/service.ts")};
import { ModelCatalog } from ${source("../../../runtime/src/engine/model-catalog.ts")};
import { clackPromptAdapter } from ${source("./commands/config-prompts.ts")};
const models = [{ slug: 'review-model', displayName: 'Review', reasoningEfforts: ['medium'], contextWindow: 100000 }];
ChatGptAuthService.prototype.status = async () => ({ currentAccountId: 'fixture', accounts: [{ id: 'fixture', label: 'Fixture', connected: true, authorized: true }], usageUrl: 'https://example.invalid' });
ChatGptAuthService.prototype.cachedModels = () => models;
ChatGptAuthService.prototype.models = async () => models;
ChatGptAuthService.prototype.getAccessToken = async () => 'fixture-token';
ModelCatalog.prototype.refreshIfStale = async () => 'skipped';
if (process.env.ROLL_P2_ONBOARDING_FIXTURE === '1') {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true });
  Object.assign(clackPromptAdapter, {
    confirm: async () => true,
    select: async () => 'qwen',
    text: async (input) => input.message.includes('base-url') ? ${JSON.stringify(endpoint + "/v1")} : (input.defaultValue ?? ''),
    password: async () => 'fixture-password',
    multiselect: async () => {
      // Script only the onboarding answers, then exercise the real piped REPL.
      process.stdin.isTTY = false;
      process.stderr.isTTY = false;
      return [];
    },
  });
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') return originalFetch(${JSON.stringify(endpoint + "/responses")}, options);
  if (url.hostname !== '127.0.0.1') throw new Error('External network blocked');
  return originalFetch(input, options);
};
`,
  );
  const processes: SpawnedRollProcess[] = [];
  const start = (args: readonly string[], wizard = false): SpawnedRollProcess => {
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dirname, "index.ts"), "chat", "--screen-mode", "inline", ...args],
      {
        cwd: project,
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
          NODE_OPTIONS: `--experimental-strip-types --experimental-sqlite --import=${pathToFileURL(preload).href}`,
          NODE_NO_WARNINGS: "1",
          NO_COLOR: "1",
          NO_PROXY: "127.0.0.1",
          TEMP: root,
          TMP: root,
          ...(wizard ? { ROLL_P2_ONBOARDING_FIXTURE: "1" } : {}),
          ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
          ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
        },
        stdio: "pipe",
      },
    );
    const output = { stdout: "", stderr: "" };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output.stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.stdin.on("error", () => {});
    const spawned = { child, output };
    processes.push(spawned);
    return spawned;
  };
  const wait = (child: SpawnedRollProcess, label: string, check: () => boolean) =>
    waitForSmokeCondition(
      label,
      () => {
        if (child.child.exitCode !== null) throw new Error(formatSpawnedRollProcess(label, child));
        return check();
      },
      () => formatSpawnedRollProcess(label, child),
      25_000,
    );
  t.after(async () => {
    for (const child of processes) await cleanupSpawnedRollProcess(child, "chat config fixture");
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  });
  return { home, project, settings, endpoint, calls, registryCalls, failures, start, wait };
}

test(
  "real CLI onboarding writes and executes from the explicit source while preserving a conflicting project config",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const configPath = join(f.settings, "roll.config.yaml");
    const selected = {
      llm: { defaultProvider: "qwen", defaultModel: "qwen3.7-plus", providers: {} },
      agents: { dataDir: "./agents" },
      install: { registry: `${f.endpoint}/registry` },
      runtime: {
        threadsDir: "./history",
        thinkingLevel: "off",
        compaction: { enabled: false },
        shell: { enabled: false },
      },
      chat: { instructions: "off", screenMode: "inline" },
    };
    const foreign = join(f.project, "roll.config.yaml");
    writeFileSync(configPath, JSON.stringify(selected));
    writeFileSync(
      foreign,
      JSON.stringify({
        ...selected,
        llm: {
          ...selected.llm,
          providers: { qwen: { apiKey: "foreign-key", baseUrl: `${f.endpoint}/wrong` } },
        },
      }),
    );
    const before = readFileSync(foreign);
    const child = f.start(["--config", configPath, "--config-workspace", f.settings], true);
    await f.wait(child, "onboarded CLI prompt", () => child.output.stdout.includes("› "));
    assert.deepEqual(readFileSync(foreign), before);
    const applied = loadRuntimeConfig({ configPath, configWorkspace: f.settings }).config;
    assert.equal(applied.llm.providers.qwen?.apiKey, "fixture-password");
    assert.equal(existsSync(join(f.project, "agents")), false);
    assert.ok(f.registryCalls.length > 0, "catalog requests must use the selected registry");
    child.child.stdin.write("onboarded-message\n");
    await f.wait(child, "real configured model reply", () =>
      child.output.stdout.includes("fixture-reply-1"),
    );
    assert.equal(f.calls[0]?.path, "/v1/chat/completions");
    assert.equal(f.calls[0]?.authorization, "Bearer fixture-password");
    assert.ok(JSON.stringify(f.calls[0]?.body).includes("onboarded-message"));
    await exitRollChat(child, "onboarded CLI");
    assert.deepEqual(f.failures, []);
  },
);

test(
  "real no-config ChatGPT CLI keeps sending and preserving history after unsupported reload",
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const child = f.start(["--provider", "chatgpt", "--model", "review-model"]);
    await f.wait(child, "no-config CLI prompt", () => child.output.stdout.includes("› "));
    child.child.stdin.write("/reload\n");
    await f.wait(child, "unsupported reload notice", () =>
      child.output.stderr.includes("未绑定配置文件"),
    );
    child.child.stdin.write("first-unbound-message\n");
    await f.wait(child, "first real subscription reply", () =>
      child.output.stdout.includes("fixture-reply-1"),
    );
    const after = child.output.stderr.length;
    writeFileSync(join(f.project, "roll.config.yaml"), "runtime:\n  model: must-not-rebind\n");
    child.child.stdin.write("/reload\n");
    await f.wait(child, "still unbound after new file", () =>
      child.output.stderr.slice(after).includes("未绑定配置文件"),
    );
    child.child.stdin.write("second-unbound-message\n");
    await f.wait(child, "second real subscription reply", () =>
      child.output.stdout.includes("fixture-reply-2"),
    );
    assert.equal(f.calls.length, 2);
    assert.equal(z.object({ model: z.string() }).parse(f.calls[1]?.body).model, "review-model");
    assert.match(JSON.stringify(f.calls[1]?.body), /first-unbound-message/u);
    assert.match(JSON.stringify(f.calls[1]?.body), /second-unbound-message/u);
    assert.doesNotMatch(child.output.stderr, /模型配置应用失败/u);
    await exitRollChat(child, "unbound CLI");
    assert.deepEqual(f.failures, []);
  },
);
