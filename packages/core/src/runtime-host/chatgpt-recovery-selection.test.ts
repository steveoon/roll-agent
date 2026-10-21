import assert from "node:assert/strict";
import test from "node:test";
import { rollConfigSchema } from "../config/schema.ts";
import {
  resolveInteractiveChatLlm,
  resolveInteractiveChatSwitch,
  type ChatGptAuth,
} from "./chatgpt-resolution.ts";

const config = rollConfigSchema.parse({
  ask: {},
  agents: { dataDir: "/tmp/unused-recovery-selection" },
  llm: {
    defaultProvider: "chatgpt",
    defaultModel: "fixture",
    providers: { openai: { apiKey: "synthetic" } },
  },
  runtime: { provider: "chatgpt", model: "fixture", thinkingLevel: "low" },
});
for (const deferConnection of [false, true]) {
  test(`recovery selection (deferred=${deferConnection}) revalidates live authorization and clears on API switch`, async () => {
    let removed = false;
    let tokens = 0;
    const auth: ChatGptAuth = {
      status: async () => ({
        currentAccountId: "fixture",
        accounts: [],
        usageUrl: "https://chatgpt.com/settings/usage",
      }),
      models: async () =>
        removed ? [] : [{ slug: "fixture", displayName: "Fixture", reasoningEfforts: ["low"] }],
      getAccessToken: async () => {
        tokens++;
        return "synthetic";
      },
    };
    const selected = await resolveInteractiveChatLlm(config, {
      auth,
      deferConnection,
      enableRecovery: true,
    });
    assert.ok(selected.modelRecovery && selected.connection);
    try {
      await selected.connection.prepare();
      removed = true;
      await selected.modelRecovery.prepare(new AbortController().signal);
      await assert.rejects(
        async () =>
          await selected.model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "task" }] }],
            ...(selected.providerOptions ? { providerOptions: selected.providerOptions } : {}),
          }),
        /不提供模型/,
      );
      assert.equal(tokens, 0);
      const switched = await resolveInteractiveChatSwitch(
        config,
        { provider: "openai", model: "fixture" },
        "low",
        undefined,
        auth,
        selected.connection,
      );
      assert.equal(switched.modelRecovery, undefined);
    } finally {
      selected.connection.dispose();
    }
  });
}

test("noninteractive and explicit opt-out selections do not install recovery", async () => {
  const auth: ChatGptAuth = {
    status: async () => ({
      currentAccountId: "fixture",
      accounts: [],
      usageUrl: "https://chatgpt.com/settings/usage",
    }),
    models: async () => [{ slug: "fixture", displayName: "Fixture", reasoningEfforts: ["low"] }],
    getAccessToken: async () => "synthetic",
  };
  for (const deferConnection of [false, true]) {
    const selected = await resolveInteractiveChatLlm(config, { auth, deferConnection });
    assert.equal(selected.modelRecovery, undefined);
    selected.connection?.dispose();
  }
});
