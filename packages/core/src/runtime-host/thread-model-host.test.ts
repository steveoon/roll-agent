import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { threadModelSetParamsSchema, threadModelStatusSchema } from "@roll-agent/protocol";
import * as runtime from "@roll-agent/runtime";
import type { ConversationEngineOptions } from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import { resolveThreadEffortCapability } from "../llm/providers.ts";
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
          defaultEffort: "medium",
          items: [
            {
              provider: "test",
              model: "new",
              available: true,
              effortCapability: { kind: "unknown" },
            },
          ],
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

test("thread effort capabilities match exact model families, aliases and valid dates", () => {
  const noOff = { kind: "levels", levels: ["low", "medium", "high"] };
  const withOff = { kind: "levels", levels: ["off", ...noOff.levels] };
  const withXhigh = { kind: "levels", levels: [...noOff.levels, "xhigh"] };
  const mediumHigh = { kind: "levels", levels: ["medium", "high"] };
  const toggle = { kind: "toggle", offLevel: "off", onLevel: "medium" };
  const fixed = { kind: "fixed" };
  const unknown = { kind: "unknown" };
  const vertex = (project: string, model: string) =>
    `projects/${project}/locations/global/publishers/google/models/${model}`;

  for (const [provider, models, expected] of [
    ["google", ["gemini-4-neon", vertex("gemini-4-carbon-prod", "gemini-4-hydrogen")], withXhigh],
    [
      "google",
      [vertex("gemini-4-neon-prod", "gemini-4-carbon"), "gemini-4-argon", "gemini-2.5-pro"],
      noOff,
    ],
    ["google", ["gemini-2.5-flash", "gemini-3.8-flash"], withOff],
    ["deepseek", ["deepseek-v4-flash", "deepseek-chat"], toggle],
    ["xai", ["grok-4.20-reasoning", "grok-3"], fixed],
    ["xai", ["grok-4.7"], noOff],
    ["openai", ["gpt-5.5", "gpt-5.4-2026-03-05"], withOff],
    ["openai", ["o3", "o3-pro-2025-06-10"], noOff],
    ["openai", ["gpt-4.1", "gpt-5-pro", "gpt-5-pro-2025-10-06"], fixed],
    [
      "openai",
      [
        "gpt-5.2-pro",
        "gpt-5.2-pro-2025-12-11",
        "gpt-5.4-pro",
        "gpt-5.4-pro-2026-03-05",
        "gpt-5.5-pro",
        "gpt-5.5-pro-2026-06-01",
      ],
      mediumHigh,
    ],
    [
      "openai",
      [
        "gpt-review-unrecognized",
        "gpt-5-review-unrecognized",
        "gpt-5-pro-2025-02-30",
        "gpt-5.4-pro-2026-13-01",
        "gpt-5.5-pro-preview",
        "gpt-5.9-pro",
        "gpt-5.4-2026-02-30",
      ],
      unknown,
    ],
    ["google", ["gemini-review-unrecognized"], unknown],
    ["xai", ["grok-review-unrecognized"], unknown],
    ["deepseek", ["review-unrecognized", "deepseek-review-unrecognized"], unknown],
    ["anthropic", ["claude-review-unrecognized"], unknown],
    ["qwen", ["qwen-review-unrecognized"], unknown],
  ] as const) {
    for (const model of models) {
      assert.deepEqual(
        resolveThreadEffortCapability(provider, model),
        expected,
        `${provider}/${model}`,
      );
    }
  }
});

