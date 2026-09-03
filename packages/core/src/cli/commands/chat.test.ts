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
import type { AgentSession, SessionEvent, ShellProfile } from "@roll-agent/runtime";
import type { ChatUserInputPrompt, ChatUserInputResult } from "../utils/user-input-prompts.ts";
import { rollConfigSchema } from "../../config/schema.ts";
import {
  CHAT_ENGINE_SURFACES,
  chatHostModeForSurface,
  createChatEngine,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  resolveChatLlmSwitch,
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

test("resolveChatLlmSwitch builds an engine switch from config for the chosen provider", () => {
  const config = parseChatConfig({
    llm: {
      defaultProvider: "qwen",
      defaultModel: "qwen3.8-max",
      providers: { qwen: { apiKey: "k" }, google: { apiKey: "g" } },
    },
    agents: { dataDir: "/tmp/agents" },
  });
  const next = resolveChatLlmSwitch(
    config,
    { provider: "google", model: "gemini-3.8-flash" },
    "high",
  );
  assert.equal(next.modelName, "gemini-3.8-flash");
  assert.equal(next.model.modelId, "gemini-3.8-flash");
  assert.deepEqual(next.providerOptions, {
    google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
  });
  assert.equal(next.structuredOutputReasoning, "high");
  assert.throws(
    () => resolveChatLlmSwitch(config, { provider: "xai", model: "grok-4.5" }, "medium"),
    /未配置/u,
  );
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

test("runJsonTurn does not start a turn after its stop signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("scheduled exec stopping"));
  let sends = 0;
  const session = {
    id: "pre-aborted-json-turn",
    async *send() {
      sends += 1;
      yield { type: "message-finish", text: "should not run" } satisfies SessionEvent;
    },
    cancel() {
      return false;
    },
    reject() {
      return true;
    },
    getContextWindow() {
      return undefined;
    },
  } as unknown as AgentSession;

  const result = await runJsonTurn(session, "do not start", controller.signal);

  assert.equal(sends, 0);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.message : "", /停止请求/u);
});

test("runJsonTurn forwards an in-flight stop signal to AgentSession cancellation", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let cancellations = 0;
  const session = {
    id: "cancelled-json-turn",
    async *send() {
      started.resolve();
      await cancelled.promise;
      yield {
        type: "turn-cancelled",
        reason: "user",
        message: "scheduled turn stopped",
      } satisfies SessionEvent;
    },
    cancel() {
      cancellations += 1;
      cancelled.resolve();
      return true;
    },
    reject() {
      return true;
    },
    getContextWindow() {
      return undefined;
    },
  } as unknown as AgentSession;

  const running = runJsonTurn(session, "start work", controller.signal);
  await started.promise;
  controller.abort(new Error("scheduled exec stopping"));
  let result;
  try {
    result = await Promise.race([
      running,
      delay(100).then(() => {
        throw new Error("runJsonTurn did not cancel the active session");
      }),
    ]);
  } finally {
    cancelled.resolve();
    await running;
  }

  assert.equal(cancellations, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" ? result.message : "", "scheduled turn stopped");
});

test(
  "runJsonTurn stop signal cancels a real AgentSession direct Bash process tree",
  { skip: process.platform === "win32", timeout: 20_000 },
  async () => {
    const runtime = await import("@roll-agent/runtime");
    const bashStarted = Promise.withResolvers<void>();
    const killIntents: string[] = [];
    const profile: ShellProfile = {
      id: "posix",
      toolName: "bash",
      supportsSessionExec: true,
      supportsSafeCommandClassification: true,
      waitForTreeKillAfterRootExit: false,
      buildSpawn: (command, workdir, env) => {
        bashStarted.resolve();
        return {
          file: "/bin/sh",
          args: ["-c", command],
          options: { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
        };
      },
      classify: () => "known-safe",
      killTree: async (pid, intent) => {
        killIntents.push(intent);
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
      },
      systemPromptHints: () => [],
    };
    let modelCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCall += 1;
        const chunks: LanguageModelV4StreamPart[] =
          modelCall === 1
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "w14-bash",
                  toolName: "roll__bash",
                  input: JSON.stringify({ command: "printf w14-running; sleep 30" }),
                },
                {
                  type: "finish",
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "should not finish" },
                { type: "text-end", id: "t" },
                {
                  type: "finish",
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                  finishReason: { unified: "stop", raw: "stop" },
                },
              ];
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const session = new runtime.AgentSession({
      id: "scheduled-w14-integration",
      model,
      sources: [],
      maxSteps: 4,
      policy: new runtime.ConfigurableToolPolicy({
        defaultMode: "auto",
        overrides: { "roll.bash": "auto" },
      }),
      bash: {
        profile,
        workdir: tmpdir(),
        defaultTimeoutMs: 60_000,
        maxTimeoutMs: 60_000,
        turnTimeoutMs: 60_000,
        maxCaptureBytes: 1_048_576,
        maxModelOutputChars: 16_000,
      },
    });
    const controller = new AbortController();

    try {
      const running = runJsonTurn(session, "run Bash", controller.signal);
      await bashStarted.promise;
      controller.abort(new Error("scheduled exec stopping"));
      const result = await running;
      assert.equal(result.status, "failed");
      assert.deepEqual(killIntents, ["terminate"]);
    } finally {
      await session.close();
    }
  },
);

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

