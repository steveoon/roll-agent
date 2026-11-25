import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
import { cleanup, render } from "ink-testing-library";
import { MockLanguageModelV4 } from "ai/test";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import {
  ConversationEngine,
  ThreadStore,
  type AgentHost,
  type EngineModelSwitch,
} from "@roll-agent/runtime";
import { rollConfigSchema } from "../../config/schema.ts";
import { withChatGptFastMode } from "../../llm/chatgpt-fast-mode.ts";
import { resolveChatLlmCalls } from "../../runtime-host/chat-model-resolution.ts";
import { mapRuntimeSettings } from "../../runtime-host/engine-factory.ts";
import { ChatGptConnection } from "../../runtime-host/chatgpt-connection.ts";
import {
  resolveInteractiveChatSwitch,
  type ChatGptAuth,
  type ChatGptModels,
} from "../../runtime-host/chatgpt-resolution.ts";
import { createChatFastModeControl } from "./fast-mode.ts";
import { ChatApp } from "./ink/app.ts";
import { createInteractiveChatModelControls, resolveAndSwitchChatModel } from "./model-switch.ts";

afterEach(() => cleanup());

function deferred() {
  return Promise.withResolvers<void>();
}

for (const [initial, order] of [
  [false, "fast-first"],
  [false, "model-first"],
  [true, "fast-first"],
] as const) {
  test(`model switch keeps the latest Fast preference (initial=${initial}, ${order})`, async () => {
    const status = deferred();
    const prepare = deferred();
    const cfg = rollConfigSchema.parse({
      ask: {},
      llm: {
        defaultProvider: "openai",
        defaultModel: "api-model",
        providers: { openai: { apiKey: "test-only" } },
      },
      agents: { dataDir: "/tmp/unused-fast-switch-test" },
      runtime: {
        provider: "chatgpt",
        model: "old",
        fastMode: initial,
        thinkingLevel: "high",
        compaction: { thinkingLevel: "low" },
      },
    });
    const models = ["old", "new"].map((slug) => ({
      slug,
      displayName: slug,
      supportsFastMode: true,
    }));
    const auth: ChatGptAuth = {
      status: async () => {
        await status.promise;
        return {
          currentAccountId: "fixture",
          accounts: [],
          usageUrl: "https://chatgpt.com/settings/usage",
        };
      },
      models: async () => models,
      getAccessToken: async () => assert.fail("model selection must not invoke inference"),
    };
    const connection = new ChatGptConnection(auth, "fixture", models);
    let enabled = initial;
    let active: EngineModelSwitch = {
      provider: "chatgpt",
      modelName: "old",
      model: new MockLanguageModelV4({}),
      providerOptions: withChatGptFastMode({ openai: { reasoningEffort: "high" } }, initial),
      structuredOutputProviderOptions: withChatGptFastMode(
        { openai: { reasoningEffort: "low" } },
        initial,
      ),
    };
    const control = createChatFastModeControl({
      getEnabled: () => enabled,
      prepareEnable: () => prepare.promise,
      apply: (next) => {
        active = {
          ...active,
          providerOptions: withChatGptFastMode(active.providerOptions, next),
          structuredOutputProviderOptions: withChatGptFastMode(
            active.structuredOutputProviderOptions,
            next,
          ),
        };
        enabled = next;
      },
    });
    const switching = resolveAndSwitchChatModel({
      resolve: () =>
        resolveInteractiveChatSwitch(
          cfg,
          { provider: "chatgpt", model: "new" },
          "high",
          "fixture",
          auth,
          connection,
        ),
      getFastMode: () => enabled,
      commit: (selection) => {
        active = selection;
        return "committed";
      },
    });
    const toggling = control.setEnabled(!initial);
    try {
      if (order === "fast-first") {
        prepare.resolve();
        await toggling;
        status.resolve();
        assert.equal(await switching, "committed");
      } else {
        status.resolve();
        assert.equal(await switching, "committed");
        prepare.resolve();
        await toggling;
      }
      assert.equal(active.modelName, "new");
      assert.equal(control.getEnabled(), !initial);
      for (const [options, effort] of [
        [active.providerOptions, "high"],
        [active.structuredOutputProviderOptions, "low"],
      ] as const) {
        assert.equal(options?.openai?.serviceTier, initial ? undefined : "priority");
        assert.equal(options?.openai?.reasoningEffort, effort);
      }
    } finally {
      prepare.resolve();
      status.resolve();
      connection.dispose();
    }
  });
}

