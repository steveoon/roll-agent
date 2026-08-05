import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import type { ChatUserInputPrompt, ChatUserInputResult } from "../utils/user-input-prompts.ts";
import { rollConfigSchema } from "../../config/schema.ts";
import {
  CHAT_ENGINE_SURFACES,
  chatHostModeForSurface,
  createChatEngine,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  runJsonTurn,
  runRepl,
} from "./chat.ts";

function parseChatConfig(input: Record<string, unknown> = {}) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "anthropic",
      defaultModel: "claude-test",
      providers: {
        anthropic: { apiKey: "anthropic-key" },
      },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-chat-test" },
    ...input,
  });
}

function fakeSession(events: readonly SessionEvent[], contextWindow?: number): AgentSession {
  return {
    id: "session-1",
    async *send() {
      for (const event of events) {
        yield event;
      }
    },
    reject() {
      return true;
    },
    getContextWindow() {
      return contextWindow;
    },
    getSkillSummaries() {
      return [];
    },
    setUserInputAvailable() {},
  } as unknown as AgentSession;
}

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

test("Ink/basic/positional/json/server share one effective capability manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "roll-chat-surfaces-"));
  const cases = [
    ["Ink", CHAT_ENGINE_SURFACES.ink],
    ["basic REPL", CHAT_ENGINE_SURFACES.basicRepl],
    ["positional one-shot", CHAT_ENGINE_SURFACES.oneShot],
    ["JSON one-shot", CHAT_ENGINE_SURFACES.json],
    ["server", CHAT_ENGINE_SURFACES.server],
  ] as const;
  const comparableManifests: string[] = [];

  try {
    const runtime = await import("@roll-agent/runtime");
    const config = parseChatConfig({
      agents: { dataDir: join(root, "agents") },
    });
    for (const [label, surface] of cases) {
      const store = new runtime.ThreadStore(join(root, surface));
      const engine = createChatEngine({
        runtime,
        config,
        model: new MockLanguageModelV4({}),
        store,
        surface,
      });
      try {
        const session = await engine.createSession({ title: label });
        const manifest = session.getCapabilityManifest();
        assert.equal(manifest.lifecycle.hostMode, chatHostModeForSurface(surface), label);
        comparableManifests.push(
          JSON.stringify({
            ...manifest,
            lifecycle: {
              manifest: manifest.lifecycle.manifest,
              turnContext: manifest.lifecycle.turnContext,
              sessionExec: manifest.lifecycle.sessionExec,
              sessionDurability: manifest.lifecycle.sessionDurability,
            },
          }),
        );
      } finally {
        await engine.dispose();
        store.close();
      }
    }

    assert.ok(comparableManifests[0]);
    for (const manifest of comparableManifests.slice(1)) {
      assert.equal(manifest, comparableManifests[0]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveChatLlmReadiness uses default provider when runtime provider is unset", () => {
  const status = resolveChatLlmReadiness(parseChatConfig({}));

  assert.equal(status.configured, true);
  assert.equal(status.status, "ready");
  assert.equal(status.provider, "anthropic");
  assert.equal(status.model, "claude-test");
});

test("resolveChatLlmCalls separates Qwen chat thinking from structured output", () => {
  const resolved = resolveChatLlmCalls("qwen", "qwen3.7-plus", "test-key", undefined, "high");

  assert.deepEqual(resolved.providerOptions, {
    alibaba: { enableThinking: true, thinkingBudget: 16_384 },
  });
  assert.deepEqual(resolved.structuredOutputProviderOptions, {
    alibaba: { enableThinking: false },
  });
  assert.equal(resolved.structuredOutputReasoning, undefined);
});

test("resolveChatLlmCalls uses unified reasoning for non-Qwen structured output", () => {
  const resolved = resolveChatLlmCalls(
    "openai",
    "gpt-5.5",
    "test-key",
    "https://example.test/v1",
    "high",
  );

  assert.deepEqual(resolved.providerOptions, {
    openai: { reasoningEffort: "high", store: false },
  });
  assert.equal(resolved.structuredOutputProviderOptions, undefined);
  assert.equal(resolved.structuredOutputReasoning, "high");
});

test("resolveChatLlmCalls lets compaction override the global thinking level", () => {
  const resolved = resolveChatLlmCalls(
    "anthropic",
    "claude-sonnet-4-6",
    "test-key",
    undefined,
    "low",
    "high",
  );

  assert.deepEqual(resolved.providerOptions, {
    anthropic: { thinking: { type: "adaptive" }, effort: "low" },
  });
  assert.equal(resolved.structuredOutputReasoning, "high");
});

test("resolveChatLlmCalls skips structured reasoning for truncate compaction", () => {
  const resolved = resolveChatLlmCalls(
    "xai",
    "grok-4.5",
    "test-key",
    undefined,
    "off",
    "off",
    false,
  );

  assert.equal(resolved.structuredOutputReasoning, undefined);
  assert.equal(resolved.structuredOutputProviderOptions, undefined);
});

test("createChatEngine forwards structured output controls to the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "roll-chat-structured-options-"));
  const runtime = await import("@roll-agent/runtime");
  const config = parseChatConfig({ agents: { dataDir: join(root, "agents") } });
  const store = new runtime.ThreadStore(join(root, "threads"));
  const structuredOutputProviderOptions = { alibaba: { enableThinking: false } };
  const engine = createChatEngine({
    runtime,
    config,
    model: new MockLanguageModelV4({}),
    store,
    surface: CHAT_ENGINE_SURFACES.oneShot,
    structuredOutputProviderOptions,
    structuredOutputReasoning: "high",
  });

  try {
    const session = await engine.createSession();
    assert.deepEqual(
      Reflect.get(session, "structuredOutputProviderOptions"),
      structuredOutputProviderOptions,
    );
    assert.equal(Reflect.get(session, "structuredOutputReasoning"), "high");
  } finally {
    await engine.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveChatLlmReadiness rejects missing runtime provider even when default provider is ready", () => {
  const status = resolveChatLlmReadiness(
    parseChatConfig({
      runtime: { provider: "openai", model: "gpt-test" },
    }),
  );

  assert.equal(status.configured, false);
  assert.equal(status.status, "missing-provider");
  assert.equal(status.provider, "openai");
  assert.match(status.message, /provider "openai" 未配置/);
});

test("resolveChatLlmReadiness rejects empty apiKey", () => {
  const status = resolveChatLlmReadiness(
    parseChatConfig({
      llm: {
        defaultProvider: "anthropic",
        defaultModel: "claude-test",
        providers: { anthropic: { apiKey: "   " } },
      },
    }),
  );

  assert.equal(status.configured, false);
  assert.equal(status.status, "missing-api-key");
  assert.match(status.message, /apiKey 未配置/);
});

test("resolveChatLlmReadiness rejects unresolved apiKey placeholder", () => {
  const status = resolveChatLlmReadiness(
    parseChatConfig({
      llm: {
        defaultProvider: "anthropic",
        defaultModel: "claude-test",
        providers: { anthropic: { apiKey: String.raw`\${ANTHROPIC_API_KEY}` } },
      },
    }),
  );

  assert.equal(status.configured, false);
  assert.equal(status.status, "unresolved-api-key");
  assert.match(status.message, /未解析的环境变量占位符/);
});

test("runJsonTurn exposes step and total token usage", async () => {
  const result = await runJsonTurn(
    fakeSession([
      { type: "text-delta", delta: "OK" },
      {
        type: "step-finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
      {
        type: "message-finish",
        text: "OK",
        totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        contextInputTokens: 3,
      },
    ]),
    "hi",
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "OK");
  assert.deepEqual(result.stepUsages, [
    {
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  ]);
  assert.deepEqual(result.totalUsage, { inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  assert.equal(result.status === "completed" ? result.contextInputTokens : undefined, 3);
});

test("runJsonTurn exposes session usage and context window", async () => {
  const result = await runJsonTurn(
    fakeSession(
      [
        { type: "text-delta", delta: "OK" },
        {
          type: "message-finish",
          text: "OK",
          totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
          sessionUsage: { inputTokens: 40, outputTokens: 50, totalTokens: 90 },
          contextInputTokens: 4,
        },
      ],
      200_000,
    ),
    "hi",
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" ? result.sessionUsage : undefined, {
    inputTokens: 40,
    outputTokens: 50,
    totalTokens: 90,
  });
  assert.equal(result.status === "completed" ? result.contextWindow : undefined, 200_000);
  assert.equal(result.status === "completed" ? result.contextInputTokens : undefined, 4);
});

test("runJsonTurn exposes context compaction events", async () => {
  const result = await runJsonTurn(
    fakeSession([
      {
        type: "context-compacted",
        reason: "auto",
        strategy: "truncate",
        removed: 2,
        kept: 4,
        beforeInputTokens: 90,
        checkpointId: "8ba32466-1cb6-4166-a496-fdd8ff048891",
        checkpointGeneration: 2,
        checkpointSummaryStatus: "valid",
      },
      { type: "text-delta", delta: "OK" },
      {
        type: "message-finish",
        text: "OK",
        totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      },
    ]),
    "hi",
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.status === "completed" ? result.compactions : undefined, [
    {
      reason: "auto",
      strategy: "truncate",
      removed: 2,
      kept: 4,
      beforeInputTokens: 90,
      checkpointId: "8ba32466-1cb6-4166-a496-fdd8ff048891",
      checkpointGeneration: 2,
      checkpointSummaryStatus: "valid",
    },
  ]);
});

test("runJsonTurn 通过真实 ConversationEngine + ThreadStore 完成一次 overflow 重放", async () => {
  const root = mkdtempSync(join(tmpdir(), "roll-json-overflow-"));
  try {
    const runtime = await import("@roll-agent/runtime");
    const config = parseChatConfig({
      runtime: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
      agents: { dataDir: join(root, "agents") },
    });
    const store = new runtime.ThreadStore(join(root, "threads"));
    const threadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: "json older turn" },
      { role: "assistant", content: "json older answer" },
      { role: "user", content: "json recent turn" },
      { role: "assistant", content: "json recent answer" },
    ]);
    let modelCalls = 0;
    const steps: readonly LanguageModelV4StreamPart[][] = [
      [
        { type: "stream-start", warnings: [] },
        { type: "error", error: "context_length_exceeded" },
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "json recovered once" },
        { type: "text-end", id: "t" },
        {
          type: "finish",
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          finishReason: { unified: "stop", raw: "stop" },
        },
      ],
    ];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const chunks = steps[modelCalls] ?? steps.at(-1) ?? [];
        modelCalls += 1;
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const engine = createChatEngine({
      runtime,
      config,
      model,
      store,
      surface: CHAT_ENGINE_SURFACES.json,
    });

    try {
      const session = await engine.resumeSession(threadId);
      const result = await runJsonTurn(session, "json overflow current turn");

      assert.equal(modelCalls, 2);
      assert.equal(result.status, "completed");
      assert.equal(
        result.status === "completed" ? result.output : undefined,
        "json recovered once",
      );
      assert.equal(result.status === "completed" ? (result.compactions?.length ?? 0) : 0, 1);
      const messages = store.getMessages(threadId);
      assert.equal(
        messages.filter(
          (message) => message.role === "user" && message.content === "json overflow current turn",
        ).length,
        1,
      );
      assert.equal(
        messages.filter(
          (message) =>
            message.role === "assistant" &&
            JSON.stringify(message.content).includes("json recovered once"),
        ).length,
        1,
      );
    } finally {
      await engine.dispose();
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRepl keeps the prompt stream available around confirmation prompts", async () => {
  const input = new PassThrough();
  const sentMessages: string[] = [];
  const approved: string[] = [];
  const confirmationMessages: string[] = [];
  const session = {
    id: "session-1",
    async *send(message: string) {
      sentMessages.push(message);
      yield {
        type: "confirmation-required",
        approvalId: "approval-1",
        agentName: "browser-use-agent",
        toolName: "click_ref",
        input: {},
      } satisfies SessionEvent;
      yield { type: "message-finish", text: "done" } satisfies SessionEvent;
    },
    approve(approvalId: string) {
      approved.push(approvalId);
      return true;
    },
    reject() {
      return true;
    },
    getContextWindow() {
      return undefined;
    },
    getSkillSummaries() {
      return [];
    },
    setUserInputAvailable() {},
  } as unknown as AgentSession;
  const store = {
    updateTitle() {},
    countMessages() {
      return 1;
    },
    deleteThread() {},
  } as unknown as Parameters<typeof runRepl>[1];

  const done = runRepl(session, store, false, {
    input,
    output: sink(),
    confirm: async (message) => {
      confirmationMessages.push(message);
      return true;
    },
  });
  input.write("run\n");
  await delay(10);
  input.write("exit\n");
  input.end();

  await done;

  assert.deepEqual(sentMessages, ["run"]);
  assert.deepEqual(confirmationMessages, ["执行 browser-use-agent.click_ref?"]);
  assert.deepEqual(approved, ["approval-1"]);
});

test("runRepl shows a cleaned AI explanation before approval details", async () => {
  const input = new PassThrough();
  const approved: string[] = [];
  const confirmationMessages: string[] = [];
  const session = {
    id: "session-explanation",
    async *send() {
      yield {
        type: "confirmation-required",
        approvalId: "approval-explanation",
        agentName: "roll",
        toolName: "bash",
        input: { command: "pnpm --filter @roll-agent/core test" },
        explanation: "  运行 Core 测试，\n\t确认审批界面没有回归\u0000  ",
      } satisfies SessionEvent;
      yield { type: "message-finish", text: "done" } satisfies SessionEvent;
    },
    approve(approvalId: string) {
      approved.push(approvalId);
      return true;
    },
    reject() {
      return true;
    },
    getContextWindow() {
      return undefined;
    },
    getSkillSummaries() {
      return [];
    },
    setUserInputAvailable() {},
  } as unknown as AgentSession;
  const store = {
    updateTitle() {},
    countMessages() {
      return 1;
    },
    deleteThread() {},
  } as unknown as Parameters<typeof runRepl>[1];

  const done = runRepl(session, store, false, {
    input,
    output: sink(),
    confirm: async (message) => {
      confirmationMessages.push(message);
      return true;
    },
  });
  input.write("run\n");
  await delay(10);
  input.write("exit\n");
  input.end();

  await done;

  assert.deepEqual(confirmationMessages, [
    [
      "执行 roll.bash?",
      "AI 说明：运行 Core 测试， 确认审批界面没有回归",
      "command: pnpm --filter @roll-agent/core test",
    ].join("\n"),
  ]);
  assert.deepEqual(approved, ["approval-explanation"]);
});

test("runRepl closes a pending prompt when shutdown is requested", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const session = {
    id: "session-signal",
    getContextWindow() {
      return undefined;
    },
    getSkillSummaries() {
      return [];
    },
    setUserInputAvailable() {},
  } as unknown as AgentSession;
  const store = {
    updateTitle() {},
    countMessages() {
      return 1;
    },
    deleteThread() {},
  } as unknown as Parameters<typeof runRepl>[1];

  const done = runRepl(session, store, false, {
    input,
    output: sink(),
    signal: controller.signal,
  });
  await delay(10);
  controller.abort(new Error("shutdown"));

  await done;
});

test("runRepl cancels a pending confirmation when shutdown is requested", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const confirmStarted = Promise.withResolvers<void>();
  const rejected: string[] = [];
  let observedSignal: AbortSignal | undefined;
  const session = {
    id: "session-confirm-signal",
    async *send() {
      yield {
        type: "confirmation-required",
        approvalId: "approval-signal",
        agentName: "browser-use-agent",
        toolName: "click_ref",
        input: {},
      } satisfies SessionEvent;
      yield { type: "message-finish", text: "" } satisfies SessionEvent;
    },
    approve() {
      return true;
    },
    reject(approvalId: string) {
      rejected.push(approvalId);
      return true;
    },
    getContextWindow() {
      return undefined;
    },
    getSkillSummaries() {
      return [];
    },
    setUserInputAvailable() {},
  } as unknown as AgentSession;
  const store = {
    updateTitle() {},
    countMessages() {
      return 1;
    },
    deleteThread() {},
  } as unknown as Parameters<typeof runRepl>[1];

  const done = runRepl(session, store, false, {
    input,
    output: sink(),
    signal: controller.signal,
    confirm: async (_message, signal) => {
      observedSignal = signal;
      confirmStarted.resolve();
      if (signal?.aborted === true) {
        return false;
      }
      return await new Promise<boolean>((resolve) => {
        signal?.addEventListener("abort", () => resolve(false), { once: true });
      });
    },
  });
  input.write("run\n");
  await confirmStarted.promise;
  controller.abort(new Error("shutdown"));
  input.end();

  await done;

  assert.equal(observedSignal, controller.signal);
  assert.deepEqual(rejected, ["approval-signal"]);
});

test("runRepl enables typed user input and resumes readline after submission", async () => {
  type UserInputRequiredEvent = Extract<SessionEvent, { readonly type: "user-input-required" }>;
  const requestId = "b92f0f10-a5f5-4fad-a243-53d39c9972bf" as UserInputRequiredEvent["requestId"];
  const input = new PassThrough();
  const promptStarted = Promise.withResolvers<void>();
  const promptResult = Promise.withResolvers<ChatUserInputResult>();
  const sentMessages: string[] = [];
  const capabilityStates: boolean[] = [];
  const resolved: Array<{ readonly requestId: string; readonly result: ChatUserInputResult }> = [];
  let confirmationCalls = 0;
  let firstTurn = true;
  const session = {
    id: "session-user-input",
    async *send(message: string) {
      sentMessages.push(message);
      if (firstTurn) {
        firstTurn = false;
        yield {
          type: "user-input-required",
          requestId,
          expiresAt: "2030-01-01T00:00:00.000Z",
          form: {
            controls: [
              {
                type: "choice",
                id: "region",
                label: "部署区域",
                required: true,
                multiple: false,
                options: [{ id: "sg", label: "Singapore" }],
              },
            ],
          },
        } satisfies SessionEvent;
      }
      yield { type: "message-finish", text: "done" } satisfies SessionEvent;
    },
    approve() {
      return true;
    },
    reject() {
      return true;
    },
    resolveUserInput(candidateRequestId: string, result: ChatUserInputResult) {
      resolved.push({ requestId: candidateRequestId, result });
      return true;
    },
    cancelUserInput() {
      return true;
    },
    cancel() {
      assert.fail("submitting user input must not cancel the Turn");
    },
    setUserInputAvailable(available: boolean) {
      capabilityStates.push(available);
    },
    getContextWindow() {
      return undefined;
    },
    getSkillSummaries() {
      return [];
    },
  } as unknown as AgentSession;
  const store = {
    updateTitle() {},
    countMessages() {
      return 1;
    },
    deleteThread() {},
  } as unknown as Parameters<typeof runRepl>[1];
  const userInputPrompt: ChatUserInputPrompt = {
    async request() {
      promptStarted.resolve();
      return promptResult.promise;
    },
  };

  const done = runRepl(session, store, false, {
    input,
    output: sink(),
    confirm: async () => {
      confirmationCalls += 1;
      return true;
    },
    userInputPrompt,
  });
  input.write("run\n");
  await promptStarted.promise;
  input.write("next\n");
  promptResult.resolve({
    status: "submitted",
    values: [{ id: "region", value: "sg" }],
  });
  await delay(10);
  input.write("exit\n");
  input.end();

  await done;

  assert.deepEqual(sentMessages, ["run", "next"]);
  assert.deepEqual(capabilityStates, [true, false]);
  assert.deepEqual(resolved, [
    {
      requestId,
      result: { status: "submitted", values: [{ id: "region", value: "sg" }] },
    },
  ]);
  assert.equal(confirmationCalls, 0, "Approval confirm must not answer user input");
});

test("runRepl settles shutdown during user input as cancelled without cancelling the Turn", async () => {
  type UserInputRequiredEvent = Extract<SessionEvent, { readonly type: "user-input-required" }>;
  const requestId = "2700be7e-5f5a-4509-9681-b47432074388" as UserInputRequiredEvent["requestId"];
  const input = new PassThrough();
  const controller = new AbortController();
  const promptStarted = Promise.withResolvers<void>();
  const cancellations: Array<{ readonly requestId: string; readonly reason?: string }> = [];
  let turnCancellations = 0;
  const session = {
    id: "session-user-input-shutdown",
    async *send() {
      yield {
        type: "user-input-required",
        requestId,
        expiresAt: "2030-01-01T00:00:00.000Z",
        form: {
          controls: [
            {
              type: "text",
              id: "owner",
              label: "负责人",
              required: true,
            },
          ],
        },
      } satisfies SessionEvent;
      yield { type: "message-finish", text: "" } satisfies SessionEvent;
    },
    approve() {
      return true;
    },
    reject() {
      return true;
    },
    resolveUserInput() {
      return true;
    },
    cancelUserInput(candidateRequestId: string, reason?: string) {
      cancellations.push({
        requestId: candidateRequestId,
        ...(reason !== undefined ? { reason } : {}),
      });
      return true;
    },
    cancel() {
      turnCancellations += 1;
      return true;
    },
    setUserInputAvailable() {},
    getContextWindow() {
      return undefined;
    },
    getSkillSummaries() {
      return [];
    },
  } as unknown as AgentSession;
  const store = {
    updateTitle() {},
    countMessages() {
      return 1;
    },
    deleteThread() {},
  } as unknown as Parameters<typeof runRepl>[1];
  const userInputPrompt: ChatUserInputPrompt = {
    async request(_form, signal) {
      promptStarted.resolve();
      if (signal?.aborted === true) {
        return { status: "cancelled", reason: "会话正在关闭" };
      }
      return new Promise<ChatUserInputResult>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => resolve({ status: "cancelled", reason: "会话正在关闭" }),
          { once: true },
        );
      });
    },
  };

  const done = runRepl(session, store, false, {
    input,
    output: sink(),
    signal: controller.signal,
    userInputPrompt,
  });
  input.write("run\n");
  await promptStarted.promise;
  controller.abort(new Error("shutdown"));
  input.end();

  await done;

  assert.deepEqual(cancellations, [{ requestId, reason: "会话正在关闭" }]);
  assert.equal(turnCancellations, 0);
});
