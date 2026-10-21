import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";
import { ChatGptConnection } from "./chatgpt-connection.ts";
import { createChatGptTurnRecovery } from "./chatgpt-turn-recovery.ts";
import type { ChatGptAuth } from "./chatgpt-resolution.ts";
import { AgentSession, type SessionEvent } from "@roll-agent/runtime";
import { APICallError } from "@ai-sdk/provider";
import { createChatGptModel } from "../llm/chatgpt-model.ts";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createChatGptSessionPreparation } from "./chatgpt-session-preparation.ts";

function fixture() {
  let offline = true;
  const auth: ChatGptAuth = {
    status: async () => ({ accounts: [], usageUrl: "https://chatgpt.com/settings/usage" }),
    models: async () => {
      if (offline) throw new ChatGptAuthError("network_error", "offline");
      return [{ slug: "fixture", displayName: "Fixture" }];
    },
    getAccessToken: async () => "synthetic",
  };
  const connection = new ChatGptConnection(auth, "fixture", []);
  return {
    connection,
    recovery: createChatGptTurnRecovery(connection),
    online: () => {
      offline = false;
    },
  };
}

test("turn recovery suppresses transient notices, resets cached failures and quietly reconnects", async () => {
  const { connection, recovery, online } = fixture();
  const states: string[] = [];
  connection.subscribe(() => states.push(connection.getSnapshot().state));
  recovery.onTurnStart?.();
  await assert.rejects(connection.prepare());
  assert.equal(connection.getSnapshot().state, "connecting");
  recovery.onRecovering?.();
  online();
  await recovery.prepare(new AbortController().signal);
  recovery.onTurnEnd?.();
  assert.equal(connection.getSnapshot().state, "connected");
  assert.equal(states.includes("failed"), false);
  connection.dispose();
});