test("createThreadModelHost preserves custom OpenAI store:false on effort switch and rebuilds startup model when effort differs", async () => {
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/unused" },
    llm: {
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      providers: {
        openai: {
          apiKey: "fixture-key",
          baseUrl: "http://127.0.0.1:18080/v1",
          models: ["gpt-5.5", "gpt-5.4"],
        },
        google: {
          apiKey: "fixture-google",
          models: ["gemini-2.5-pro", "gemini-4-neon", "gemini-4-carbon"],
        },
      },
    },
    runtime: {
      thinkingLevel: "medium",
    },
  });
  const initialModel = new MockLanguageModelV4({
    provider: "openai.responses",
    modelId: "gpt-5.5",
  });
  const initial = {
    provider: "openai",
    modelName: "gpt-5.5",
    model: initialModel,
    effort: "medium" as const,
    providerOptions: { openai: { reasoningEffort: "medium", store: false } },
  };
  const host = createThreadModelHost(config, initial);

  assert.ok(host.prepareEffort);
  const highEffort = host.prepareEffort(initial, "high");
  assert.deepEqual(highEffort.providerOptions, {
    openai: { reasoningEffort: "high", store: false },
  });
  assert.equal(highEffort.reasoning, "summary");

  const offEffort = host.prepareEffort(initial, "off");
  assert.deepEqual(offEffort.providerOptions, {
    openai: { reasoningEffort: "none", store: false },
  });
  assert.equal(offEffort.reasoning, undefined);

  // Switching back to the startup model with the same effort returns initial; a different effort rebuilds.
  assert.equal(
    await host.prepare(
      { provider: "openai", model: "gpt-5.5" },
      new AbortController().signal,
      "medium",
    ),
    initial,
  );
  const rebuiltInitial = await host.prepare(
    { provider: "openai", model: "gpt-5.5" },
    new AbortController().signal,
    "high",
  );
  assert.notEqual(rebuiltInitial, initial);
  assert.deepEqual(rebuiltInitial.providerOptions, {
    openai: { reasoningEffort: "high", store: false },
  });
  assert.equal(rebuiltInitial.effort, "high");

  // Explicit off on gemini-2.5-pro is rejected because off is not advertised as disableable.
  assert.throws(
    () =>
      host.validate?.({
        identity: { provider: "google", model: "gemini-2.5-pro" },
        effort: { mode: "explicit", level: "off" },
        requiresFullModelPrepare: true,
      }),
    (error: unknown) =>
      error instanceof runtime.ThreadModelError && error.reason === "effort-unsupported",
  );
});

