import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scenarios = {
  "duplicate on/off skips Engine switching but actual changes retain both option sets": `
    assert.equal(await fastMode.setEnabled(false), true);
    assert.equal(await fastMode.setEnabled(false), true);
    assert.equal(switches.length, 0, 'duplicate off must not switch the Engine');
    assert.equal(await fastMode.setEnabled(true), true);
    assert.equal(switches.length, 1);
    assert.equal(switches[0].providerOptions.openai.serviceTier, 'priority');
    assert.equal(switches[0].structuredOutputProviderOptions.openai.serviceTier, 'priority');
    assert.equal(await fastMode.setEnabled(true), true);
    assert.equal(switches.length, 1, 'duplicate on must not switch the Engine');
    assert.equal(fastMode.getEnabled(), true);
    assert.equal(await fastMode.setEnabled(false), true);
    assert.equal(switches.length, 2);
    assert.equal(switches[1].providerOptions?.openai?.serviceTier, undefined);
    assert.equal(switches[1].structuredOutputProviderOptions?.openai?.serviceTier, undefined);
    assert.equal(await fastMode.setEnabled(false), true);
    assert.equal(switches.length, 2);
  `,
  "duplicate on still validates live capability and reports failure": `
    await fastMode.setEnabled(true);
    switches.length = 0;
    connection.updateCatalog(
      connection.models.map(model => ({ ...model, supportsFastMode: false })),
      connection.accountId,
    );
    await assert.rejects(fastMode.setEnabled(true), error => error.code === 'unsupported_fast_mode');
    assert.equal(fastMode.getEnabled(), true);
    assert.equal(fastMode.getRequestedEnabled(), true);
    assert.equal(switches.length, 0);
    await fastMode.setEnabled(false);
    assert.equal(fastMode.getEnabled(), false);
    assert.equal(switches.length, 1, 'disabling must not require Fast capability');
  `,
  "duplicate off supersedes pending on after either late connection outcome": `
    const ensure = connection.ensure;
    try {
      for (const outcome of ['connected', 'failed']) {
        const pending = Promise.withResolvers();
        connection.ensure = () => pending.promise;
        const enabling = fastMode.setEnabled(true);
        assert.equal(fastMode.getRequestedEnabled(), true);
        assert.equal(fastMode.getEnabled(), false);
        assert.equal(await fastMode.setEnabled(false), true);
        assert.equal(switches.length, 0, 'no-op off must invalidate pending on without switching');
        if (outcome === 'connected') pending.resolve();
        else pending.reject(new Error('late connection failure'));
        assert.equal(await enabling, false);
        assert.equal(fastMode.getRequestedEnabled(), false);
        assert.equal(fastMode.getEnabled(), false);
        assert.equal(switches.length, 0);
      }
    } finally {
      connection.ensure = ensure;
    }
  `,
  "off on an API provider clears the saved preference despite its masked UI state": `
    await fastMode.setEnabled(true);
    await options.modelSwitching.switchTo('openai/api-fixture');
    assert.equal(fastMode.isAvailable(), false);
    assert.equal(fastMode.getEnabled(), false);
    switches.length = 0;
    await assert.rejects(fastMode.setEnabled(true), /Fast 模式仅适用于 ChatGPT/);
    assert.equal(await fastMode.setEnabled(false), true);
    assert.equal(await fastMode.setEnabled(false), true);
    assert.equal(switches.length, 0, 'clearing a saved preference must not touch the API model');
    await options.modelSwitching.switchTo('chatgpt/fixture-model');
    assert.equal(fastMode.isAvailable(), true);
    assert.equal(fastMode.getEnabled(), false);
    assert.equal(switches.length, 1);
    assert.equal(switches[0].providerOptions?.openai?.serviceTier, undefined);
    assert.equal(switches[0].structuredOutputProviderOptions?.openai?.serviceTier, undefined);
    await fastMode.setEnabled(false);
    assert.equal(switches.length, 1);
  `,
};

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`actual CLI Fast wiring: ${name}`, { timeout: 20_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "roll-chat-fast-mode-"));
    try {
      // Replace only auth and the UI boundary, not the real controller/apply callback/Engine.
      const authSource = `
        const models = [{ slug: 'fixture-model', displayName: 'Fixture',
          reasoningEfforts: ['medium'], supportsFastMode: true }];
        export function getChatGptAuthService() {
          return {
            status: async () => ({ currentAccountId: 'fixture-account' }),
            models: async () => models,
            cachedModels: () => models,
            getAccessToken: async () => { throw new Error('UNEXPECTED_INFERENCE'); },
          };
        }
      `;
      const uiSource = `
        import assert from 'node:assert/strict';
        import { ConversationEngine } from ${JSON.stringify(import.meta.resolve("@roll-agent/runtime"))};
        export async function runInkRepl(_session, _store, _isNew, options) {
          options.onStarted();
          const { fastMode, connection } = options;
          const switches = [];
          const original = ConversationEngine.prototype.switchModel;
          ConversationEngine.prototype.switchModel = function(selection) {
            const result = original.call(this, selection);
            switches.push(selection);
            return result;
          };
          try {
            ${scenario}
            process.stdout.write('FAST_WIRING_PASSED\\n');
          } catch (error) {
            process.stderr.write(String(error.stack ?? error) + '\\n');
            process.exitCode = 1;
          } finally {
            ConversationEngine.prototype.switchModel = original;
          }
        }
      `;
      writeFileSync(
        join(directory, "loader.mjs"),
        `export async function load(url, context, next) {
          if (url.endsWith('/auth/chatgpt/service.ts')) return {
            format: 'module', shortCircuit: true, source: ${JSON.stringify(authSource)} };
          if (url.endsWith('/chat/ink/run-ink-repl.ts')) return {
            format: 'module', shortCircuit: true, source: ${JSON.stringify(uiSource)} };
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
        for (const stream of [process.stdin, process.stdout, process.stderr]) {
          Object.defineProperty(stream, 'isTTY', { value: true });
        }
        process.stdin.setRawMode = () => process.stdin;
        globalThis.fetch = async () => { throw new Error('NETWORK_ISOLATED'); };
      `,
      );
      writeFileSync(
        join(directory, "roll.config.yaml"),
        JSON.stringify({
          llm: {
            defaultProvider: "openai",
            defaultModel: "api-fixture",
            providers: { openai: { apiKey: "fixture", models: ["api-fixture"] } },
          },
          runtime: {
            provider: "chatgpt",
            model: "fixture-model",
            fastMode: false,
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
          "fullscreen",
        ],
        {
          cwd: directory,
          env: { ...process.env, HOME: directory, USERPROFILE: directory, TMUX: "" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      const capture = (chunk: Buffer) => {
        output += chunk.toString();
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(code, 0, output);
        assert.match(output, /FAST_WIRING_PASSED/);
        assert.doesNotMatch(output, /UNEXPECTED_INFERENCE/);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
