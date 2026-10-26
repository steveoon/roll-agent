import { mapRuntimeSettings } from "./engine-factory.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  ConversationEngine,
  ThreadStore,
  type SessionEvent,
} from "@roll-agent/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createChatGptModel } from "../llm/chatgpt-model.ts";
import { ChatGptConnection } from "./chatgpt-connection.ts";
import { createChatGptTurnRecovery } from "./chatgpt-turn-recovery.ts";
import { rollConfigSchema } from "../config/schema.ts";
import { resolveInteractiveChatLlm, type ChatGptAuth } from "./chatgpt-resolution.ts";
import { createChatGptSessionPreparation } from "./chatgpt-session-preparation.ts";
import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";

function chunks(value: string, complete: boolean): string[] {
  return [
    {
      type: "response.created",
      response: { id: "resp-fixture", created_at: 1700000000, model: "fixture" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg-fixture" },
    },
    { type: "response.output_text.delta", item_id: "msg-fixture", output_index: 0, delta: value },
    ...(complete
      ? [
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "message", id: "msg-fixture" },
          },
          {
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 7, output_tokens: 1 } },
          },
        ]
      : []),
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
}

for (const interrupted of [true, false]) {
  test(`tool arguments ${interrupted ? "EOF recovers" : "invalid completion stays terminal"} without replaying completed effects`, async () => {
    const prompts: string[] = [];
    let effects = 0;
    let approvals = 0;
    const auth: ChatGptAuth = {
      status: async () => ({ accounts: [], usageUrl: "https://chatgpt.com/settings/usage" }),
      models: async () => [{ slug: "fixture", displayName: "Fixture" }],
      getAccessToken: async () => "synthetic",
    };
    const connection = new ChatGptConnection(auth, "fixture", []);
    await connection.ensure();
    const toolFrames = (id: string, complete: boolean): string[] => {
      const item = {
        type: "function_call",
        id,
        call_id: id,
        name: "fixture__write",
        namespace: "roll",
        arguments: "",
      };
      return [
        { type: "response.output_item.added", output_index: 0, item },
        {
          type: "response.function_call_arguments.delta",
          item_id: id,
          output_index: 0,
          delta: complete ? '{"q":"once"}' : '{"q":"unfinished-argument-sentinel',
        },
        ...(complete
          ? [
              {
                type: "response.output_item.done",
                output_index: 0,
                item: { ...item, arguments: '{"q":"once"}', status: "completed" },
              },
            ]
          : []),
        ...(complete || !interrupted
          ? [
              {
                type: "response.completed",
                response: { status: "completed", usage: { input_tokens: 7, output_tokens: 1 } },
              },
            ]
          : []),
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
    };
    const replies = [
      toolFrames("first", true),
      toolFrames("partial", false),
      toolFrames("regenerated", true),
      chunks("done", true),
    ];
    const model = createChatGptModel({
      modelId: "fixture",
      getAccessToken: async () => "synthetic",
      fetch: async (_url, init) => {
        prompts.push(String(init?.body));
        const reply = replies.shift();
        assert.ok(reply, "unexpected model request");
        return new Response(reply.join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const client = new Client({ name: "fixture", version: "1" });
    Object.defineProperty(client, "callTool", {
      value: async () => {
        effects++;
        return { content: [{ type: "text", text: `completed-effect-${effects}` }] };
      },
    });
    const session = new AgentSession({
      id: "tool-eof",
      model,
      modelRecovery: createChatGptTurnRecovery(connection),
      maxSteps: 5,
      policy: { check: () => ({ action: "confirm" }) },
      sources: [
        {
          agentName: "fixture",
          client,
          tools: [
            {
              tool: {
                name: "write",
                inputSchema: {
                  type: "object",
                  properties: { q: { type: "string" } },
                  required: ["q"],
                },
              },
              annotations: undefined,
            },
          ],
        },
      ],
    });
    try {
      const events: SessionEvent[] = [];
      for await (const event of session.send("run both tools once")) {
        events.push(event);
        if (event.type === "model-recovery") assert.equal(effects, 1);
        if (event.type === "confirmation-required") {
          approvals++;
          session.approve(event.approvalId);
        }
      }
      assert.equal(effects, interrupted ? 2 : 1);
      assert.equal(approvals, effects);
      assert.equal(prompts.length, interrupted ? 4 : 2);
      assert.equal(
        events.filter((event) => event.type === "model-recovery").length,
        interrupted ? 1 : 0,
      );
      assert.equal(events.at(-1)?.type, interrupted ? "message-finish" : "error");
      assert.equal(session.getMessages().filter((message) => message.role === "user").length, 1);
      assert.doesNotMatch(JSON.stringify(session.getMessages()), /unfinished-argument-sentinel/);
      if (interrupted) {
        assert.match(prompts[2]!, /completed-effect-1/);
        assert.doesNotMatch(prompts[2]!, /unfinished-argument-sentinel/);
      }
      assert.equal(
        session.getToolExecutions().filter((record) => record.outcome.kind === "success").length,
        effects,
      );
    } finally {
      await session.close();
      connection.dispose();
    }
  });
}

for (const scenario of ["fetch", "body", "eof", "preflight"] as const) {
  test(`interactive ChatGPT ${scenario} interruption resumes one SQLite input without stale drafts or notices`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "roll-same-turn-"));
    const store = new ThreadStore(dir);
    const requests: string[] = [];
    let online = scenario !== "preflight";
    let catalogCalls = 0;
    const auth: ChatGptAuth = {
      status: async () => ({
        currentAccountId: "fixture",
        accounts: [],
        usageUrl: "https://chatgpt.com/settings/usage",
      }),
      models: async () => {
        catalogCalls++;
        if (!online) throw new ChatGptAuthError("network_error", "离线");
        return [{ slug: "fixture", displayName: "Fixture" }];
      },
      getAccessToken: async () => "synthetic",
    };
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: Parameters<typeof fetch>[1]) => {
      requests.push(String(init?.body));
      if (requests.length === 1 && scenario === "fetch") throw new TypeError("private-fetch-error");
      const fail = requests.length === 1 && (scenario === "body" || scenario === "eof");
      const parts = chunks(fail ? "unfinished-draft-sentinel" : "done", !fail);
      if (scenario === "body" && fail) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const next = parts.shift();
              if (next) controller.enqueue(new TextEncoder().encode(next));
              else controller.error(new TypeError("private-body-error"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const config = rollConfigSchema.parse({
      ask: {},
      agents: { dataDir: join(dir, "agents") },
      llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
      runtime: { provider: "chatgpt", model: "fixture" },
    });
    const selected = await resolveInteractiveChatLlm(config, {
      auth,
      deferConnection: true,
      enableRecovery: true,
    });
    assert.ok(selected.connection && selected.modelRecovery);
    const states: string[] = [];
    const connection = selected.connection;
    connection.subscribe(() => states.push(connection.getSnapshot().state));
    const engine = new ConversationEngine({
      settings: mapRuntimeSettings(config),
      provider: "chatgpt",
      modelName: "fixture",
      store,
      model: selected.model,
      modelRecovery: selected.modelRecovery,
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
      const preparation = createChatGptSessionPreparation({
        connection,
        engine,
        getSession: () => session,
        getSelection: () => selected,
      });
      await preparation.prepare();
      preparation.dispose();
      const events: SessionEvent[] = [];
      for await (const event of session.send("KEEP_ONE_INPUT")) {
        events.push(event);
        if (event.type === "model-recovery") online = true;
      }
      assert.equal(
        events.some((event) => event.type === "error"),
        false,
        JSON.stringify(events),
      );
      assert.equal(events.filter((event) => event.type === "model-recovery").length, 1);
      assert.equal(events.at(-1)?.type, "message-finish");
      assert.equal(requests.length, scenario === "preflight" ? 1 : 2);
      assert.equal(store.listTurnInputs(session.id).length, 1);
      assert.equal(session.getMessages().filter((message) => message.role === "user").length, 1);
      assert.doesNotMatch(
        JSON.stringify(store.listTranscriptMessages(session.id)),
        /unfinished-draft-sentinel|private-.*-error/,
      );
      assert.doesNotMatch(requests.at(-1) ?? "", /unfinished-draft-sentinel/);
      assert.equal(states.includes("failed"), false);
      assert.equal(connection.getSnapshot().state, "connected");
      assert.equal(catalogCalls, 2);
    } finally {
      connection.dispose();
      await engine.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
