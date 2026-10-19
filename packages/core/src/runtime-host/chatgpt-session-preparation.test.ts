import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtime from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import {
  resolveInteractiveChatLlm,
  resolveInteractiveChatSwitch,
  type ChatGptAuth,
} from "./chatgpt-resolution.ts";
import { createChatGptCatalog } from "./chatgpt-catalog.ts";
import { createChatGptSessionPreparation } from "./chatgpt-session-preparation.ts";

test("reconnect and first-send preparation refresh live session windows and respect explicit override", async () => {
  for (const scenario of ["empty", "stale", "override", "first-send"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "roll-prepare-window-"));
    const store = new runtime.ThreadStore(dir);
    const auth: ChatGptAuth = {
      status: async () => ({
        currentAccountId: "00000000-0000-4000-8000-000000000001",
        accounts: [],
        usageUrl: "https://chatgpt.com/settings/usage",
      }),
      cachedModels: () =>
        scenario === "stale"
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
    const selected = await resolveInteractiveChatLlm(config, { auth, deferConnection: true });
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
      config,
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
        override ?? (scenario === "stale" ? 128000 : undefined),
      );
      if (scenario === "first-send") await preparation.prepare();
      else await connection.retry();
      assert.equal(session.getContextWindow(), override ?? 64000);
      assert.equal(store.listTranscriptMessages(session.id).length, 0);
    } finally {
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
    assert.equal(connection.getSnapshot(), "");
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
    assert.match(connection.getSnapshot(), /网络连接中断/);
    assert.equal(calls, 1);
    available = false;
    await connection.retry();
    await assert.rejects(async () => next.model.doStream({ prompt: [] }), /不提供模型/);
    assert.equal(calls, 1);
  } finally {
    connection.dispose();
  }
});