test("unsafe tool settlement ends the turn with a failed connection badge instead of idle", async (t) => {
  const { connection, recovery, online } = fixture();
  online();
  await connection.prepare();
  const offline = new ChatGptAuthError("network_error", "synthetic offline");
  const states: string[] = [];
  connection.subscribe(() => states.push(connection.getSnapshot().state));
  const client = new Client({ name: "recovery-fixture", version: "1.0.0" });
  const execute = t.mock.method(client, "callTool", async () => ({
    content: [{ type: "text", text: "completed once" }],
  }));
  const model = new MockLanguageModelV4({
    doStream: async () => {
      connection.failed(offline);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "c", toolName: "fixture__write", input: "{}" },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: {
                inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
            { type: "error", error: offline },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const session = new AgentSession({
    id: "unsafe-settlement",
    model,
    modelRecovery: recovery,
    maxSteps: 2,
    policy: { check: () => ({ action: "allow" }) },
    sources: [
      {
        agentName: "fixture",
        client,
        tools: [
          {
            tool: { name: "write", inputSchema: { type: "object", properties: {} } },
            annotations: undefined,
          },
        ],
      },
    ],
  });
  try {
    const events: SessionEvent[] = [];
    for await (const event of session.send("task")) events.push(event);
    assert.equal(execute.mock.callCount(), 1);
    assert.equal(model.doStreamCalls.length, 1);
    assert.equal(
      events.some((event) => event.type === "model-recovery"),
      false,
    );
    const error = events.find((event) => event.type === "error");
    assert.match(error?.message ?? "", /结果尚未完整结算/);
    const snapshot = connection.getSnapshot();
    assert.equal(snapshot.state, "failed");
    assert.ok(snapshot.state === "failed" && snapshot.reportedInTurn);
    assert.equal(states.filter((state) => state === "failed").length, 1);
    assert.equal(states.includes("idle"), false);
  } finally {
    await session.close();
    connection.dispose();
    await client.close();
  }
});

test("cancelled connection preparation cannot publish a late failure after finalization", async () => {
  const auth: ChatGptAuth = {
    status: async () => ({ accounts: [], usageUrl: "https://chatgpt.com/settings/usage" }),
    models: async (_account, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    getAccessToken: async () => "synthetic",
  };
  const connection = new ChatGptConnection(auth, "fixture", []);
  const recovery = createChatGptTurnRecovery(connection);
  const controller = new AbortController();
  recovery.onTurnStart?.();
  const pending = recovery.prepare(controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending);
  recovery.onTurnEnd?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.getSnapshot().state, "idle");
  connection.failed(new ChatGptAuthError("network_error", "fresh failure"));
  assert.equal(connection.getSnapshot().state, "failed");
  connection.dispose();
});

test("failed session synchronization releases preflight warning suppression", async () => {
  const auth: ChatGptAuth = {
    status: async () => ({ accounts: [], usageUrl: "https://chatgpt.com/settings/usage" }),
    models: async () => [{ slug: "fixture", displayName: "Fixture", contextWindow: 64000 }],
    getAccessToken: async () => "synthetic",
  };
  const connection = new ChatGptConnection(auth, "fixture", []);
  await connection.ensure();
  const model = new MockLanguageModelV4();
  const session = new AgentSession({ id: "preparation-failure", model, sources: [], maxSteps: 1 });
  const failure = new Error("session synchronization failed");
  const preparation = createChatGptSessionPreparation({
    connection,
    engine: {
      switchModel: () => {
        throw failure;
      },
    },
    getSession: () => session,
    getSelection: () => ({
      provider: "chatgpt",
      modelName: "fixture",
      model,
      modelRecovery: createChatGptTurnRecovery(connection),
    }),
  });
  try {
    await assert.rejects(preparation.prepare(), (error: unknown) => error === failure);
    preparation.dispose();
    connection.failed(new ChatGptAuthError("network_error", "later failure"));
    assert.equal(connection.getSnapshot().state, "failed");
  } finally {
    preparation.dispose();
    connection.dispose();
    await session.close();
  }
});

for (const transport of ["http", "stream-error", "stream-failed"] as const) {
  for (const [code, status, expected, connectionState] of [
    ["insufficient_quota", 429, /额度.*\/model/, "connected"],
    ["subscription_sharing_usage_limit_exceeded", 429, /额度/, "connected"],
    ["chatpass_v2_invalid_authorization_context", 401, /roll auth chatgpt login/, "failed"],
    ["chatpass_v2_scope_not_authorized", 403, /授权|权限/, "failed"],
    ["model_not_found", 404, /\/model/, "connected"],
    ["unknown_business_error", 503, /请求|响应/, "connected"],
  ] as const) {
    test(`turn recovery presents ${code} from ${transport} without retry or raw diagnostics`, async () => {
      const { connection, recovery, online } = fixture();
      online();
      await connection.ensure();
      let requests = 0;
      const model = createChatGptModel({
        modelId: "fixture",
        getAccessToken: async () => "synthetic",
        fetch: async () => {
          requests++;
          const error = { code, message: "private-token-sentinel", type: code, param: null };
          if (transport === "http") return Response.json({ error }, { status });
          const failure =
            transport === "stream-error"
              ? { ...error, type: "error", sequence_number: 2 }
              : { type: "response.failed", response: { error } };
          return new Response(
            [
              { type: "response.created", response: { id: "r", model: "fixture", created_at: 1 } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "m" },
              },
              { type: "response.output_text.delta", output_index: 0, item_id: "m", delta: "draft" },
              failure,
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        },
      });
      const session = new AgentSession({
        id: "error-presentation",
        model,
        modelRecovery: recovery,
        maxSteps: 1,
        sources: [],
      });
      try {
        const events: SessionEvent[] = [];
        for await (const event of session.send("fixture")) events.push(event);
        const errors = events.filter((event) => event.type === "error");
        assert.equal(requests, 1);
        assert.equal(events.filter((event) => event.type === "model-recovery").length, 0);
        assert.equal(errors.length, 1);
        assert.match(errors[0]!.message, expected);
        assert.doesNotMatch(JSON.stringify(errors), /private-token-sentinel|检查网络|\/reconnect/);
        assert.equal(connection.getSnapshot().state, connectionState);
        if (connectionState === "connected") await connection.ensure();
        else {
          const snapshot = connection.getSnapshot();
          assert.ok(snapshot.state === "failed");
          assert.match(snapshot.message, expected);
          assert.doesNotMatch(snapshot.message, /private-token-sentinel|\/reconnect/);
        }
      } finally {
        await session.close();
        connection.dispose();
      }
    });
  }
}

test("local model and effort errors preserve readiness; unknown auth diagnostics stay private", async () => {
  const { connection, recovery, online } = fixture();
  online();
  await connection.ensure();
  try {
    for (const [code, expected] of [
      ["model_unavailable", /\/model/],
      ["unsupported_effort", /\/effort/],
    ] as const) {
      const error = new ChatGptAuthError(code, "private-local-diagnostic");
      recovery.onTurnStart?.();
      assert.match(recovery.formatError?.(error) ?? "", expected);
      assert.doesNotMatch(recovery.formatError?.(error) ?? "", /private-|\/reconnect/);
      recovery.onTurnEnd?.(error);
      assert.equal(connection.getSnapshot().state, "connected");
      await connection.ensure();
    }
    const error = new ChatGptAuthError("unknown_auth_error", "private-token-sentinel");
    assert.doesNotMatch(recovery.formatError?.(error) ?? "", /private-|\/reconnect/);
    recovery.onTurnEnd?.(error);
    const failed = connection.getSnapshot();
    assert.ok(failed.state === "failed");
    assert.doesNotMatch(failed.message, /private-|\/reconnect/);
  } finally {
    connection.dispose();
  }
});

test("turn error guidance handles HTTP fallbacks and bounded causes without leaking diagnostics", () => {
  const { connection, recovery } = fixture();
  try {
    for (const [statusCode, expected] of [
      [401, /roll auth chatgpt login/],
      [403, /权限/],
      [429, /限流|额度/],
      [503, /网络|服务/],
      [400, /请求|响应/],
    ] as const) {
      const error = new APICallError({
        message: "private-token-sentinel",
        url: "https://example.invalid/secret",
        requestBodyValues: undefined,
        statusCode,
      });
      const message = recovery.formatError?.(new Error("private-wrapper", { cause: error })) ?? "";
      assert.match(message, expected);
      assert.doesNotMatch(message, /private-|secret/);
    }
    for (const [code, statusCode, expected] of [
      ["unrecognized_auth_code", 401, /roll auth chatgpt login/],
      ["unrecognized_auth_code", 403, /权限/],
      ["insufficient_quota", 503, /额度/],
      ["__proto__", 503, /响应异常/],
    ] as const) {
      const error = new APICallError({
        message: "private-token-sentinel",
        url: "https://example.invalid",
        requestBodyValues: undefined,
        statusCode,
        data: { error: { code } },
      });
      assert.match(recovery.formatError?.(error) ?? "", expected);
      assert.doesNotMatch(recovery.formatError?.(error) ?? "", /private-|\/reconnect/);
    }
    const circular = new Error("private-circular");
    circular.cause = circular;
    assert.doesNotMatch(recovery.formatError?.(circular) ?? "", /private-|\/reconnect/);
    const fake = new Error("insufficient_quota");
    assert.doesNotMatch(recovery.formatError?.(fake) ?? "", /额度/);
  } finally {
    connection.dispose();
  }
});

test("turn recovery finalization shows one safe terminal failure and cancellation releases suppression", async () => {
  const { connection, recovery } = fixture();
  recovery.onTurnStart?.();
  connection.failed(new ChatGptAuthError("network_error", "offline"));
  recovery.onTurnEnd?.(new ChatGptAuthError("network_error", "offline"));
  assert.equal(connection.getSnapshot().state, "failed");
  recovery.onTurnStart?.();
  recovery.onTurnEnd?.();
  assert.equal(connection.getSnapshot().state, "idle");
  connection.failed(new ChatGptAuthError("network_error", "new failure"));
  assert.equal(connection.getSnapshot().state, "failed");
  connection.dispose();
});
