import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ModelConfigController } from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import { resolveChatLlmReadiness } from "./engine-factory.ts";
import { ChatGptConnection } from "./chatgpt-connection.ts";
import {
  resolveInteractiveChatLlm,
  resolveInteractiveChatSwitch,
  prepareInteractiveChatReload,
  chatModelPickerItems,
  chatGptThinkingOptions,
  type ChatGptAuth,
} from "./chatgpt-resolution.ts";

function reloadFixture() {
  const selected: Array<string | undefined> = [];
  const freshModels = [
    {
      slug: "reload-model",
      displayName: "Reload",
      supportsFastMode: false,
      reasoningEfforts: ["low", "medium"],
    },
  ];
  const auth: ChatGptAuth = {
    async status() {
      return {
        currentAccountId: "other-account",
        accounts: [
          { id: "bound-account", label: "Bound", connected: true, authorized: true },
          { id: "other-account", label: "Other", connected: true, authorized: true },
        ],
        usageUrl: "https://example.invalid/usage",
      };
    },
    async models(accountId) {
      selected.push(accountId);
      return freshModels;
    },
    async getAccessToken() {
      throw new Error("reload must not invoke inference");
    },
  };
  const staleModels = [{ slug: "old-model", displayName: "Old" }];
  const connection = new ChatGptConnection(auth, "bound-account", staleModels);
  return { auth, selected, freshModels, staleModels, connection };
}

for (const [label, override, pattern] of [
  ["unknown model", { model: "missing" }, /不提供模型/],
  ["unsupported effort", { thinkingLevel: "high" }, /不支持推理强度/],
  ["unsupported compaction effort", { compaction: { thinkingLevel: "high" } }, /不支持推理强度/],
  ["unsupported Fast", { fastMode: true }, /Fast/],
] as const) {
  test(`reload preparation rejects ${label} before mutating the active catalog`, async () => {
    const fixture = reloadFixture();
    const runtime = { provider: "chatgpt", model: "reload-model", thinkingLevel: "low" };
    try {
      await assert.rejects(
        prepareInteractiveChatReload(
          config({ ...runtime, ...override }),
          fixture.connection,
          undefined,
          fixture.auth,
        ),
        pattern,
      );
      assert.deepEqual(fixture.selected, ["bound-account"]);
      assert.deepEqual(fixture.connection.models, fixture.staleModels);
    } finally {
      fixture.connection.dispose();
    }
  });
}

test("reload preparation validates a fresh account-bound catalog without committing it", async () => {
  const fixture = reloadFixture();
  try {
    const prepared = await prepareInteractiveChatReload(
      config({ provider: "chatgpt", model: "reload-model", thinkingLevel: "low" }),
      fixture.connection,
      undefined,
      fixture.auth,
    );
    assert.equal(prepared.selection.modelName, "reload-model");
    assert.deepEqual(prepared.selection.providerOptions, { openai: { reasoningEffort: "low" } });
    assert.equal(prepared.accountId, "bound-account");
    assert.deepEqual(prepared.models, fixture.freshModels);
    assert.deepEqual(fixture.selected, ["bound-account"]);
    assert.deepEqual(fixture.connection.models, fixture.staleModels);
  } finally {
    fixture.connection.dispose();
  }
});

test("reload preparation refuses to pair another account's catalog with the existing connection", async () => {
  const fixture = reloadFixture();
  try {
    await assert.rejects(
      prepareInteractiveChatReload(
        config({ provider: "chatgpt", model: "reload-model", chatgptAccountId: "other-account" }),
        fixture.connection,
        undefined,
        fixture.auth,
      ),
      /账号.*重启/,
    );
    assert.deepEqual(fixture.selected, []);
    assert.equal(fixture.connection.accountId, "bound-account");
  } finally {
    fixture.connection.dispose();
  }
});

test("API reload preparation reuses the API resolver without requesting subscription credentials", async () => {
  const fixture = reloadFixture();
  try {
    const prepared = await prepareInteractiveChatReload(
      config(),
      fixture.connection,
      undefined,
      fixture.auth,
    );
    assert.equal(prepared.selection.provider, "openai");
    assert.equal(prepared.selection.modelName, "gpt-api");
    assert.equal(prepared.models, undefined);
    assert.deepEqual(fixture.selected, []);
  } finally {
    fixture.connection.dispose();
  }
});