function replFakeSession(id: string): {
  readonly session: AgentSession;
  readonly sent: () => readonly string[];
  readonly isClosed: () => boolean;
} {
  let closed = false;
  const sent: string[] = [];
  const session = {
    id,
    async *send(message: string) {
      sent.push(message);
      yield { type: "message-finish", text: "done" } satisfies SessionEvent;
    },
    close: async () => {
      closed = true;
    },
    getMessages: () => [],
    getContextWindow: () => undefined,
    getSkillSummaries: () => [],
    setUserInputAvailable: () => {},
  } as unknown as AgentSession;
  return { session, sent: () => sent, isClosed: () => closed };
}

test("runRepl switches sessions via /resume", async () => {
  const first = replFakeSession("s1");
  const second = replFakeSession("s2");
  const deleted: string[] = [];
  const switched: string[] = [];
  const store = {
    listThreads: () => [
      { id: "s1", title: "当前", updatedAt: "2026-08-05T10:00:00.000Z" },
      { id: "t2", title: "发布计划", updatedAt: "2026-08-05T09:00:00.000Z" },
    ],
    countMessages: () => 2,
    getThread: (threadId: string) =>
      threadId === "s2" ? { id: "s2", title: "发布计划" } : undefined,
    updateTitle: () => {},
    deleteThread: (threadId: string) => deleted.push(threadId),
  } as unknown as Parameters<typeof runRepl>[1];
  const input = new PassThrough();
  const done = runRepl(first.session, store, false, {
    input,
    output: sink(),
    sessionPicker: async (items) => {
      assert.deepEqual(
        items.map((item) => item.id),
        ["t2"],
      );
      return "t2";
    },
    resumeSession: async () => second.session,
    onActiveSessionChange: (next) => switched.push(next.id),
  });
  await delay(20);
  input.write("/resume\n");
  await delay(30);
  input.write("hi\n");
  await delay(30);
  input.write("exit\n");
  input.end();
  await done;
  assert.deepEqual(switched, ["s2"]);
  assert.equal(first.isClosed(), true);
  assert.deepEqual(second.sent(), ["hi"]);
  assert.deepEqual(first.sent(), []);
  assert.deepEqual(deleted, []);
});

test("runRepl keeps current session when picker cancels or resume fails", async () => {
  const first = replFakeSession("s1");
  const store = {
    listThreads: () => [{ id: "t2", title: "发布计划", updatedAt: "2026-08-05T09:00:00.000Z" }],
    countMessages: () => 2,
    getThread: () => undefined,
    updateTitle: () => {},
    deleteThread: () => {},
  } as unknown as Parameters<typeof runRepl>[1];
  const input = new PassThrough();
  let call = 0;
  const done = runRepl(first.session, store, false, {
    input,
    output: sink(),
    sessionPicker: async () => {
      call += 1;
      return call === 1 ? undefined : "t2";
    },
    resumeSession: async () => {
      throw new Error("线程不存在");
    },
  });
  await delay(20);
  input.write("/resume\n");
  await delay(30);
  input.write("/resume\n");
  await delay(30);
  input.write("hi\n");
  await delay(30);
  input.write("exit\n");
  input.end();
  await done;
  assert.equal(call, 2);
  assert.equal(first.isClosed(), false);
  assert.deepEqual(first.sent(), ["hi"]);
});

test("runRepl /diff on 让后续文件变更 diff 完整输出，/diff off 恢复折叠", async () => {
  const input = new PassThrough();
  const bigUnified = [
    "--- a/big.txt",
    "+++ b/big.txt",
    "@@ -0,0 +1,50 @@",
    ...Array.from({ length: 50 }, (_, index) => `+row ${String(index)}`),
    "",
  ].join("\n");
  const session = {
    id: "session-diff",
    async *send() {
      yield {
        type: "tool-call",
        toolCallId: "call-diff",
        agentName: "roll",
        toolName: "write_file",
        input: { file_path: "big.txt" },
      } satisfies SessionEvent;
      yield {
        type: "tool-result",
        toolCallId: "call-diff",
        agentName: "roll",
        toolName: "write_file",
        output: "",
        isError: false,
        display: {
          text: "已写入 big.txt",
          diff: {
            path: "big.txt",
            change: "create",
            added: 50,
            removed: 0,
            hunks: 1,
            unified: bigUnified,
            truncated: false,
          },
        },
      } satisfies SessionEvent;
      yield { type: "message-finish", text: "done" } satisfies SessionEvent;
    },
    approve() {
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
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const done = runRepl(session, store, false, {
      input,
      output: sink(),
      confirm: async () => true,
    });
    input.write("/diff on\n");
    await delay(10);
    input.write("first\n");
    await delay(30);
    const expandedSlice = stderr;
    input.write("/diff off\n");
    await delay(10);
    input.write("second\n");
    await delay(30);
    input.write("exit\n");
    input.end();
    await done;
    const collapsedSlice = stderr.slice(expandedSlice.length);
    assert.match(expandedSlice, /文件变更 diff 将完整显示/u);
    assert.match(expandedSlice, /50 \+ row 49/u);
    assert.doesNotMatch(expandedSlice, /另 \d+ 行/u);
    assert.match(collapsedSlice, /折叠为一行摘要/u);
    assert.match(collapsedSlice, /另 10 行（\/diff on 展开）/u);
    assert.doesNotMatch(collapsedSlice, /row 49/u);
  } finally {
    process.stderr.write = originalWrite;
  }
});