test("API model selection is passed through without reading or applying the subscription preference", async () => {
  const selection: EngineModelSwitch = {
    provider: "openai",
    modelName: "api-model",
    model: new MockLanguageModelV4({}),
    providerOptions: { openai: { reasoningEffort: "high" } },
  };
  const result = await resolveAndSwitchChatModel({
    resolve: async () => selection,
    getFastMode: () => assert.fail("API provider must not use subscription Fast options"),
    commit: (next) => next,
  });
  assert.equal(result, selection);
  assert.equal(result.providerOptions?.openai?.serviceTier, undefined);
});

test("rebasing Fast preserves the resolved model and other options without mutating its snapshot", async () => {
  const selection: EngineModelSwitch = {
    provider: "chatgpt",
    modelName: "new",
    model: new MockLanguageModelV4({}),
    providerOptions: { openai: { reasoningEffort: "high" }, other: { keep: true } },
    structuredOutputProviderOptions: { openai: { reasoningEffort: "low" } },
    toolSchemaPolicy: () => true,
  };
  let preference = true;
  const result = await resolveAndSwitchChatModel({
    resolve: async () => selection,
    getFastMode: () => {
      queueMicrotask(() => {
        preference = false;
      });
      return preference;
    },
    commit: (next) => {
      assert.equal(preference, true, "no await may separate the preference read and commit");
      return next;
    },
  });
  assert.notEqual(result, selection);
  assert.equal(result.model, selection.model);
  assert.equal(result.toolSchemaPolicy, selection.toolSchemaPolicy);
  assert.deepEqual(result.providerOptions?.other, { keep: true });
  assert.equal(result.providerOptions?.openai?.serviceTier, "priority");
  assert.equal(result.structuredOutputProviderOptions?.openai?.serviceTier, "priority");
  assert.equal(selection.providerOptions?.openai?.serviceTier, undefined);
  assert.equal(selection.structuredOutputProviderOptions?.openai?.serviceTier, undefined);
});

test("selection resolution and commit failures are propagated without a success result", async () => {
  await assert.rejects(
    resolveAndSwitchChatModel({
      resolve: async () => {
        throw new Error("resolution failed");
      },
      getFastMode: () => assert.fail("failed resolution must not read preferences"),
      commit: () => assert.fail("failed resolution must not commit"),
    }),
    /resolution failed/,
  );
  await assert.rejects(
    resolveAndSwitchChatModel({
      resolve: async () => ({
        provider: "chatgpt",
        modelName: "new",
        model: new MockLanguageModelV4({}),
      }),
      getFastMode: () => true,
      commit: () => {
        throw new Error("engine busy");
      },
    }),
    /engine busy/,
  );
});

test("interactive model switch supports xhigh on Gemini 4 Hydrogen/Neon and rejects off", async () => {
  const cfg = rollConfigSchema.parse({
    ask: {},
    llm: {
      defaultProvider: "google",
      defaultModel: "gemini-3.8-flash",
      providers: {
        google: {
          apiKey: "test-only",
          models: ["gemini-3.8-flash", "gemini-4-neon", "gemini-4-hydrogen"],
        },
      },
    },
    agents: { dataDir: "/tmp/unused-gemini-switch-test" },
    runtime: {
      provider: "google",
      model: "gemini-3.8-flash",
      thinkingLevel: "medium",
    },
  });

  const switched = await resolveInteractiveChatSwitch(
    cfg,
    { provider: "google", model: "gemini-4-neon" },
    "xhigh",
  );
  assert.equal(switched.provider, "google");
  assert.equal(switched.modelName, "gemini-4-neon");
  assert.deepEqual(switched.providerOptions, {
    google: { thinkingConfig: { thinkingLevel: "xhigh", includeThoughts: true } },
  });
  assert.equal(switched.structuredOutputReasoning, "xhigh");

  await assert.rejects(
    resolveInteractiveChatSwitch(cfg, { provider: "google", model: "gemini-4-hydrogen" }, "off"),
    /不支持推理强度/,
  );
  await assert.rejects(
    resolveInteractiveChatSwitch(cfg, { provider: "google", model: "gemini-4-carbon" }, "off"),
    /不支持推理强度/,
  );
});

function plain(text: string): string {
  return stripVTControlCharacters(text);
}

async function waitFor(check: () => void, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await delay(15);
    }
  }
  throw lastError ?? new Error("waitFor timed out");
}