test("switching to gemini-2.5-pro or o3 with inherited default off is rejected before mutating revision or pending while preserving legacy startup sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-host-default-inherit-"));
  const store = new runtime.ThreadStore(dir);
  const qwenOffConfig = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: dir },
    llm: {
      defaultProvider: "qwen",
      defaultModel: "qwen3.6-plus",
      providers: {
        qwen: { apiKey: "fixture-qwen", models: ["qwen3.6-plus"] },
        google: { apiKey: "fixture-google", models: ["gemini-2.5-pro"] },
        openai: { apiKey: "fixture-openai", models: ["o3"] },
      },
    },
    runtime: {
      thinkingLevel: "off",
      compaction: { thinkingLevel: "medium" },
      shell: { enabled: false },
    },
  });
  const engine = createRuntimeChatEngine({
    runtime,
    config: qwenOffConfig,
    store,
    surface: "server",
    model: new MockLanguageModelV4({ provider: "alibaba.chat", modelId: "qwen3.6-plus" }),
  });
  try {
    const session = await engine.createSession();
    let busy = true;
    engine.setModelBusyCheck((id) => id === session.id && busy);

    const catalog = engine.getModelCatalog();
    const initial = engine.getThreadModel(session.id);
    const pendingHigh = threadModelStatusSchema.parse(
      await engine.setThreadModel(
        threadModelSetParamsSchema.parse({
          requestId: randomUUID(),
          threadId: session.id,
          expectedRevision: initial.revision,
          configRevision: catalog.configRevision,
          effort: { mode: "explicit", level: "high" },
        }),
      ),
    );
    assert.equal(pendingHigh.status, "pending");
    assert.equal(pendingHigh.target.effectiveEffort, "high");

    for (const target of [
      { provider: "google", model: "gemini-2.5-pro" },
      { provider: "openai", model: "o3" },
    ] as const) {
      await assert.rejects(
        engine.setThreadModel(
          threadModelSetParamsSchema.parse({
            requestId: randomUUID(),
            threadId: session.id,
            expectedRevision: pendingHigh.revision,
            configRevision: catalog.configRevision,
            selection: { mode: "explicit", ...target },
            effort: { mode: "default" },
          }),
        ),
        (error: unknown) =>
          error instanceof runtime.ThreadModelError && error.reason === "effort-unsupported",
      );
      assert.deepEqual(engine.getThreadModel(session.id), pendingHigh);
    }

    busy = false;
    await engine.settleThreadModel(session.id);
    const settled = threadModelStatusSchema.parse(engine.getThreadModel(session.id));
    assert.equal(settled.active?.effort, "high");
  } finally {
    await engine.dispose();
  }

  // Legacy startup session configured directly on gemini-2.5-pro + thinkingLevel:off + compaction:medium still opens and chats.
  const legacyCalls: unknown[] = [];
  const legacyConfig = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: dir },
    llm: {
      defaultProvider: "google",
      defaultModel: "gemini-2.5-pro",
      providers: {
        google: { apiKey: "fixture-google", models: ["gemini-2.5-pro"] },
      },
    },
    runtime: {
      thinkingLevel: "off",
      compaction: { thinkingLevel: "medium" },
      shell: { enabled: false },
    },
  });
  const legacyEngine = createRuntimeChatEngine({
    runtime,
    config: legacyConfig,
    store,
    surface: "server",
    model: new MockLanguageModelV4({
      provider: "google.generative-ai",
      modelId: "gemini-2.5-pro",
      doStream: async (options) => {
        legacyCalls.push(options);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "t" });
              controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
              controller.enqueue({ type: "text-end", id: "t" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              });
              controller.close();
            },
          }),
        };
      },
    }),
  });
  try {
    const legacySession = await legacyEngine.createSession();
    assert.equal(legacyEngine.getThreadModel(legacySession.id).status, "applied");
    const iterator = legacySession.send("legacy chat works")[Symbol.asyncIterator]();
    while ((await iterator.next()).done !== true) {
      /* drain */
    }
    assert.equal(legacyCalls.length, 1);
  } finally {
    await legacyEngine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenAI Pro models expose supported efforts and resolve fixed-high models independently of the configured default", async () => {
  const lowDefaultConfig = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/unused" },
    llm: {
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      providers: {
        openai: {
          apiKey: "fixture-key",
          models: [
            "gpt-5.4",
            "gpt-5-pro",
            "gpt-5-pro-2025-10-06",
            "gpt-5.4-pro",
            "gpt-5.4-pro-2026-03-05",
            "gpt-5.5-pro-2026-06-01",
          ],
        },
      },
    },
    runtime: {
      thinkingLevel: "low",
      compaction: { thinkingLevel: "high" },
    },
  });
  const initial = {
    provider: "openai",
    modelName: "gpt-5.4",
    model: new MockLanguageModelV4({ provider: "openai.responses", modelId: "gpt-5.4" }),
  };
  const lowHost = createThreadModelHost(lowDefaultConfig, initial);
  const proTarget = {
    identity: { provider: "openai", model: "gpt-5.4-pro" },
    requiresFullModelPrepare: true,
  };
  for (const effort of [
    { mode: "default" },
    { mode: "explicit", level: "low" },
    { mode: "explicit", level: "off" },
    { mode: "explicit", level: "xhigh" },
  ] as const) {
    assert.throws(
      () => lowHost.validate?.({ ...proTarget, effort }),
      (error: unknown) =>
        error instanceof runtime.ThreadModelError && error.reason === "effort-unsupported",
    );
  }
  assert.equal(
    lowHost.validate?.({ ...proTarget, effort: { mode: "explicit", level: "medium" } })
      ?.effectiveEffort,
    "medium",
  );

  const mediumDefaultConfig = rollConfigSchema.parse({
    ...lowDefaultConfig,
    runtime: { thinkingLevel: "medium", compaction: { thinkingLevel: "high" } },
  });
  const mediumHost = createThreadModelHost(mediumDefaultConfig, initial);
  assert.equal(
    mediumHost.validate?.({
      identity: { provider: "openai", model: "gpt-5.4-pro-2026-03-05" },
      effort: { mode: "default" },
      requiresFullModelPrepare: true,
    })?.effectiveEffort,
    "medium",
  );

  for (const model of ["gpt-5-pro", "gpt-5-pro-2025-10-06"]) {
    const target = { identity: { provider: "openai", model }, requiresFullModelPrepare: true };
    for (const effort of [{ mode: "default" }, { mode: "explicit", level: "high" }] as const) {
      assert.deepEqual(mediumHost.validate?.({ ...target, effort }), {
        ...target.identity,
        effectiveEffort: "high",
        effortCapability: { kind: "fixed" },
      });
    }
    const prepared = await mediumHost.prepare(target.identity, new AbortController().signal);
    assert.equal(prepared.effort, "high");
    assert.equal(prepared.providerOptions?.openai?.reasoningEffort, "high");
    assert.throws(
      () => mediumHost.validate?.({ ...target, effort: { mode: "explicit", level: "medium" } }),
      (error: unknown) =>
        error instanceof runtime.ThreadModelError && error.reason === "effort-unsupported",
    );
  }
  const incompatibleCompaction = createThreadModelHost(
    rollConfigSchema.parse({
      ...mediumDefaultConfig,
      runtime: { thinkingLevel: "medium", compaction: { thinkingLevel: "medium" } },
    }),
    initial,
  );
  assert.throws(
    () =>
      incompatibleCompaction.validate?.({
        identity: { provider: "openai", model: "gpt-5-pro" },
        effort: { mode: "default" },
        requiresFullModelPrepare: true,
      }),
    (error: unknown) =>
      error instanceof runtime.ThreadModelError &&
      error.reason === "compaction-effort-incompatible",
  );
});