test(
  "closing reload preparation aborts its catalog request without awaiting an external release",
  { timeout: 1000 },
  async () => {
    const fixture = reloadFixture();
    let started: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    let committed = false;
    fixture.auth.models = async (_accountId, signal) => {
      started?.();
      return new Promise((_resolve, reject) => {
        const abort = () => {
          aborted = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const control = new ModelConfigController({
      host: {
        initial: { provider: "chatgpt", model: "old-model" },
        async reload(signal) {
          const prepared = await prepareInteractiveChatReload(
            config({ provider: "chatgpt", model: "reload-model", thinkingLevel: "low" }),
            fixture.connection,
            undefined,
            fixture.auth,
            signal,
          );
          signal?.throwIfAborted();
          committed = true;
          return {
            status: "applied",
            model: { provider: prepared.selection.provider, model: prepared.selection.modelName },
          };
        },
      },
      isBusy: () => false,
    });
    try {
      control.reload();
      await requested;
      control.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(aborted, true);
      assert.equal(committed, false);
      assert.equal(control.getStatus().active.model, "old-model");
      assert.deepEqual(fixture.connection.models, fixture.staleModels);
    } finally {
      control.close();
      fixture.connection.dispose();
    }
  },
);

const current = randomUUID();
const saved = randomUUID();
const cli = randomUUID();
function config(runtime: Record<string, unknown> = {}) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "openai",
      defaultModel: "gpt-api",
      providers: { openai: { apiKey: "test-key" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/unused-chatgpt-resolution" },
    runtime,
  });
}
function fixture() {
  const selected: Array<string | undefined> = [];
  const auth: ChatGptAuth = {
    async status() {
      return {
        currentAccountId: current,
        accounts: [],
        usageUrl: "https://chatgpt.com/settings/usage",
      };
    },
    async models(accountId) {
      selected.push(accountId);
      return [{ slug: "subscription-slug", displayName: "Subscription model" }];
    },
    async getAccessToken() {
      throw new Error("resolution must not invoke inference");
    },
  };
  return { auth, selected };
}

test("Fast covers normal and compaction options, survives model/effort switches, and leaves API providers alone", async () => {
  const { auth } = fixture();
  auth.models = async () => [
    { slug: "subscription-slug", displayName: "Fixture", supportsFastMode: true },
  ];
  const cfg = config({
    provider: "chatgpt",
    model: "subscription-slug",
    fastMode: true,
    thinkingLevel: "high",
    compaction: { thinkingLevel: "low" },
  });
  for (const deferConnection of [false, true]) {
    const resolved = await resolveInteractiveChatLlm(cfg, {
      auth,
      deferConnection,
      enableRecovery: deferConnection,
    });
    try {
      assert.deepEqual(resolved.providerOptions, {
        openai: { reasoningEffort: "high", serviceTier: "priority" },
      });
      assert.deepEqual(resolved.structuredOutputProviderOptions, {
        openai: { reasoningEffort: "low", serviceTier: "priority" },
      });
      const switched = await resolveInteractiveChatSwitch(
        cfg,
        { provider: "chatgpt", model: "subscription-slug" },
        "medium",
        current,
        auth,
        resolved.connection,
      );
      assert.deepEqual(switched.providerOptions, {
        openai: { reasoningEffort: "medium", serviceTier: "priority" },
      });
      assert.deepEqual(
        switched.structuredOutputProviderOptions,
        resolved.structuredOutputProviderOptions,
      );
    } finally {
      resolved.connection?.dispose();
    }
  }
  const api = await resolveInteractiveChatLlm(config({ fastMode: true }), { auth });
  assert.equal(api.providerOptions?.openai?.serviceTier, undefined);
});

test("Fast rejects unsupported live capabilities before inference and rechecks after reconnect", async () => {
  const { auth } = fixture();
  const cfg = config({ provider: "chatgpt", model: "subscription-slug", fastMode: true });
  await assert.rejects(resolveInteractiveChatLlm(cfg, { auth }), /未提供 Fast.*\/fast off/);
  let supportsFastMode = true;
  let tokenReads = 0;
  auth.models = async () => [
    { slug: "subscription-slug", displayName: "Fixture", supportsFastMode },
  ];
  auth.getAccessToken = async () => {
    tokenReads += 1;
    throw new Error("unexpected inference");
  };
  const resolved = await resolveInteractiveChatLlm(cfg, {
    auth,
    deferConnection: true,
    enableRecovery: true,
  });
  assert.ok(resolved.connection);
  try {
    await resolved.connection.ensure();
    supportsFastMode = false;
    await resolved.connection.retry();
    const providerOptions = resolved.providerOptions;
    assert.ok(providerOptions);
    await assert.rejects(
      async () =>
        resolved.model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          providerOptions,
        }),
      (error: unknown) => {
        assert.match(resolved.modelRecovery?.formatError?.(error) ?? "", /\/fast off/);
        return true;
      },
    );
    assert.equal(tokenReads, 0);
    assert.equal(resolved.connection.getSnapshot().state, "connected");
    const ordinary = await resolveInteractiveChatLlm(
      config({ provider: "chatgpt", model: "subscription-slug" }),
      { auth },
    );
    assert.equal(Object.hasOwn(ordinary.providerOptions?.openai ?? {}, "serviceTier"), false);
  } finally {
    resolved.connection.dispose();
  }
});

test("subscription account precedence: CLI, config, current registration", async () => {
  for (const [accountId, savedId, expected] of [
    [cli, saved, cli],
    [undefined, saved, saved],
    [undefined, undefined, current],
  ] as const) {
    const { auth, selected } = fixture();
    const resolved = await resolveInteractiveChatLlm(
      config({
        provider: "chatgpt",
        model: "subscription-slug",
        ...(savedId ? { chatgptAccountId: savedId } : {}),
      }),
      { auth, ...(accountId ? { accountId } : {}) },
    );
    assert.equal(resolved.accountId, expected);
    assert.equal(resolved.modelName, "subscription-slug");
    assert.equal(resolved.model.provider, "chatgpt.responses");
    assert.deepEqual(selected, [expected]);
  }
});

test("Roll thinking levels map to valid subscription reasoning efforts", () => {
  for (const [level, effort] of [
    ["off", "none"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ] as const) {
    assert.deepEqual(chatGptThinkingOptions(level), { openai: { reasoningEffort: effort } });
  }
});

test("live model capabilities reject unsupported thinking and compaction before inference", async () => {
  const { auth } = fixture();
  auth.models = async () => [
    {
      slug: "subscription-slug",
      displayName: "Reasoning model",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
  ];
  for (const runtime of [
    { thinkingLevel: "off" },
    { thinkingLevel: "low", compaction: { thinkingLevel: "off" } },
  ]) {
    await assert.rejects(
      resolveInteractiveChatLlm(
        config({ provider: "chatgpt", model: "subscription-slug", ...runtime }),
        { auth },
      ),
      /不支持推理强度 "off".*low.*runtime.compaction.thinkingLevel/,
    );
  }
  assert.deepEqual(
    chatGptThinkingOptions("off", {
      slug: "can-disable",
      displayName: "Can disable",
      reasoningEfforts: ["none", "low"],
    }),
    { openai: { reasoningEffort: "none" } },
  );
});

test("subscription never inherits an API default model; noninteractive missing model gives instructions", async () => {
  const { auth } = fixture();
  await assert.rejects(
    resolveInteractiveChatLlm(config({ provider: "chatgpt" }), { auth }),
    /roll auth chatgpt models.*--model/,
  );
  let shown = false;
  const resolved = await resolveInteractiveChatLlm(config({ provider: "chatgpt" }), {
    auth,
    selectModel: async (models) => {
      shown = true;
      assert.equal(models[0]?.displayName, "Subscription model");
      return models[0]?.slug;
    },
  });
  assert.equal(shown, true);
  assert.equal(resolved.modelName, "subscription-slug");
  await assert.rejects(
    resolveInteractiveChatLlm(config({ provider: "chatgpt", model: "gpt-api" }), { auth }),
    /不提供模型/,
  );
});

test("API-key initialization and switching retain original provider without touching OAuth", async () => {
  const { auth, selected } = fixture();
  const resolved = await resolveInteractiveChatLlm(config(), { auth });
  assert.equal(resolved.provider, "openai");
  assert.equal(resolved.modelName, "gpt-api");
  assert.equal(resolved.accountId, undefined);
  const switched = await resolveInteractiveChatSwitch(
    config(),
    { provider: "openai", model: "gpt-other" },
    "medium",
    undefined,
    auth,
  );
  assert.equal(switched.modelName, "gpt-other");
  assert.deepEqual(selected, []);
});

test("extended subscription initializes and switches with independent compaction effort", async () => {
  const { auth } = fixture();
  auth.models = async () => [
    {
      slug: "subscription-slug",
      displayName: "Fixture",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
  ];
  const cfg = config({
    provider: "chatgpt",
    model: "subscription-slug",
    thinkingLevel: "max",
    compaction: { thinkingLevel: "low" },
  });
  const resolved = await resolveInteractiveChatLlm(cfg, { auth });
  assert.deepEqual(resolved.providerOptions, { openai: { reasoningEffort: "max" } });
  assert.deepEqual(resolved.structuredOutputProviderOptions, {
    openai: { reasoningEffort: "low" },
  });
  const switched = await resolveInteractiveChatSwitch(
    cfg,
    { provider: "chatgpt", model: "subscription-slug" },
    "xhigh",
    saved,
    auth,
  );
  assert.deepEqual(switched.providerOptions, { openai: { reasoningEffort: "xhigh" } });
  assert.deepEqual(switched.structuredOutputProviderOptions, {
    openai: { reasoningEffort: "low" },
  });
  await assert.rejects(
    resolveInteractiveChatSwitch(
      config(),
      { provider: "openai", model: "gpt-api" },
      "max",
      undefined,
      auth,
    ),
    /不支持推理强度/,
  );
});

test("subscription switch revalidates live account catalog and carries compaction options", async () => {
  const { auth, selected } = fixture();
  const switched = await resolveInteractiveChatSwitch(
    config(),
    { provider: "chatgpt", model: "subscription-slug" },
    "low",
    saved,
    auth,
  );
  assert.equal(switched.modelName, "subscription-slug");
  assert.deepEqual(switched.providerOptions, { openai: { reasoningEffort: "low" } });
  assert.deepEqual(selected, [saved]);
  assert.ok(switched.structuredOutputProviderOptions);
});

test("dynamic subscription picker displays friendly name and never modifies static choices", () => {
  const c = config({ provider: "chatgpt", model: "subscription-slug" });
  const items = chatModelPickerItems(
    c,
    [{ slug: "subscription-slug", displayName: "Friendly name" }],
    "subscription-slug",
  );
  assert.equal(
    items.find((item) => item.id === "chatgpt/subscription-slug")?.title,
    "Friendly name",
  );
  assert.deepEqual(Object.keys(c.llm.providers), ["openai"]);
});

test("shared synchronous readiness rejects subscription services with an explicit scope message", () => {
  const ready = resolveChatLlmReadiness(
    config({ provider: "chatgpt", model: "subscription-slug" }),
  );
  assert.equal(ready.configured, false);
  assert.match(ready.message, /支持 roll chat 和 scheduler.*暂不支持 Runtime.*Companion/);
});

test("optional subscription picker retains catalog registration across another login", async () => {
  const { loadAuthenticatedChatGptModels } = await import("./chatgpt-resolution.ts");
  let activeAccount = current;
  const selected: Array<string | undefined> = [];
  const auth: ChatGptAuth = {
    async status() {
      return {
        currentAccountId: activeAccount,
        accounts: [
          { id: current, label: "Current", connected: true, authorized: true },
          { id: saved, label: "Other", connected: true, authorized: true },
        ],
        usageUrl: "https://chatgpt.com/settings/usage",
      };
    },
    async models(id) {
      selected.push(id);
      return [{ slug: "subscription-slug", displayName: "Shared slug" }];
    },
    async getAccessToken() {
      throw new Error("not invoked during selection");
    },
  };
  const choices = await loadAuthenticatedChatGptModels(auth);
  assert.equal(choices.accountId, current);
  activeAccount = saved;
  await resolveInteractiveChatSwitch(
    config(),
    { provider: "chatgpt", model: "subscription-slug" },
    "medium",
    choices.accountId,
    auth,
  );
  assert.deepEqual(selected, [current, current]);
});
