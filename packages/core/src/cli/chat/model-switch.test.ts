import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { EngineModelSwitch } from "@roll-agent/runtime";
import { rollConfigSchema } from "../../config/schema.ts";
import { withChatGptFastMode } from "../../llm/chatgpt-fast-mode.ts";
import { ChatGptConnection } from "../../runtime-host/chatgpt-connection.ts";
import {
  resolveInteractiveChatSwitch,
  type ChatGptAuth,
} from "../../runtime-host/chatgpt-resolution.ts";
import { createChatFastModeControl } from "./fast-mode.ts";
import { resolveAndSwitchChatModel } from "./model-switch.ts";

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