async function submitEditorLine(
  view: ReturnType<typeof render>,
  text: string,
  expectedEcho: string = text,
): Promise<void> {
  await waitFor(() => {
    const frame = plain(view.lastFrame() ?? "");
    assert.ok(frame.includes("›"), `expected editor prompt before typing "${text}"`);
    assert.ok(frame.includes("Enter 发送"), `expected idle editor footer before typing "${text}"`);
  });
  await delay(20);
  view.stdin.write(text);
  await waitFor(() => {
    assert.ok(
      plain(view.lastFrame() ?? "").includes(expectedEcho),
      `expected editor to echo "${expectedEcho}", got:\n${plain(view.lastFrame() ?? "")}`,
    );
  });
  view.stdin.write("\r");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mountGeminiInteractiveHarness(options: {
  readonly thinkingLevel: "low" | "medium" | "high" | "xhigh";
  readonly compactionThinkingLevel?: "low" | "medium" | "high" | "xhigh";
  readonly keepRecentTurns?: number;
  readonly keepRecentTokens?: number;
  readonly refreshSubscriptionModels?: () => Promise<{
    readonly models: ChatGptModels;
    readonly accountId: string | undefined;
  }>;
  readonly assistantReplyText?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "roll-gemini-model-switch-"));
  const store = new ThreadStore(dir);
  const cfg = rollConfigSchema.parse({
    ask: {},
    llm: {
      defaultProvider: "google",
      defaultModel: "gemini-4-neon",
      providers: {
        google: {
          apiKey: "test-only",
          models: ["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen"],
        },
      },
    },
    agents: { dataDir: join(dir, "agents") },
    runtime: {
      provider: "google",
      model: "gemini-4-neon",
      thinkingLevel: options.thinkingLevel,
      compaction: {
        strategy: "summarize",
        ...(options.compactionThinkingLevel === undefined
          ? {}
          : { thinkingLevel: options.compactionThinkingLevel }),
        ...(options.keepRecentTurns === undefined
          ? {}
          : { keepRecentTurns: options.keepRecentTurns }),
        ...(options.keepRecentTokens === undefined
          ? {}
          : { keepRecentTokens: options.keepRecentTokens }),
      },
    },
  });

  const initialCalls = resolveChatLlmCalls(
    "google",
    "gemini-4-neon",
    "test-only",
    undefined,
    options.thinkingLevel,
    options.compactionThinkingLevel,
    true,
  );
  const samplingUpdates: Array<{
    readonly modelId: string;
    readonly providerOptions: SharedV4ProviderOptions | undefined;
  }> = [];
  const agentHost: AgentHost = {
    prepare: async () => ({ sources: [] }),
    refresh: async () => {
      throw new Error("unexpected agent refresh in model-switch test");
    },
    updateSampling(model, providerOptions) {
      samplingUpdates.push({ modelId: model.modelId, providerOptions });
    },
    dispose: async () => {},
  };

  const engine = new ConversationEngine({
    settings: mapRuntimeSettings(cfg),
    provider: "google",
    modelName: "gemini-4-neon",
    model: initialCalls.model,
    toolSchemaPolicy: initialCalls.toolSchemaPolicy,
    agentHost,
    store,
    workspace: dir,
    hostMode: "interactive",
    skillLibrary: null,
    workspaceInstructions: null,
    ...(initialCalls.providerOptions ? { providerOptions: initialCalls.providerOptions } : {}),
    ...(initialCalls.structuredOutputProviderOptions
      ? { structuredOutputProviderOptions: initialCalls.structuredOutputProviderOptions }
      : {}),
    ...(initialCalls.structuredOutputReasoning
      ? { structuredOutputReasoning: initialCalls.structuredOutputReasoning }
      : {}),
  });

  const session = await engine.createSession();
  let activeSelection: EngineModelSwitch = {
    provider: "google",
    modelName: "gemini-4-neon",
    ...initialCalls,
  };
  let currentProvider = "google";
  let currentModel = "gemini-4-neon";
  let currentThinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max" =
    options.thinkingLevel;

  let subscriptionModels: ChatGptModels = [];

  const refreshSubscriptionModels = options.refreshSubscriptionModels;

  const controls = createInteractiveChatModelControls({
    config: cfg,
    getSession: () => session,
    switchEngineModel: (nextSelection) => engine.switchModel(nextSelection),
    getState: () => ({
      provider: currentProvider,
      model: currentModel,
      thinkingLevel: currentThinkingLevel,
      fastMode: false,
      selection: activeSelection,
      subscriptionModels,
      subscriptionAccountId: undefined,
    }),
    setSelection: (next) => {
      activeSelection = next;
    },
    setThinkingLevel: (next) => {
      currentThinkingLevel = next;
    },
    setModelIdentity: (nextProvider, nextModel) => {
      currentProvider = nextProvider;
      currentModel = nextModel;
    },
    ...(refreshSubscriptionModels
      ? {
          refreshSubscriptionModels: async () => {
            const refreshed = await refreshSubscriptionModels();
            subscriptionModels = refreshed.models;
            return refreshed;
          },
        }
      : {}),
  });

  const capturedRequests: Array<{ readonly url: string; readonly thinkingConfig: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (typeof init?.body !== "string") {
      throw new Error("Expected JSON request body");
    }
    const body: unknown = JSON.parse(init.body);
    assert.ok(isRecord(body) && isRecord(body.generationConfig));
    capturedRequests.push({ url, thinkingConfig: body.generationConfig.thinkingConfig });
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: url.includes(":generateContent")
                  ? "checkpoint summary"
                  : (options.assistantReplyText ?? "reply ok"),
              },
            ],
            role: "model",
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8, totalTokenCount: 48 },
    };
    if (url.includes(":streamGenerateContent")) {
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const view = render(
    h(ChatApp, {
      session,
      model: currentModel,
      initialThinkingLevel: currentThinkingLevel,
      getThinkingLevels: controls.getThinkingLevels,
      onThinkingChange: controls.onThinkingChange,
      modelSwitching: {
        loadItems: () => [],
        getThinkingLevels: controls.getTargetThinkingLevels,
        switchTo: controls.switchTo,
        setAsDefault: async () => "saved",
      },
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );

  return {
    view,
    session,
    samplingUpdates,
    capturedRequests,
    getState: () => ({ currentProvider, currentModel, currentThinkingLevel }),
    async dispose() {
      view.unmount();
      globalThis.fetch = originalFetch;
      await session.close();
      await engine.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("/model rejects explicit incompatible compaction effort with field name and keeps old Neon model and session sendable", async () => {
  const harness = await mountGeminiInteractiveHarness({
    thinkingLevel: "high",
    compactionThinkingLevel: "xhigh",
  });
  try {
    const initialSessionId = harness.session.id;
    const samplingBeforeSwitch = harness.samplingUpdates.length;
    await delay(30);
    await submitEditorLine(harness.view, "/model google/gemini-4-carbon");
    await waitFor(() => {
      const frame = plain(harness.view.lastFrame() ?? "");
      assert.match(frame, /runtime\.compaction\.thinking-level/);
      assert.match(frame, /gemini-4-carbon/);
      assert.match(frame, /xhigh/);
    });
    assert.equal(harness.session.id, initialSessionId);
    assert.deepEqual(harness.getState(), {
      currentProvider: "google",
      currentModel: "gemini-4-neon",
      currentThinkingLevel: "high",
    });
    assert.equal(harness.samplingUpdates.length, samplingBeforeSwitch);

    await submitEditorLine(harness.view, "continue on neon");
    await waitFor(() => {
      assert.equal(harness.capturedRequests.length, 1);
      assert.equal(harness.session.canSwitchModel(), true);
      assert.equal(harness.session.getMessages().length, 2);
    });
    assert.ok(
      harness.capturedRequests[0]?.url.includes("/models/gemini-4-neon:streamGenerateContent"),
      harness.capturedRequests[0]?.url,
    );
    assert.deepEqual(harness.capturedRequests[0]?.thinkingConfig, {
      thinkingLevel: "high",
      includeThoughts: true,
    });
  } finally {
    await harness.dispose();
  }
});

test("/model opens effort picker on chat-only incompatibility, preserves Neon on Esc, and switches after selecting Carbon level", async () => {
  const harness = await mountGeminiInteractiveHarness({
    thinkingLevel: "xhigh",
    compactionThinkingLevel: "medium",
  });
  try {
    await delay(30);
    await submitEditorLine(harness.view, "/model google/gemini-4-carbon");
    await waitFor(() => {
      const frame = plain(harness.view.lastFrame() ?? "");
      assert.match(frame, /请选择推理档位/);
      assert.match(frame, /low/);
      assert.match(frame, /medium/);
      assert.match(frame, /high/);
      assert.doesNotMatch(frame, /xhigh\s+选择后应用/);
    });
    harness.view.stdin.write("\u001b");
    await waitFor(() =>
      assert.doesNotMatch(plain(harness.view.lastFrame() ?? ""), /请选择推理档位/),
    );
    assert.deepEqual(harness.getState(), {
      currentProvider: "google",
      currentModel: "gemini-4-neon",
      currentThinkingLevel: "xhigh",
    });

    await submitEditorLine(harness.view, "/model google/gemini-4-carbon");
    await waitFor(() => assert.match(plain(harness.view.lastFrame() ?? ""), /请选择推理档位/));
    harness.view.stdin.write("\r");
    await waitFor(() => {
      assert.equal(harness.getState().currentModel, "gemini-4-carbon");
      assert.equal(harness.getState().currentThinkingLevel, "low");
    });
    await waitFor(() => assert.match(plain(harness.view.lastFrame() ?? ""), /是否设为默认/));
    harness.view.stdin.write("\u001b");
    await waitFor(() => assert.doesNotMatch(plain(harness.view.lastFrame() ?? ""), /是否设为默认/));

    await submitEditorLine(harness.view, "send on carbon");
    await waitFor(() => {
      assert.equal(harness.capturedRequests.length, 1);
      assert.equal(harness.session.canSwitchModel(), true);
      assert.equal(harness.session.getMessages().length, 2);
    });
    assert.ok(
      harness.capturedRequests[0]?.url.includes("/models/gemini-4-carbon:streamGenerateContent"),
      harness.capturedRequests[0]?.url,
    );
    assert.deepEqual(harness.capturedRequests[0]?.thinkingConfig, {
      thinkingLevel: "low",
      includeThoughts: true,
    });
  } finally {
    await harness.dispose();
  }
});

test("/effort updates chat and MCP Sampling without altering initialized compaction effort, and /think off preserves state", async () => {
  const harness = await mountGeminiInteractiveHarness({
    thinkingLevel: "high",
    compactionThinkingLevel: "xhigh",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
    assistantReplyText: `reply ok ${"archived-history-detail ".repeat(120)}`,
  });
  try {
    await delay(30);
    await submitEditorLine(harness.view, "turn-1 history");
    await waitFor(() => {
      assert.equal(harness.capturedRequests.length, 1);
      assert.equal(harness.session.canSwitchModel(), true);
      assert.equal(harness.session.getMessages().length, 2);
    });

    await submitEditorLine(harness.view, "/effort low");
    await waitFor(() => assert.equal(harness.getState().currentThinkingLevel, "low"));
    assert.deepEqual(harness.samplingUpdates.at(-1), {
      modelId: "gemini-4-neon",
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } },
      },
    });

    await submitEditorLine(harness.view, "turn-2 history");
    await waitFor(() => {
      assert.equal(harness.capturedRequests.length, 2);
      assert.equal(harness.session.canSwitchModel(), true);
      assert.equal(harness.session.getMessages().length, 4);
    });
    assert.deepEqual(harness.capturedRequests[1]?.thinkingConfig, {
      thinkingLevel: "low",
      includeThoughts: true,
    });

    let compactedRemoved = 0;
    let compactionFailure: unknown;
    for await (const event of harness.session.compact("manual")) {
      if (event.type === "context-compacted") {
        compactedRemoved = event.removed;
        compactionFailure = event.failure;
      }
    }
    assert.equal(
      compactionFailure,
      undefined,
      `unexpected compaction failure: ${JSON.stringify(compactionFailure)}`,
    );
    assert.ok(compactedRemoved > 0, "expected manual compaction to summarize earlier turn");
    const compactionRequest = harness.capturedRequests.find((item) =>
      item.url.includes(":generateContent"),
    );
    assert.ok(compactionRequest, "expected compaction generateContent request");
    assert.deepEqual(compactionRequest.thinkingConfig, { thinkingLevel: "xhigh" });

    const samplingCountBeforeOff = harness.samplingUpdates.length;
    await submitEditorLine(harness.view, "/think off");
    await waitFor(() =>
      assert.match(plain(harness.view.lastFrame() ?? ""), /不支持推理强度 "off"/),
    );
    assert.equal(harness.getState().currentThinkingLevel, "low");
    assert.equal(harness.samplingUpdates.length, samplingCountBeforeOff);

    const requestCountBeforeSend = harness.capturedRequests.length;
    const messageCountBeforeSend = harness.session.getMessages().length;
    await submitEditorLine(harness.view, "turn-3 after rejected off");
    await waitFor(() => {
      assert.equal(harness.capturedRequests.length, requestCountBeforeSend + 1);
      assert.equal(harness.session.canSwitchModel(), true);
      assert.equal(harness.session.getMessages().length, messageCountBeforeSend + 2);
    });
    assert.deepEqual(harness.capturedRequests.at(-1)?.thinkingConfig, {
      thinkingLevel: "low",
      includeThoughts: true,
    });
  } finally {
    await harness.dispose();
  }
});

test("/model at xhigh rejects unknown models immediately without opening effort picker while preserving ChatGPT refresh", async () => {
  let subscriptionRefreshes = 0;
  const harness = await mountGeminiInteractiveHarness({
    thinkingLevel: "xhigh",
    compactionThinkingLevel: "medium",
    refreshSubscriptionModels: async () => {
      subscriptionRefreshes += 1;
      return {
        accountId: "sub-acc",
        models: [
          { slug: "gpt-sub-only", displayName: "GPT Sub", reasoningEfforts: ["low", "high"] },
        ],
      };
    },
  });
  try {
    const initialSessionId = harness.session.id;
    await delay(30);

    for (const unknownInput of ["nonexistent-model", "google/nonexistent-model"]) {
      await submitEditorLine(harness.view, `/model ${unknownInput}`);
      await waitFor(() => {
        const frame = plain(harness.view.lastFrame() ?? "");
        assert.doesNotMatch(frame, /请选择推理档位/);
        assert.match(frame, new RegExp(`未知模型 "${unknownInput.replace("/", "\\/")}"`));
      });
      assert.equal(harness.session.id, initialSessionId);
      assert.deepEqual(harness.getState(), {
        currentProvider: "google",
        currentModel: "gemini-4-neon",
        currentThinkingLevel: "xhigh",
      });
    }
    assert.equal(subscriptionRefreshes, 0, "unknown API model must not trigger ChatGPT refresh");

    // ChatGPT prefix still triggers catalog refresh before reporting missing subscription model.
    await submitEditorLine(harness.view, "/model chatgpt/missing-slug");
    await waitFor(() => {
      const frame = plain(harness.view.lastFrame() ?? "");
      assert.doesNotMatch(frame, /请选择推理档位/);
      assert.match(frame, /当前账号不提供模型 "chatgpt\/missing-slug"/);
    });
    assert.equal(subscriptionRefreshes, 1);
    assert.deepEqual(harness.getState(), {
      currentProvider: "google",
      currentModel: "gemini-4-neon",
      currentThinkingLevel: "xhigh",
    });
  } finally {
    await harness.dispose();
  }
});

test("onThinkingChange preserves openai store:false when custom baseUrl is configured", () => {
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/unused" },
    llm: {
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      providers: {
        openai: {
          apiKey: "test-key",
          baseUrl: "https://openai.example.test/v1",
          models: ["gpt-5.4"],
        },
      },
    },
    runtime: {
      thinkingLevel: "medium",
    },
  });
  let appliedOptions: unknown;
  let thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max" = "medium";
  let selection: EngineModelSwitch = {
    provider: "openai",
    modelName: "gpt-5.4",
    model: new MockLanguageModelV4({ provider: "openai.responses", modelId: "gpt-5.4" }),
    providerOptions: { openai: { reasoningEffort: "medium", store: false } },
  };
  const controls = createInteractiveChatModelControls({
    config,
    getSession: () => ({
      setProviderOptions: (next) => {
        appliedOptions = next;
      },
    }),
    switchEngineModel: () => undefined,
    getState: () => ({
      provider: "openai",
      model: "gpt-5.4",
      thinkingLevel,
      fastMode: false,
      selection,
      subscriptionModels: [],
      subscriptionAccountId: undefined,
    }),
    setSelection: (next) => {
      selection = next;
    },
    setThinkingLevel: (next) => {
      thinkingLevel = next;
    },
    setModelIdentity: () => {},
  });

  controls.onThinkingChange("high");
  assert.deepEqual(appliedOptions, { openai: { reasoningEffort: "high", store: false } });
  assert.equal(thinkingLevel, "high");

  controls.onThinkingChange("off");
  assert.deepEqual(appliedOptions, { openai: { reasoningEffort: "none", store: false } });
  assert.equal(thinkingLevel, "off");
});
