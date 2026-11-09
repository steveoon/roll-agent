import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import * as runtime from "@roll-agent/runtime";
import type { ConversationEngineOptions } from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import { createThreadModelHost, withThreadModelReasoning } from "./thread-model-host.ts";
import { createRuntimeChatEngine } from "./engine-factory.ts";

test("configured model pairs are exact, bounded and distinct across providers", async () => {
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/unused" },
    llm: {
      defaultProvider: "p",
      defaultModel: "legacy-default",
      providers: {
        p: { apiKey: "secret-p", models: ["same", "same"] },
        q: { apiKey: "secret-q", models: ["same"] },
        chatgpt: { apiKey: "", models: ["subscription"] },
      },
    },
  });
  const initial = { provider: "p", modelName: "legacy-default", model: new MockLanguageModelV4() };
  const host = createThreadModelHost(config, initial);
  const catalog = host.catalog();
  assert.deepEqual(
    catalog.items.map(({ provider, model }) => `${provider}/${model}`),
    ["p/same", "q/same", "chatgpt/subscription", "p/legacy-default"],
  );
  assert.equal(catalog.items.find((item) => item.provider === "chatgpt")?.available, false);
  assert.doesNotMatch(JSON.stringify(catalog), /secret-|apiKey|baseUrl|providerOptions/u);
  assert.equal(
    await host.prepare({ provider: "p", model: "legacy-default" }, new AbortController().signal),
    initial,
  );
  await assert.rejects(
    host.prepare({ provider: "p", model: "invented" }, new AbortController().signal),
  );
  assert.notEqual(
    createThreadModelHost(config, initial).catalog().configRevision,
    catalog.configRevision,
  );
});

test("execution projection drops Core-only resolver state and stale reasoning classification", () => {
  const input = {
    provider: "test",
    modelName: "test",
    model: new MockLanguageModelV4(),
    reasoning: "text",
    connection: { credential: "private" },
    config: { key: "private" },
  };
  assert.deepEqual(Object.keys(withThreadModelReasoning(input)).sort(), [
    "model",
    "modelName",
    "provider",
  ]);
});

test("a session opened after reload bootstraps without the previous model's optional parameters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-host-model-reload-"));
  const store = new runtime.ThreadStore(dir);
  const constructed: ConversationEngineOptions[] = [];
  const sampling: unknown[] = [];
  class CapturedEngine extends runtime.ConversationEngine {
    constructor(options: ConversationEngineOptions) {
      constructed.push(options);
      super({
        ...options,
        skillLibrary: null,
        workspaceInstructions: null,
        fileToolsEnabled: false,
        agentHost: {
          async prepare(input) {
            sampling.push(input.providerOptions);
            return { sources: [] };
          },
          async refresh() {
            throw new Error("unused");
          },
          updateSampling() {},
          async dispose() {},
        },
      });
    }
  }
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: dir },
    llm: {
      defaultProvider: "openai",
      defaultModel: "old",
      providers: { openai: { apiKey: "fixture" } },
    },
    runtime: { shell: { enabled: false } },
  });
  const engine = createRuntimeChatEngine({
    runtime: { ...runtime, ConversationEngine: CapturedEngine },
    config,
    store,
    surface: "server",
    model: new MockLanguageModelV4(),
    providerOptions: { openai: { reasoningEffort: "high" } },
    structuredOutputProviderOptions: { openai: { reasoningEffort: "low" } },
    structuredOutputReasoning: "low",
  });
  try {
    const next = { provider: "test", modelName: "new", model: new MockLanguageModelV4() };
    await engine.reloadModelHost(
      {
        catalog: () => ({
          configRevision: "new",
          defaultModel: { provider: "test", model: "new" },
          items: [{ provider: "test", model: "new", available: true }],
        }),
        prepare: async () => next,
      },
      next,
    );
    await engine.createSession();
    assert.deepEqual(sampling, [undefined]);
    assert.equal(constructed[0]?.providerOptions, undefined);
    assert.equal(constructed[0]?.structuredOutputProviderOptions, undefined);
    assert.equal(constructed[0]?.structuredOutputReasoning, undefined);
  } finally {
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
