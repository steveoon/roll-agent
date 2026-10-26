import { mapRuntimeSettings } from "./engine-factory.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationEngine, ThreadStore } from "@roll-agent/runtime";
import { rollConfigSchema } from "../config/schema.ts";
import { ChatGptAuthError } from "../auth/chatgpt/service.ts";
import { resolveInteractiveChatLlm, type ChatGptAuth } from "./chatgpt-resolution.ts";
import { createChatGptSessionPreparation } from "./chatgpt-session-preparation.ts";

test("failed auth preserves user input in SQLite; reconnect performs no inference and continuation retains it once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "roll-chatgpt-input-"));
  const store = new ThreadStore(dir);
  let online = false;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: Parameters<typeof fetch>[1]) => {
    requests.push(String(init?.body));
    const events = [
      {
        type: "response.created",
        response: { id: "resp-fixture", created_at: 1700000000, model: "fixture" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg-fixture" },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg-fixture",
        output_index: 0,
        delta: "done",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg-fixture" },
      },
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 7, output_tokens: 1 } },
      },
    ];
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const auth: ChatGptAuth = {
    status: async () => ({
      currentAccountId: "00000000-0000-4000-8000-000000000001",
      accounts: [],
      usageUrl: "https://chatgpt.com/settings/usage",
    }),
    models: async () => {
      if (!online) throw new ChatGptAuthError("network_error", "离线");
      return [{ slug: "fixture", displayName: "Fixture" }];
    },
    getAccessToken: async () => "synthetic",
  };
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: join(dir, "agents") },
    llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
    runtime: { provider: "chatgpt", model: "fixture" },
  });
  const selected = await resolveInteractiveChatLlm(config, { auth, deferConnection: true });
  const engine = new ConversationEngine({
    settings: mapRuntimeSettings(config),
    provider: "chatgpt",
    modelName: "fixture",
    store,
    model: selected.model,
    sources: [],
    skillLibrary: null,
    workspaceInstructions: null,
    fileToolsEnabled: false,
    sessionExecEnabled: false,
    inspectVcsContext: async () => undefined,
    ...(selected.providerOptions ? { providerOptions: selected.providerOptions } : {}),
  });
  try {
    const session = await engine.createSession();
    assert.ok(selected.connection);
    const preparation = createChatGptSessionPreparation({
      connection: selected.connection,
      engine,
      getSession: () => session,
      getSelection: () => selected,
    });
    await preparation.prepare();
    preparation.dispose();
    const failed = [];
    for await (const event of session.send("KEEP_OFFLINE_INPUT")) failed.push(event);
    assert.ok(failed.some((e) => e.type === "error"));
    assert.equal(requests.length, 0);
    const inputs = store.listTurnInputs(session.id);
    assert.equal(inputs.length, 1);
    online = true;
    await selected.connection?.retry();
    assert.equal(requests.length, 0);
    for await (const event of session.send("continue")) {
      assert.notEqual(event.type, "error", JSON.stringify(event));
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.split("KEEP_OFFLINE_INPUT").length, 2);
    assert.equal(store.listTurnInputs(session.id)[0]?.inputId, inputs[0]?.inputId);
    assert.equal(session.getToolExecutions().length, 0);
  } finally {
    selected.connection?.dispose();
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
