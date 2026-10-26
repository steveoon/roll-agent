import { mapRuntimeSettings } from "./engine-factory.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import * as runtime from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import {
  resolveInteractiveChatLlm,
  resolveInteractiveChatSwitch,
  type ChatGptAuth,
} from "./chatgpt-resolution.ts";
import { createChatGptCatalog } from "./chatgpt-catalog.ts";
import { createChatGptSessionPreparation } from "./chatgpt-session-preparation.ts";
import { providerAcceptsToolSchemaIssues } from "../llm/providers.ts";

test("initial model selection preserves schema policy through reconnect preparation", async () => {
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/tmp/unused-prepare-schema-policy" },
    llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
    runtime: { provider: "chatgpt", model: "fixture" },
  });
  const auth: ChatGptAuth = {
    status: async () => ({
      currentAccountId: "00000000-0000-4000-8000-000000000001",
      accounts: [],
      usageUrl: "https://chatgpt.com/settings/usage",
    }),
    cachedModels: () => [],
    models: async () => [{ slug: "fixture", displayName: "Fixture", contextWindow: 64000 }],
    getAccessToken: async () => "synthetic",
  };
  const selected = await resolveInteractiveChatLlm(config, { auth, deferConnection: true });
  assert.ok(selected.connection);
  const connection = selected.connection;
  const engine = new runtime.ConversationEngine({
    settings: mapRuntimeSettings(config),
    provider: selected.provider,
    modelName: selected.modelName,
    model: selected.model,
    toolSchemaPolicy: (issues) => providerAcceptsToolSchemaIssues(selected.provider, issues),
    modelCatalog: createChatGptCatalog(
      runtime,
      new runtime.ModelCatalog({ snapshot: { fetchedAt: "2026-10-26T00:00:00Z", providers: {} } }),
      () => connection.models,
    ),
    sources: [
      {
        agentName: "schema-agent",
        client: { callTool: async () => ({ content: [] }) },
        tools: [
          {
            tool: {
              name: "passthrough",
              inputSchema: { type: "object", properties: { x: { $ref: "#/properties/missing" } } },
            },
            annotations: undefined,
          },
        ],
      },
    ],
    skillLibrary: null,
    workspaceInstructions: null,
    fileToolsEnabled: false,
  });
  const session = await engine.createSession();
  const preparation = createChatGptSessionPreparation({
    connection,
    engine,
    getSession: () => session,
    getSelection: () => selected,
  });
  const hasTool = () =>
    session.getCapabilityManifest().tools.some((tool) => tool.id.endsWith("passthrough"));
  try {
    assert.equal(hasTool(), true);
    await preparation.prepare();
    assert.equal(session.getContextWindow(), 64000);
    assert.equal(hasTool(), true);
  } finally {
    preparation.dispose();
    connection.dispose();
    await engine.dispose();
  }
});

