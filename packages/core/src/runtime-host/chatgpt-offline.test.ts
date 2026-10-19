import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { rollConfigSchema } from "../config/schema.ts";
import { ChatGptAuthError } from "../auth/chatgpt/service.ts";
import { resolveInteractiveChatLlm, type ChatGptAuth } from "./chatgpt-resolution.ts";

const id = "00000000-0000-4000-8000-000000000001";
const cfg = rollConfigSchema.parse({
  ask: {},
  agents: { dataDir: "/tmp/unused-offline-fixture" },
  llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
  runtime: {
    provider: "chatgpt",
    model: "fixture",
    thinkingLevel: "max",
    compaction: { thinkingLevel: "low" },
  },
});
const prompt: LanguageModelV4CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "preserved" }] },
];

function fixture() {
  let online = false;
  let calls = 0;
  let tokens = 0;
  const auth: ChatGptAuth = {
    status: async () => ({
      currentAccountId: id,
      accounts: [],
      usageUrl: "https://chatgpt.com/settings/usage",
    }),
    models: async () => {
      calls++;
      if (!online) throw new ChatGptAuthError("network_error", "网络连接中断");
      return [{ slug: "fixture", displayName: "Fixture", reasoningEfforts: ["low", "max"] }];
    },
    getAccessToken: async () => {
      tokens++;
      return "synthetic";
    },
  };
  return {
    auth,
    recover: () => {
      online = true;
    },
    calls: () => calls,
    tokens: () => tokens,
  };
}

test("interactive startup with no cache performs no network request; reconnect is single-flight", async () => {
  const f = fixture();
  const selected = await resolveInteractiveChatLlm(cfg, { auth: f.auth, deferConnection: true });
  const connection = selected.connection;
  assert.ok(connection);
  try {
    assert.equal(f.calls(), 0);
    assert.equal(selected.modelName, "fixture");
    assert.deepEqual(selected.providerOptions, { openai: { reasoningEffort: "max" } });
    await assert.rejects(connection.retry(), /网络连接中断/);
    assert.match(connection.getSnapshot(), /输入已保留.*reconnect/);
    f.recover();
    await Promise.all([connection.retry(), connection.ensure()]);
    assert.equal(f.calls(), 2);
    assert.equal(f.tokens(), 0);
    assert.match(connection.getSnapshot(), /已连接/);
    assert.equal(connection.models[0]?.slug, "fixture");
  } finally {
    connection.dispose();
  }
});

test("offline initialization does not bypass live model/effort authorization before inference", async () => {
  const f = fixture();
  f.recover();
  f.auth.cachedModels = () => [
    { slug: "removed", displayName: "Stale", reasoningEfforts: ["max"] },
  ];
  for (const [model, effort, pattern] of [
    ["removed", "max", /不提供模型/],
    ["fixture", "xhigh", /不支持推理强度/],
  ] as const) {
    const selected = await resolveInteractiveChatLlm(
      { ...cfg, runtime: { ...cfg.runtime, model } },
      { auth: f.auth, deferConnection: true },
    );
    try {
      await assert.rejects(
        async () =>
          selected.model.doStream({
            prompt: structuredClone(prompt),
            providerOptions: { openai: { reasoningEffort: effort } },
          }),
        pattern,
      );
      assert.equal(f.tokens(), 0);
    } finally {
      selected.connection?.dispose();
    }
  }
});

test("missing login and missing model still allow entering local chat", async () => {
  const f = fixture();
  f.auth.status = async () => ({ accounts: [], usageUrl: "https://chatgpt.com/settings/usage" });
  const runtime = { ...cfg.runtime };
  delete runtime.model;
  const selected = await resolveInteractiveChatLlm(
    { ...cfg, runtime },
    { auth: f.auth, deferConnection: true },
  );
  assert.equal(selected.modelName, "未选择 ChatGPT 模型");
  try {
    assert.ok(selected.connection);
    await assert.rejects(selected.connection.retry(), /roll auth chatgpt login/);
    assert.equal(f.calls(), 0);
  } finally {
    selected.connection?.dispose();
  }
});

test("noninteractive initialization still validates online and fails explicitly", async () => {
  const f = fixture();
  await assert.rejects(resolveInteractiveChatLlm(cfg, { auth: f.auth }), /网络连接中断/);
  assert.equal(f.calls(), 1);
});

test("a failed preparation is not repeated by the model in that turn; next submission can recover", async () => {
  const f = fixture();
  const selected = await resolveInteractiveChatLlm(cfg, { auth: f.auth, deferConnection: true });
  assert.ok(selected.connection);
  try {
    await assert.rejects(selected.connection.prepare(), /网络连接中断/);
    await assert.rejects(async () => selected.model.doStream({ prompt }), /网络连接中断/);
    assert.equal(f.calls(), 1);
    f.recover();
    await selected.connection.prepare();
    assert.equal(f.calls(), 2);
  } finally {
    selected.connection.dispose();
  }
});

test("cancelling a turn leaves an independent connection probe alive; dispose aborts it", async () => {
  const f = fixture();
  let requestSignal: AbortSignal | undefined;
  f.auth.models = async (_id, signal) => {
    requestSignal = signal;
    return await new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const selected = await resolveInteractiveChatLlm(cfg, { auth: f.auth, deferConnection: true });
  const connection = selected.connection;
  assert.ok(connection);
  connection.start();
  const abort = new AbortController();
  const pending = connection.ensure(abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, false);
  connection.dispose();
  assert.equal(requestSignal.aborted, true);
});