test("fixed and unknown models remain switchable with mode:default under xhigh or off global defaults", async () => {
  const xhighConfig = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/unused" },
    llm: {
      defaultProvider: "google",
      defaultModel: "gemini-4-neon",
      providers: {
        google: {
          apiKey: "k-google",
          models: ["gemini-4-neon", "gemini-2.0-flash", "gemini-4-carbon"],
        },
        openai: { apiKey: "k-openai", models: ["gpt-4o", "gpt-5-pro", "custom-openai-model"] },
        xai: { apiKey: "k-xai", models: ["grok-3", "grok-4.20"] },
      },
    },
    runtime: {
      provider: "google",
      model: "gemini-4-neon",
      thinkingLevel: "xhigh",
    },
  });
  const neonInitial = {
    provider: "google",
    modelName: "gemini-4-neon",
    model: new MockLanguageModelV4({ provider: "google.generative-ai", modelId: "gemini-4-neon" }),
    effort: "xhigh" as const,
  };
  const xhighHost = createThreadModelHost(xhighConfig, neonInitial);
  assert.throws(
    () =>
      xhighHost.validate?.({
        identity: { provider: "google", model: "gemini-4-carbon" },
        effort: { mode: "default" },
        requiresFullModelPrepare: true,
      }),
    (err: unknown) =>
      err instanceof runtime.ThreadModelError && err.reason === "effort-unsupported",
  );

  for (const [provider, model, expectedKind, expectedEffort] of [
    ["openai", "gpt-4o", "fixed", "medium"],
    ["openai", "gpt-5-pro", "fixed", "high"],
    ["openai", "custom-openai-model", "unknown", "medium"],
    ["google", "gemini-2.0-flash", "fixed", "medium"],
    ["xai", "grok-3", "fixed", "medium"],
    ["xai", "grok-4.20", "fixed", "medium"],
  ] as const) {
    const validated = xhighHost.validate?.({
      identity: { provider, model },
      effort: { mode: "default" },
      requiresFullModelPrepare: true,
    });
    assert.deepEqual(validated, {
      provider,
      model,
      effectiveEffort: expectedEffort,
      effortCapability: { kind: expectedKind },
    });
    const prepared = await xhighHost.prepare({ provider, model }, new AbortController().signal);
    assert.equal(prepared.effort, expectedEffort, `${provider}/${model}`);
  }

  // Explicit incompatible compaction.thinkingLevel must still be rejected for fixed/unknown targets.
  const badCompactionHost = createThreadModelHost(
    rollConfigSchema.parse({
      ...xhighConfig,
      runtime: {
        provider: "google",
        model: "gemini-4-neon",
        thinkingLevel: "xhigh",
        compaction: { thinkingLevel: "xhigh" },
      },
    }),
    neonInitial,
  );
  assert.throws(
    () =>
      badCompactionHost.validate?.({
        identity: { provider: "openai", model: "gpt-4o" },
        effort: { mode: "default" },
        requiresFullModelPrepare: true,
      }),
    (error: unknown) =>
      error instanceof runtime.ThreadModelError &&
      error.reason === "compaction-effort-incompatible",
  );

  // Under global thinkingLevel:off, fixed always-reasoning grok-4.20 falls back to medium instead of deadlocking.
  const offConfig = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/unused" },
    llm: {
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      providers: {
        openai: { apiKey: "k-openai", models: ["gpt-5.4"] },
        xai: { apiKey: "k-xai", models: ["grok-4.20"] },
      },
    },
    runtime: {
      thinkingLevel: "off",
    },
  });
  const offHost = createThreadModelHost(offConfig, {
    provider: "openai",
    modelName: "gpt-5.4",
    model: new MockLanguageModelV4({ provider: "openai.responses", modelId: "gpt-5.4" }),
    effort: "off",
  });
  assert.deepEqual(
    offHost.validate?.({
      identity: { provider: "xai", model: "grok-4.20" },
      effort: { mode: "default" },
      requiresFullModelPrepare: true,
    }),
    {
      provider: "xai",
      model: "grok-4.20",
      effectiveEffort: "medium",
      effortCapability: { kind: "fixed" },
    },
  );
});