test("reconnect and first-send preparation refresh live session windows and respect explicit override", async () => {
  for (const scenario of ["empty", "stale", "override", "first-send", "during-turn"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "roll-prepare-window-"));
    const store = new runtime.ThreadStore(dir);
    const auth: ChatGptAuth = {
      status: async () => ({
        currentAccountId: "00000000-0000-4000-8000-000000000001",
        accounts: [],
        usageUrl: "https://chatgpt.com/settings/usage",
      }),
      cachedModels: () =>
        scenario === "stale" || scenario === "during-turn"
          ? [{ slug: "fixture", displayName: "Fixture", contextWindow: 128000 }]
          : [],
      models: async () => [{ slug: "fixture", displayName: "Fixture", contextWindow: 64000 }],
      getAccessToken: async () => "synthetic",
    };
    const override = scenario === "override" ? 500000 : undefined;
    const config = rollConfigSchema.parse({
      ask: {},
      agents: { dataDir: join(dir, "agents") },
      llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
      runtime: {
        provider: "chatgpt",
        model: "fixture",
        ...(override ? { contextWindow: override } : {}),
      },
    });
    const resolved = await resolveInteractiveChatLlm(config, { auth, deferConnection: true });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const model =
      scenario === "during-turn"
        ? new MockLanguageModelV4({
            doStream: async () => {
              started.resolve();
              await release.promise;
              return {
                stream: simulateReadableStream({
                  chunks: [
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "t" },
                    { type: "text-delta", id: "t", delta: "done" },
                    { type: "text-end", id: "t" },
                    {
                      type: "finish",
                      finishReason: { unified: "stop", raw: "stop" },
                      usage: {
                        inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 1, text: 1, reasoning: 0 },
                      },
                    },
                  ],
                  initialDelayInMs: null,
                  chunkDelayInMs: null,
                }),
              };
            },
          })
        : resolved.model;
    const selected = { ...resolved, model };
    assert.ok(selected.connection);
    const connection = selected.connection;
    const catalog = createChatGptCatalog(
      runtime,
      new runtime.ModelCatalog({
        snapshot: { fetchedAt: new Date().toISOString(), providers: {} },
      }),
      () => connection.models,
    );
    const engine = new runtime.ConversationEngine({
      settings: mapRuntimeSettings(config),
      provider: "chatgpt",
      modelName: "fixture",
      store,
      model: selected.model,
      modelCatalog: catalog,
      sources: [],
      skillLibrary: null,
      workspaceInstructions: null,
      fileToolsEnabled: false,
      sessionExecEnabled: false,
      inspectVcsContext: async () => undefined,
    });
    const session = await engine.createSession();
    const preparation = createChatGptSessionPreparation({
      connection,
      engine,
      getSession: () => session,
      getSelection: () => selected,
      ...(override ? { contextWindowOverride: override } : {}),
    });
    try {
      assert.equal(
        session.getContextWindow(),
        override ?? (scenario === "stale" || scenario === "during-turn" ? 128000 : undefined),
      );
      if (scenario === "during-turn") {
        const turn = (async () => {
          const events: runtime.SessionEvent[] = [];
          for await (const event of session.send("task")) events.push(event);
          return events;
        })();
        await started.promise;
        assert.equal(session.canSwitchModel(), false);
        await connection.prepareRecovery(new AbortController().signal);
        assert.equal(connection.models[0]?.contextWindow, 64000);
        assert.equal(session.getContextWindow(), 128000);
        release.resolve();
        const events = await turn;
        assert.equal(events.at(-1)?.type, "message-finish");
        assert.equal(session.getContextWindow(), 128000);
        // A ready connection emits no new snapshot here; preparation must still synchronize.
        await preparation.prepare();
      } else if (scenario === "first-send") await preparation.prepare();
      else await connection.retry();
      assert.equal(session.getContextWindow(), override ?? 64000);
      if (scenario !== "during-turn") {
        assert.equal(store.listTranscriptMessages(session.id).length, 0);
      }
    } finally {
      release.resolve();
      preparation.dispose();
      connection.dispose();
      await engine.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("switched ChatGPT model shares recovery, error status and live validation", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new TypeError("fetch failed");
  });
  let available = true;
  const auth: ChatGptAuth = {
    status: async () => ({
      currentAccountId: "00000000-0000-4000-8000-000000000001",
      accounts: [],
      usageUrl: "https://chatgpt.com/settings/usage",
    }),
    models: async () => (available ? [{ slug: "fixture", displayName: "Fixture" }] : []),
    getAccessToken: async () => "synthetic",
  };
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/tmp/unused-chatgpt-switch-test" },
    llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
    runtime: { provider: "chatgpt", model: "fixture" },
  });
  const initial = await resolveInteractiveChatLlm(config, { auth, deferConnection: true });
  assert.ok(initial.connection);
  const connection = initial.connection;
  try {
    await connection.retry();
    connection.setEnabled(false);
    assert.deepEqual(connection.getSnapshot(), { state: "disabled" });
    const next = await resolveInteractiveChatSwitch(
      config,
      { provider: "chatgpt", model: "fixture" },
      "medium",
      initial.accountId,
      auth,
      connection,
    );
    connection.setEnabled(true);
    await assert.rejects(
      async () =>
        next.model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        }),
      /网络连接中断/,
    );
    const failed = connection.getSnapshot();
    assert.ok(failed.state === "failed");
    assert.match(failed.message, /网络中断.*\/reconnect/);
    assert.doesNotMatch(failed.message, /fetch failed/);
    assert.equal(calls, 1);
    available = false;
    await connection.retry();
    await assert.rejects(async () => next.model.doStream({ prompt: [] }), /不提供模型/);
    assert.equal(calls, 1);
  } finally {
    connection.dispose();
  }
});
