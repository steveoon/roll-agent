import {
  runtimeSettingsSchema,
  ThreadStore,
  ModelCatalog,
  DefaultToolPolicy,
  ConversationEngine,
  buildSessionBashSettings,
  buildSessionExecSettings,
  CAPABILITY_HOST_MODES,
  type ConversationEngineOptions,
  type EngineModelSwitch,
  type SessionEvent,
  type ShellProfile,
  type AgentToolSource,
} from "@roll-agent/runtime";
import { test } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { simulateReadableStream, type ModelMessage } from "ai";

import { MockLanguageModelV4 } from "ai/test";

import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";

import { executeTranscriptTool } from "../tool-bridge/transcript-tool.ts";

import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";

import { successfulToolResult } from "../tool-bridge/normalize-result.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-engine-"));
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  const iterator = events[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (next.done !== true) {
    next = await iterator.next();
  }
}

const powershellProfile: ShellProfile = {
  id: "powershell",
  toolName: "powershell",
  supportsSessionExec: true,
  supportsSafeCommandClassification: false,
  buildSpawn: (command, workdir, env) => ({
    file: "pwsh",
    args: ["-EncodedCommand", command],
    options: { cwd: workdir, detached: false, stdio: ["ignore", "pipe", "pipe"], env },
  }),
  classify: () => "unknown",
  killTree: async () => {},
  systemPromptHints: () => ["当前 shell 后端是 PowerShell 7。"],
};

test("ConversationEngine records runtime model override on created threads", async () => {
  const dir = tempDir();
  try {
    const config = runtimeFixtureConfig({ provider: "mock", modelName: "runtime-model" });
    const store = new ThreadStore(dir);
    const engine = createEngine({
      config,
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
    });

    const session = await engine.createSession();
    const thread = store.getThread(session.id);

    assert.equal(thread?.model, "runtime-model");
    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 同一 thread 复用 live session，显式 close 后允许重建", async () => {
  const dir = tempDir();
  try {
    const config = runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
    const store = new ThreadStore(dir);
    const engine = createEngine({
      config,
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
    });

    const created = await engine.createSession();
    const firstResume = await engine.resumeSession(created.id);
    const secondResume = await engine.resumeSession(created.id);
    assert.equal(firstResume, created);
    assert.equal(secondResume, created);

    await created.close();
    const [rebuilt, concurrentlyResumed] = await Promise.all([
      engine.resumeSession(created.id),
      engine.resumeSession(created.id),
    ]);
    assert.notEqual(rebuilt, created);
    assert.equal(concurrentlyResumed, rebuilt);
    assert.equal(await engine.resumeSession(created.id), rebuilt);

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 经过 ThreadStore 重开后保留 Esc 前的对话与恢复上下文", async () => {
  const dir = tempDir();
  const config = runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
  try {
    let calls = 0;
    const firstStore = new ThreadStore(dir);
    const firstEngine = createEngine({
      config,
      model: new MockLanguageModelV4({
        doStream: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              stream: simulateReadableStream<LanguageModelV4StreamPart>({
                chunks: engineTextStep("步骤 A 已完成"),
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            };
          }
          return {
            stream: simulateReadableStream<LanguageModelV4StreamPart>({
              chunks: engineTextStep("不应完成"),
              initialDelayInMs: 200,
              chunkDelayInMs: null,
            }),
          };
        },
      }),
      store: firstStore,
      sources: [],
      skillLibrary: null,
    });
    const firstSession = await firstEngine.createSession();
    const threadId = firstSession.id;
    await drain(firstSession.send("先完成步骤 A"));
    const cancelledEvents: SessionEvent[] = [];
    for await (const event of firstSession.send("开始步骤 B")) {
      cancelledEvents.push(event);
      if (event.type === "message-start") {
        firstSession.cancel();
      }
    }
    assert.equal(
      cancelledEvents.some((event) => event.type === "turn-cancelled"),
      true,
    );
    await firstEngine.dispose();
    firstStore.close();

    let recoveryPrompt: LanguageModelV4CallOptions["prompt"] = [];
    const reopenedStore = new ThreadStore(dir);
    const reopenedEngine = createEngine({
      config,
      model: textModelCapture((options) => {
        recoveryPrompt = options.prompt;
      }),
      store: reopenedStore,
      sources: [],
      skillLibrary: null,
    });
    const resumed = await reopenedEngine.resumeSession(threadId);
    assert.doesNotMatch(
      JSON.stringify(resumed.getMessages()),
      /cancelledTurnRecovery|Roll interrupted-turn recovery checkpoint/u,
    );
    await drain(resumed.send("继续"));

    const serializedRecoveryPrompt = JSON.stringify(recoveryPrompt);
    assert.match(serializedRecoveryPrompt, /先完成步骤 A|步骤 A 已完成/u);
    assert.match(serializedRecoveryPrompt, /开始步骤 B/u);
    const recoveryCallMessage = recoveryPrompt.find(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (part) =>
            part.type === "tool-call" && part.toolName === "roll__interrupted_turn_recovery",
        ),
    );
    const recoveryToolMessage = recoveryPrompt.find(
      (message) =>
        message.role === "tool" &&
        message.content.some(
          (part) =>
            part.type === "tool-result" && part.toolName === "roll__interrupted_turn_recovery",
        ),
    );
    assert.ok(recoveryCallMessage);
    assert.ok(recoveryToolMessage?.role === "tool");
    const recoveryResult = recoveryToolMessage.content.find(
      (part) => part.type === "tool-result" && part.toolName === "roll__interrupted_turn_recovery",
    );
    assert.ok(recoveryResult && recoveryResult.type === "tool-result");
    assert.equal(recoveryResult.output.type, "text");
    if (recoveryResult.output.type === "text") {
      assert.match(recoveryResult.output.value, /"source":"roll-runtime-tool-ledger"/u);
      assert.match(recoveryResult.output.value, /已完成的步骤和工具记录仍然有效/u);
    }
    assert.doesNotMatch(serializedRecoveryPrompt, /rollHarness|cancelledTurnRecovery/u);

    await reopenedEngine.dispose();
    reopenedStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine dispose 开始后拒绝新的 create 与 resume", async () => {
  const dir = tempDir();
  try {
    const config = runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
    const store = new ThreadStore(dir);
    const engine = createEngine({
      config,
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
    });
    const session = await engine.createSession();

    const disposing = engine.dispose();
    await assert.rejects(engine.createSession(), /ConversationEngine is closing/u);
    await assert.rejects(engine.resumeSession(session.id), /ConversationEngine is closing/u);
    await assert.rejects(engine.getContextSummary(), /ConversationEngine is closing/u);
    await disposing;
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine resolves context window from the model catalog by provider and reports the source", async () => {
  const config = runtimeFixtureConfig({ provider: "openai", modelName: "gpt-5.6-terra" });
  const catalog = new ModelCatalog({
    snapshot: {
      fetchedAt: "2026-09-04T00:00:00.000Z",
      providers: {
        openai: { "gpt-5.6-terra": { context: 1_050_000, input: 922_000 } },
        google: { "gemini-3.8-flash": { context: 1_048_576 } },
      },
    },
  });
  const engine = createEngine({
    config,
    model: new MockLanguageModelV4({ modelId: "gpt-5.6-terra" }),
    sources: [],
    skillLibrary: null,
    modelCatalog: catalog,
  });
  try {
    const session = await engine.createSession();
    assert.equal(session.getContextWindow(), 922_000);

    const switched = switchModel(engine, {
      provider: "google",
      modelName: "gemini-3.8-flash",
      model: new MockLanguageModelV4({ modelId: "gemini-3.8-flash" }),
    });
    assert.deepEqual(switched, { window: 1_048_576, source: "catalog" });
    assert.equal(session.getContextWindow(), 1_048_576);

    const ruled = switchModel(engine, {
      provider: "xai",
      modelName: "grok-4.5",
      model: new MockLanguageModelV4({ modelId: "grok-4.5" }),
    });
    assert.deepEqual(ruled, { window: 500_000, source: "rule" });
  } finally {
    await engine.dispose();
  }
});

test("ConversationEngine threads structured output controls into AgentSession", async () => {
  const config = runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
  const structuredOutputProviderOptions = { alibaba: { enableThinking: false } };
  const engine = createEngine({
    config,
    model: new MockLanguageModelV4({}),
    sources: [],
    skillLibrary: null,
    structuredOutputProviderOptions,
    structuredOutputReasoning: "high",
  });

  const session = await engine.createSession();

  assert.deepEqual(
    Reflect.get(session, "structuredOutputProviderOptions"),
    structuredOutputProviderOptions,
  );
  assert.equal(Reflect.get(session, "structuredOutputReasoning"), "high");
  assert.equal(Reflect.get(session, "compaction").timeoutMs, 120_000);
  assert.equal(Reflect.get(session, "compaction").maxOutputTokens, 8_192);
  await engine.dispose();
});

test("ConversationEngine 将 skillLibrary 目录注入 system prompt 并注册 skill 工具", async () => {
  const config = runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
  const captured: Array<{ readonly role: string; readonly content: unknown }> = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(...options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] } as const,
            { type: "text-start", id: "t" } as const,
            { type: "text-delta", id: "t", delta: "ok" } as const,
            { type: "text-end", id: "t" } as const,
            {
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop", raw: "stop" },
            } as const,
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const engine = createEngine({
    config,
    model,
    sources: [],
    skillLibrary: {
      list: () => [{ name: "demo-skill", description: "演示", source: "user" }],
      load: () => undefined,
      loadReference: () => undefined,
    },
  });

  const session = await engine.createSession();
  const consumed: unknown[] = [];
  for await (const event of session.send("hi")) {
    consumed.push(event);
  }
  assert.ok(consumed.length > 0);

  const system = captured.find((message) => message.role === "system");
  assert.ok(system);
  const content = String(system.content);
  assert.ok(content.includes("# Skills"));
  assert.ok(content.includes("demo-skill"));
  assert.ok(content.includes("roll__skill"));
  await engine.dispose();
});

test("ConversationEngine.getContextSummary 汇总 agent/tool/skill 数量", async () => {
  const config = runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
  const client = { callTool: async () => ({ content: [] }) };
  const engine = createEngine({
    config,
    model: new MockLanguageModelV4({}),
    workspaceInstructions: null,
    sources: [
      {
        agentName: "a",
        client,
        tools: [
          {
            tool: { name: "t1", inputSchema: { type: "object" as const } },
            annotations: undefined,
          },
          {
            tool: { name: "t2", inputSchema: { type: "object" as const } },
            annotations: undefined,
          },
        ],
      },
    ],
    skillLibrary: {
      list: () => [{ name: "s1", description: "d", source: "user" }],
      load: () => undefined,
      loadReference: () => undefined,
    },
  });

  const summary = await engine.getContextSummary();
  assert.deepEqual(summary, { agentCount: 1, toolCount: 2, skillCount: 1 });
  await engine.dispose();
});

const STOP_REASON = { unified: "stop", raw: "stop" } as const;

const TOOL_CALLS_REASON = { unified: "tool-calls", raw: "tool-calls" } as const;

function mockUsage(inputTokens = 1, outputTokens = 1) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
}

function toolThenDoneModel(toolName: string, input: unknown): MockLanguageModelV4 {
  const steps: LanguageModelV4StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName,
        input: JSON.stringify(input),
      },
      { type: "finish", usage: mockUsage(), finishReason: TOOL_CALLS_REASON },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "done" },
      { type: "text-end", id: "t" },
      { type: "finish", usage: mockUsage(), finishReason: STOP_REASON },
    ],
  ];
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function engineTextStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: mockUsage(), finishReason: STOP_REASON },
  ];
}

function engineStreamErrorStep(message: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "error", error: message },
  ];
}

function engineToolCallStep(
  toolCallId: string,
  toolName: string,
  input: unknown,
  inputTokens = 1,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", usage: mockUsage(inputTokens), finishReason: TOOL_CALLS_REASON },
  ];
}

function sequencedEngineModel(steps: readonly LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps.at(-1) ?? [];
      index += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

for (const scenario of ["summarize", "truncate", "empty", "larger"] as const) {
  test(`ConversationEngine Unicode compaction ${scenario} persists and resumes`, async () => {
    const dir = tempDir();
    const config = runtimeFixtureConfig({
      provider: "mock",
      modelName: "default-model",
      settings: {
        compaction: {
          strategy: scenario === "truncate" ? "truncate" : "summarize",
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
    });
    let engine: ConversationEngine | undefined;
    let store: ThreadStore | undefined;
    let summaryCalls = 0;
    const holdsHistory = scenario === "empty" || scenario === "larger";
    try {
      store = new ThreadStore(dir);
      const inference = sequencedEngineModel([engineTextStep("已记录要求")]);
      engine = createEngine({
        config,
        store,
        sources: [],
        skillLibrary: null,
        workspaceInstructions: null,
        model: new MockLanguageModelV4({
          doStream: (options) => inference.doStream(options),
          doGenerate: async (options) => {
            summaryCalls++;
            const source = JSON.stringify(options.prompt);
            assert.ok(source.includes("😀"));
            assert.ok(source.isWellFormed());
            return {
              content: [
                {
                  type: "text",
                  text:
                    scenario === "empty"
                      ? ""
                      : scenario === "larger"
                        ? "更长摘要".repeat(5_000)
                        : "不要发送消息，只整理草稿。保留 Unicode 😀 任务上下文。",
                },
              ],
              finishReason: STOP_REASON,
              usage: mockUsage(),
              warnings: [],
            };
          },
        }),
      });
      const session = await engine.createSession();
      const threadId = session.id;
      const request = `不要发送消息，只整理草稿。${"😀".repeat(2_400)}`;
      await drain(session.send(request));
      await drain(session.send(`${request}继续整理`));
      const transcriptBefore = store.listTranscriptMessages(threadId);
      const events: SessionEvent[] = [];
      for await (const event of session.compact("manual")) events.push(event);
      const errors = events.filter((event) => event.type === "error");
      assert.equal(errors.length, scenario === "empty" ? 1 : 0, JSON.stringify(events));
      const compacted = events.find((event) => event.type === "context-compacted");
      if (scenario === "empty") {
        assert.equal(compacted?.removed, 0);
        assert.equal(compacted?.checkpointId, undefined);
      } else {
        assert.ok(compacted);
        assert.equal(compacted.removed > 0, !holdsHistory, JSON.stringify(events));
        assert.equal(compacted.strategy, scenario === "truncate" ? "truncate" : "summarize");
      }
      assert.equal(summaryCalls, scenario === "truncate" ? 0 : 1);
      const checkpoint = store.getLatestCheckpoint(threadId);
      if (holdsHistory) {
        assert.equal(checkpoint, undefined);
        assert.equal(store.getContextRecovery(threadId), undefined);
        assert.deepEqual(
          store.getMessages(threadId),
          transcriptBefore.map((entry) => entry.message),
        );
      } else {
        assert.ok(checkpoint?.version === 3);
        assert.ok(checkpoint.taskSummary.isWellFormed());
        if (scenario === "summarize") assert.match(checkpoint.taskSummary, /Unicode 😀/u);
        assert.equal(store.getMessages(threadId)[0]?.content, `${request}继续整理`);
      }
      assert.deepEqual(store.listTranscriptMessages(threadId), transcriptBefore);
      await engine.dispose();
      engine = undefined;
      store.close();
      store = new ThreadStore(dir);
      let prompt = "";
      engine = createEngine({
        config,
        store,
        sources: [],
        skillLibrary: null,
        workspaceInstructions: null,
        model: textModelCapture((options) => {
          prompt = JSON.stringify(options.prompt);
        }),
      });
      const resumed = await engine.resumeSession(threadId);
      const resumedEvents: SessionEvent[] = [];
      for await (const event of resumed.send("继续")) resumedEvents.push(event);
      assert.deepEqual(
        resumedEvents.filter((event) => event.type === "error"),
        [],
      );
      assert.equal(resumedEvents.at(-1)?.type, "message-finish");
      assert.match(prompt, /不要发送消息/u);
      assert.deepEqual(store.getLatestCheckpoint(threadId), checkpoint);
    } finally {
      await engine?.dispose();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const strategy of ["truncate", "summarize"] as const) {
  test(`ConversationEngine 较早长轮分批 ${strategy} 后 SQLite 恢复保留证据且不重放`, async () => {
    const dir = tempDir();
    let store: ThreadStore | undefined;
    let engine: ConversationEngine | undefined;
    try {
      const config = runtimeFixtureConfig({
        provider: "mock",
        modelName: "default-model",
        settings: {
          contextWindow: 100_000,
          compaction: { strategy, keepRecentTurns: 1, keepRecentTokens: 1 },
        },
      });
      store = new ThreadStore(dir);
      const threadId = store.createThread();
      const messages: ModelMessage[] = [{ role: "user", content: "只检查文件，不要发送消息" }];
      const records = Array.from({ length: 20 }, (_, step) =>
        createToolExecutionRecord({
          toolCallId: `done-${String(step)}`,
          agentName: "probe",
          toolName: "inspect",
          input: { script: "x".repeat(14_000) },
          result: successfulToolResult("already inspected"),
        }),
      );
      for (const record of records) {
        store.appendToolExecution(threadId, record);
        messages.push(
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: record.toolCallId,
                toolName: "probe__inspect",
                input: { script: "x".repeat(14_000) },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: record.toolCallId,
                toolName: "probe__inspect",
                output: { type: "text", value: "already inspected" },
              },
            ],
          },
        );
      }
      messages.push(
        { role: "assistant", content: "done" },
        { role: "user", content: "继续检查" },
        { role: "assistant", content: "ok" },
      );
      store.appendMessages(threadId, messages, {
        toolExecutionCoverage: {
          executionIds: records.map((record) => record.id),
          representation: "raw_transcript",
        },
      });
      const transcriptBefore = store.listTranscriptMessages(threadId);
      const executionsBefore = store.listToolExecutions(threadId);
      let toolCalls = 0;
      const sources: readonly AgentToolSource[] = [
        {
          agentName: "probe",
          client: {
            callTool: async () => {
              toolCalls += 1;
              return { content: [{ type: "text", text: "unexpected replay" }] };
            },
          },
          tools: [
            {
              tool: { name: "inspect", inputSchema: { type: "object" as const } },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ];
      const model = new MockLanguageModelV4({
        doGenerate: async (options) => {
          assert.match(JSON.stringify(options.prompt), /already inspected/u);
          return {
            content: [
              {
                type: "text",
                text: "只检查文件，不要发送消息。较早的文件检查已完成，不要重放已完成工具调用。",
              },
            ],
            finishReason: STOP_REASON,
            usage: mockUsage(),
            warnings: [],
          };
        },
      });
      engine = createEngine({
        config,
        model,
        store,
        sources,
        skillLibrary: null,
        workspaceInstructions: null,
      });
      const session = await engine.resumeSession(threadId);
      for (let pass = 0; pass < 2; pass += 1) {
        const events: SessionEvent[] = [];
        for await (const event of session.compact("manual")) events.push(event);
        assert.deepEqual(
          events.filter((event) => event.type === "error"),
          [],
        );
        const compacted = events.find((event) => event.type === "context-compacted");
        assert.ok(compacted, JSON.stringify(events));
        if (pass > 0 && compacted.checkpointGeneration === undefined) break;
        assert.equal(compacted.checkpointGeneration, pass + 1);
        assert.equal(compacted.strategy, strategy);
        if (strategy === "summarize") {
          assert.equal(compacted.checkpointSummaryStatus, "valid");
        }
        assert.equal(store.getContextRecovery(threadId), undefined);
        assert.deepEqual(store.getMessages(threadId), session.getMessages());
        assert.deepEqual(store.listTranscriptMessages(threadId), transcriptBefore);
        assert.deepEqual(store.listToolExecutions(threadId), executionsBefore);
      }
      const activeBefore = store.getMessages(threadId);
      const checkpointBefore = store.getLatestCheckpoint(threadId);
      assert.ok(checkpointBefore?.version === 3);
      if (strategy === "summarize") assert.match(checkpointBefore.taskSummary, /不要发送消息/u);
      assert.equal(checkpointBefore.toolState.countsByOutcome.success, 20);
      assert.equal(model.doStreamCalls.length, 0);
      await engine.dispose();
      engine = undefined;
      store.close();
      store = new ThreadStore(dir);
      assert.deepEqual(store.getMessages(threadId), activeBefore);
      assert.deepEqual(store.getLatestCheckpoint(threadId), checkpointBefore);
      assert.deepEqual(store.listTranscriptMessages(threadId), transcriptBefore);
      const prompts: LanguageModelV4CallOptions[] = [];
      const resumedModel = textModelCapture((options) => prompts.push(options));
      engine = createEngine({
        config,
        model: new MockLanguageModelV4({
          doGenerate: (options) => model.doGenerate(options),
          doStream: (options) => resumedModel.doStream(options),
        }),
        store,
        sources,
        skillLibrary: null,
        workspaceInstructions: null,
      });
      const resumed = await engine.resumeSession(threadId);
      assert.deepEqual(resumed.getMessages(), activeBefore);
      const events: SessionEvent[] = [];
      for await (const event of resumed.send("继续")) events.push(event);
      assert.deepEqual(
        events.filter((event) => event.type === "error"),
        [],
      );
      assert.equal(events.at(-1)?.type, "message-finish");
      assert.equal(prompts.length, 1);
      assertVisibleOrRecoverable(
        store,
        threadId,
        JSON.stringify(prompts[0]?.prompt),
        "不要发送消息",
      );
      assert.equal(toolCalls, 0);
      assert.deepEqual(store.listToolExecutions(threadId), executionsBefore);
    } finally {
      await engine?.dispose();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function textModelCapture(capture: (options: LanguageModelV4CallOptions) => void) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      capture(options);
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "resumed" },
            { type: "text-end", id: "t" },
            { type: "finish", usage: mockUsage(), finishReason: STOP_REASON },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

test("ConversationEngine context overflow 重放后仅持久化一组当前 Turn", async () => {
  const dir = tempDir();
  try {
    const config = runtimeFixtureConfig({
      provider: "mock",
      modelName: "default-model",
      settings: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
    });
    let modelCalls = 0;
    const steps = [
      engineStreamErrorStep("context_length_exceeded: prompt is too long"),
      engineTextStep("overflow recovered exactly once"),
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
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: "older turn" },
      { role: "assistant", content: "older answer".repeat(2000) },
      { role: "user", content: "recent turn" },
      { role: "assistant", content: "recent answer" },
    ]);
    const engine = createEngine({
      config,
      model,
      store,
      sources: [],
      skillLibrary: null,
    });

    const session = await engine.resumeSession(threadId);
    const events: SessionEvent[] = [];
    for await (const event of session.send("overflow current turn")) {
      events.push(event);
    }

    assert.equal(modelCalls, 2);
    assert.equal(events.filter((event) => event.type === "message-start").length, 1);
    assert.equal(events.filter((event) => event.type === "context-compacted").length, 1);
    assert.equal(events.filter((event) => event.type === "message-finish").length, 1);
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );

    const activeMessages = store.getMessages(threadId);
    assert.equal(
      activeMessages.filter(
        (message) => message.role === "user" && message.content === "overflow current turn",
      ).length,
      1,
    );
    assert.equal(
      activeMessages.filter(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.content).includes("overflow recovered exactly once"),
      ).length,
      1,
    );
    const transcript = store.listTranscriptMessages(threadId);
    assert.equal(
      transcript.filter(
        (entry) =>
          entry.message.role === "user" && entry.message.content === "overflow current turn",
      ).length,
      1,
    );
    assert.equal(
      transcript.filter(
        (entry) =>
          entry.message.role === "assistant" &&
          JSON.stringify(entry.message.content).includes("overflow recovered exactly once"),
      ).length,
      1,
    );

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 将 ToolExecutionRecord 持久化并可跨进程恢复", async () => {
  const dir = tempDir();
  try {
    const config = runtimeFixtureConfig({
      provider: "mock",
      modelName: "default-model",
      settings: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
    });
    const store = new ThreadStore(dir);
    const engine = createEngine({
      config,
      model: toolThenDoneModel("probe__inspect", { path: "secret.txt" }),
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => ({
              content: [{ type: "text", text: "ok" }],
              structuredContent: { inspected: true },
              _meta: { trace: "kept-in-raw-ledger" },
            }),
          },
          resourceBaseDir: process.cwd(),
          tools: [
            {
              tool: {
                name: "inspect",
                inputSchema: {
                  type: "object" as const,
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
              annotations: { readOnlyHint: true },
              resourceHints: [{ field: "path", kind: "file" }],
            },
          ],
        },
      ],
      skillLibrary: null,
    });

    const session = await engine.createSession();
    // Drain the full Tool loop so the ledger write and assistant response both settle.
    await drain(session.send(`inspect ${"historical detail ".repeat(1_000)}`));
    const [record] = store.listToolExecutions(session.id);
    assert.equal(record?.outcome.kind, "success");
    assert.deepEqual(record?.input.value, { path: "secret.txt" });
    const persistedRecordJson = JSON.stringify(record);
    assert.doesNotMatch(persistedRecordJson, /kept-in-raw-ledger/u);
    assert.match(persistedRecordJson, /\[redacted\]/u);
    assert.equal(record?.persistence?.version, 1);
    assert.equal(record?.persistence?.fields.raw.redactionApplied, true);
    assert.match(JSON.stringify(record?.model), /ok/u);
    assert.match(JSON.stringify(record?.display), /ok/u);

    // Add a second completed turn so manual compaction has an older prefix to archive.
    await drain(session.send("second turn"));
    // Drain the atomic checkpoint commit.
    await drain(session.compact("manual"));
    const checkpoint = store.getLatestCheckpoint(session.id);
    assert.ok(checkpoint);
    assert.ok(checkpoint.toolState.recentRecords.some((entry) => entry.executionId === record?.id));
    assert.equal(checkpoint.toolState.countsByOutcome.success, 1);
    assert.deepEqual(checkpoint.toolState.anomalies, []);
    assert.equal(checkpoint.toolState.integrityStatus, "valid");

    await engine.dispose();
    store.close();
    const reopened = new ThreadStore(dir);
    assert.equal(reopened.listToolExecutions(session.id)[0]?.id, record?.id);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine ledger 已提交但 transcript 失败时在下一次推理前原子恢复并 fail closed", async () => {
  const dir = tempDir();
  let database: DatabaseSync | undefined;
  let store: ThreadStore | undefined;
  let engine: ConversationEngine | undefined;
  try {
    const config = installEngineConfig();
    const prompts: LanguageModelV4CallOptions[] = [];
    const steps = [
      engineToolCallStep("c1", "probe__write", { q: "once" }),
      engineTextStep("first turn would finish"),
      engineTextStep("recovered safely"),
    ];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options);
        const chunks = steps[prompts.length - 1] ?? steps.at(-1) ?? [];
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    let toolCalls = 0;
    store = new ThreadStore(dir);
    engine = createEngine({
      config,
      model,
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => {
              toolCalls += 1;
              return { content: [{ type: "text", text: "side-effect-complete" }] };
            },
          },
          tools: [
            {
              tool: {
                name: "write",
                inputSchema: {
                  type: "object" as const,
                  properties: { q: { type: "string" } },
                  required: ["q"],
                },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });
    const session = await engine.createSession();
    database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_turn_transcript
      BEFORE INSERT ON transcript_messages
      WHEN NEW.role <> 'user'
      BEGIN
        SELECT RAISE(ABORT, 'simulated transcript commit failure');
      END;
    `);

    const failedEvents: SessionEvent[] = [];
    for await (const event of session.send("write once")) {
      failedEvents.push(event);
    }
    assert.equal(failedEvents.at(-1)?.type, "error");
    assert.equal(toolCalls, 1);
    assert.equal(prompts.length, 2);
    assert.equal(store.listUncoveredToolExecutions(session.id).length, 1);
    assert.deepEqual(store.getMessages(session.id), [{ role: "user", content: "write once" }]);

    const blockedEvents: SessionEvent[] = [];
    for await (const event of session.send("continue while storage is broken")) {
      blockedEvents.push(event);
    }
    assert.equal(blockedEvents.at(-1)?.type, "error");
    assert.match(
      blockedEvents.find((event) => event.type === "error")?.message ?? "",
      /工具执行恢复状态持久化失败/u,
    );
    assert.equal(prompts.length, 2, "recovery persistence failure must block the provider");
    assert.equal(toolCalls, 1);
    assert.equal(store.listUncoveredToolExecutions(session.id).length, 1);

    database.exec("DROP TRIGGER reject_turn_transcript;");
    const recoveredEvents: SessionEvent[] = [];
    for await (const event of session.send("continue after storage recovery")) {
      recoveredEvents.push(event);
    }
    assert.equal(recoveredEvents.at(-1)?.type, "message-finish");
    assert.equal(prompts.length, 3);
    assert.equal(toolCalls, 1);
    assert.deepEqual(store.listUncoveredToolExecutions(session.id), []);
    const recoveredPrompt = JSON.stringify(prompts.at(-1)?.prompt);
    assert.match(recoveredPrompt, /roll__interrupted_turn_recovery/u);
    assert.match(recoveredPrompt, /side-effect-complete/u);
    assert.match(recoveredPrompt, /outcome.*kind.*success/u);

    await engine.dispose();
    engine = undefined;
    store.close();
    store = undefined;
  } finally {
    await engine?.dispose();
    store?.close();
    database?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 续跑 segment 提交失败时只恢复新 execution,不重复已覆盖步骤", async () => {
  const dir = tempDir();
  let database: DatabaseSync | undefined;
  let store: ThreadStore | undefined;
  let engine: ConversationEngine | undefined;
  try {
    const baseConfig = installEngineConfig();
    const config = {
      ...baseConfig,
      settings: {
        ...baseConfig.settings,
        contextWindow: 20_000, // Engine includes file/schema overhead; measured 16k drives pause.
        compaction: {
          ...baseConfig.settings.compaction,
          enabled: true,
          strategy: "truncate" as const,
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
    };
    const prompts: LanguageModelV4CallOptions[] = [];
    const steps = [
      engineToolCallStep("c1", "probe__write", { q: "first" }, 16_000),
      engineToolCallStep("c2", "probe__write", { q: "second" }),
      engineTextStep("continuation done"),
      engineTextStep("after recovery"),
    ];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options);
        const chunks = steps[prompts.length - 1] ?? steps.at(-1) ?? [];
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks,
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    let toolCalls = 0;
    store = new ThreadStore(dir);
    const threadId = store.createThread({ model: "default-model" });
    store.appendMessages(threadId, [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ]);
    engine = createEngine({
      config,
      model,
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => {
              toolCalls += 1;
              return { content: [{ type: "text", text: `result-${String(toolCalls)}` }] };
            },
          },
          tools: [
            {
              tool: {
                name: "write",
                inputSchema: {
                  type: "object" as const,
                  properties: { q: { type: "string" } },
                  required: ["q"],
                },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });
    const session = await engine.resumeSession(threadId);
    database = new DatabaseSync(join(dir, "threads.db"));
    database.exec(`
      CREATE TRIGGER reject_c2_transcript
      BEFORE INSERT ON transcript_messages
      WHEN NEW.message_json LIKE '%"toolCallId":"c2"%'
      BEGIN
        SELECT RAISE(ABORT, 'simulated continuation transcript failure');
      END;
    `);

    const failedEvents: SessionEvent[] = [];
    for await (const event of session.send("tool loop")) {
      failedEvents.push(event);
    }
    assert.equal(failedEvents.at(-1)?.type, "error");
    assert.equal(toolCalls, 2);
    assert.equal(prompts.length, 3);
    const ledger = store.listToolExecutions(threadId);
    assert.deepEqual(
      ledger.map((record) => record.toolCallId),
      ["c1", "c2"],
    );
    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((record) => record.id),
      [ledger[1]?.id],
    );

    const recoveredEvents: SessionEvent[] = [];
    for await (const event of session.send("continue safely")) {
      recoveredEvents.push(event);
    }
    assert.equal(recoveredEvents.at(-1)?.type, "message-finish");
    assert.equal(toolCalls, 2);
    assert.equal(prompts.length, 4);
    assert.deepEqual(store.listUncoveredToolExecutions(threadId), []);
    const recoveredPrompt = JSON.stringify(prompts.at(-1)?.prompt);
    assert.match(recoveredPrompt, /result-2/u);
    assert.match(recoveredPrompt, /roll__interrupted_turn_recovery/u);
    assert.equal(recoveredPrompt.match(/result-2/gu)?.length ?? 0, 1);

    await engine.dispose();
    engine = undefined;
    store.close();
    store = undefined;
  } finally {
    await engine?.dispose();
    store?.close();
    database?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 重启恢复仅投影未覆盖的 exact execution 且连续 resume 幂等", async () => {
  const dir = tempDir();
  let engine: ConversationEngine | undefined;
  let store: ThreadStore | undefined;
  try {
    const config = installEngineConfig();
    store = new ThreadStore(dir);
    const threadId = store.createThread({ model: "default-model" });
    const first = createToolExecutionRecord({
      id: "0905d35a-78a7-4485-9abc-d60c744c2a38",
      toolCallId: "shared-call",
      agentName: "probe",
      toolName: "write",
      input: { q: "first" },
      result: successfulToolResult("first-result"),
    });
    const second = createToolExecutionRecord({
      id: "51c5ef8f-cb7c-4dd6-ab87-90d029022bc0",
      toolCallId: "shared-call",
      agentName: "probe",
      toolName: "write",
      input: { q: "second" },
      result: successfulToolResult("second-result"),
    });
    store.appendToolExecution(threadId, first);
    store.appendMessages(threadId, [{ role: "assistant", content: "first already covered" }], {
      toolExecutionCoverage: {
        executionIds: [first.id],
        representation: "recovery_evidence",
      },
    });
    store.appendToolExecution(threadId, second);
    assert.deepEqual(
      store.listUncoveredToolExecutions(threadId).map((record) => record.id),
      [second.id],
    );
    store.close();
    store = undefined;

    const prompts: LanguageModelV4CallOptions[] = [];
    store = new ThreadStore(dir);
    engine = createEngine({
      config,
      store,
      model: textModelCapture((options) => prompts.push(options)),
      sources: [],
      skillLibrary: null,
    });
    const resumed = await engine.resumeSession(threadId);
    assert.deepEqual(store.listUncoveredToolExecutions(threadId), []);
    const recoveredBeforeInference = JSON.stringify(store.getMessages(threadId));
    assert.equal(recoveredBeforeInference.match(/cancelledTurnRecovery/gu)?.length ?? 0, 1);
    await drain(resumed.send("continue"));
    const prompt = JSON.stringify(prompts.at(-1)?.prompt);
    assert.match(prompt, /second-result/u);
    assert.doesNotMatch(prompt, /first-result/u);
    await engine.dispose();
    engine = undefined;
    store.close();
    store = undefined;

    store = new ThreadStore(dir);
    engine = createEngine({
      config,
      store,
      model: textModelCapture(() => {}),
      sources: [],
      skillLibrary: null,
    });
    await engine.resumeSession(threadId);
    assert.deepEqual(store.listUncoveredToolExecutions(threadId), []);
    assert.equal(
      JSON.stringify(store.getMessages(threadId)).match(/cancelledTurnRecovery/gu)?.length ?? 0,
      1,
    );
    await engine.dispose();
    engine = undefined;
    store.close();
    store = undefined;
  } finally {
    await engine?.dispose();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 原子提交 checkpoint，并在 resume 时注入受控 transcript 入口", async () => {
  const dir = tempDir();
  try {
    const config = runtimeFixtureConfig({
      provider: "mock",
      modelName: "default-model",
      settings: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
    });
    const store = new ThreadStore(dir);
    const threadId = store.createThread();
    store.appendMessages(threadId, [
      { role: "user", content: "old-goal" },
      { role: "assistant", content: "old-answer".repeat(1000) },
      { role: "user", content: "current-goal" },
      { role: "assistant", content: "current-answer" },
    ]);
    let capturedPrompt = "";
    const engine = createEngine({
      config,
      model: textModelCapture((options) => {
        capturedPrompt = JSON.stringify(options.prompt);
      }),
      store,
      sources: [],
      skillLibrary: null,
      workspaceInstructions: null,
    });

    const session = await engine.resumeSession(threadId);
    const compactedEvents: SessionEvent[] = [];
    for await (const event of session.compact("manual")) {
      compactedEvents.push(event);
    }
    const checkpoint = store.getLatestCheckpoint(threadId);
    assert.ok(checkpoint);
    assert.equal(checkpoint.version, 3);
    assert.ok(checkpoint.version === 3 && checkpoint.taskSummary.length > 0);
    assert.equal(checkpoint.transcript.completeness, "complete");
    assert.deepEqual(checkpoint.transcript.messages, {
      fromSequenceExclusive: -1,
      throughSequence: 3,
    });
    assert.deepEqual(checkpoint.transcript.toolExecutions, {
      fromSequenceExclusive: -1,
      throughSequence: -1,
    });
    assert.equal(store.getSemanticLedgerRows(threadId).length, 0);
    assert.deepEqual(store.getMessages(threadId), [
      { role: "user", content: "current-goal" },
      { role: "assistant", content: "current-answer" },
    ]);
    const compacted = compactedEvents.find((event) => event.type === "context-compacted");
    assert.ok(compacted && compacted.type === "context-compacted");
    assert.equal(compacted.checkpointId, checkpoint.id);
    assert.equal(compacted.checkpointGeneration, 1);
    assert.equal(compacted.checkpointSummaryStatus, "skipped");
    assert.ok(
      session.getCapabilityManifest().tools.some((tool) => tool.role === "transcript-read"),
    );
    assert.equal(
      store.readCheckpointTranscript(threadId, {
        checkpointId: checkpoint.id,
        kind: "message",
        limit: 1,
      }).entries[0]?.sequence,
      0,
    );

    await session.close();
    const resumed = await engine.resumeSession(threadId);
    // Drain the turn so the model call captures the reconstructed reminder.
    await drain(resumed.send("continue"));
    assert.match(capturedPrompt, new RegExp(checkpoint.id, "u"));
    assert.match(capturedPrompt, /roll__transcript/u);
    assert.match(capturedPrompt, /Earlier messages were archived/u);
    assert.doesNotMatch(capturedPrompt, /roll__context/u);

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 连续压缩记录近期 typed Tool state 并保留完整执行账本", async () => {
  const dir = tempDir();
  try {
    const config = runtimeFixtureConfig({
      provider: "mock",
      modelName: "default-model",
      settings: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
    });
    const store = new ThreadStore(dir);
    const model = sequencedEngineModel([
      engineToolCallStep("call-first", "probe__inspect", { value: "first" }),
      engineTextStep("first done".repeat(1000)),
      engineTextStep("first checkpoint boundary"),
      engineToolCallStep("call-second", "probe__inspect", { value: "second" }),
      engineTextStep("second done".repeat(1000)),
      engineTextStep("second checkpoint boundary"),
    ]);
    const engine = createEngine({
      config,
      model,
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => ({ content: [{ type: "text", text: "inspected" }] }),
          },
          tools: [
            {
              tool: {
                name: "inspect",
                inputSchema: {
                  type: "object" as const,
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });

    const session = await engine.createSession();
    await drain(session.send("inspect first"));
    await drain(session.send("checkpoint one"));
    await drain(session.compact("manual"));
    const first = store.getLatestCheckpoint(session.id);
    assert.ok(first);
    assert.equal(first.generation, 1);
    assert.equal(first.toolState.countsByOutcome.success, 1);
    assert.equal(first.toolState.integrityStatus, "valid");

    await drain(session.send("inspect second"));
    await drain(session.send("checkpoint two"));
    await drain(session.compact("manual"));
    const second = store.getLatestCheckpoint(session.id);
    assert.ok(second);
    assert.equal(second.generation, 2);
    assert.equal(second.previousCheckpointId, first.id);
    assert.equal(second.toolState.countsByOutcome.success, 1);
    assert.deepEqual(
      second.toolState.recentRecords.map((record) => record.toolCallId),
      ["call-second"],
    );
    assert.deepEqual(
      store.listToolExecutions(session.id).map((record) => record.toolCallId),
      ["call-first", "call-second"],
    );
    assert.deepEqual(store.getCheckpoint(session.id, first.id), first);
    assert.deepEqual(second.toolState.anomalies, []);

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 压缩旧工具轮次后仍可经 checkpoint transcript 回查原证据", async () => {
  const dir = tempDir();
  try {
    const evidenceMarker = "ORIGINAL_TOOL_EVIDENCE_20260717";
    const config = runtimeFixtureConfig({
      provider: "mock",
      modelName: "default-model",
      settings: {
        compaction: {
          enabled: true,
          strategy: "truncate",
          threshold: 0.75,
          keepRecentTurns: 1,
          keepRecentTokens: 1,
        },
      },
    });
    const store = new ThreadStore(dir);
    const engine = createEngine({
      config,
      model: sequencedEngineModel([
        engineToolCallStep("call-large", "probe__large", {}),
        engineTextStep("large result observed"),
        engineTextStep("current boundary"),
      ]),
      store,
      sources: [
        {
          agentName: "probe",
          client: {
            callTool: async () => ({
              content: [{ type: "text", text: `${evidenceMarker}:${"x".repeat(6_000)}` }],
            }),
          },
          tools: [
            {
              tool: { name: "large", inputSchema: { type: "object" as const } },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      skillLibrary: null,
    });

    const session = await engine.createSession();
    await drain(session.send("read large result"));
    await drain(session.send("continue with a new step"));
    const compactEvents: SessionEvent[] = [];
    for await (const event of session.compact("manual")) {
      compactEvents.push(event);
    }
    const checkpoint = store.getLatestCheckpoint(session.id);
    assert.ok(checkpoint);
    const compacted = compactEvents.find((event) => event.type === "context-compacted");
    assert.ok(compacted && compacted.type === "context-compacted");
    assert.equal(compacted.truncatedTools, undefined);
    assert.ok(compacted.removed > 0);
    assert.doesNotMatch(
      JSON.stringify(store.getMessages(session.id)),
      new RegExp(evidenceMarker, "u"),
    );

    const recovered = executeTranscriptTool(
      (options) => store.readCheckpointTranscript(session.id, options),
      { checkpointId: checkpoint.id, kind: "message", limit: 10 },
    );
    assert.equal(recovered.outcome.kind, "success");
    assert.match(JSON.stringify(recovered.raw), new RegExp(evidenceMarker, "u"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 每 Turn 刷新 VCS context，而不重建稳定 capability manifest", async () => {
  const config = runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
  const prompts: string[] = [];
  let inspection = 0;
  let rulesResolution = 0;
  const engine = createEngine({
    config,
    model: textModelCapture((options) => prompts.push(JSON.stringify(options.prompt))),
    sources: [],
    skillLibrary: null,
    resolveDynamicCapabilityContext: (abortSignal) => {
      assert.equal(abortSignal.aborted, false);
      rulesResolution += 1;
      return { ruleIds: [`workspace/rules-v${String(rulesResolution)}`] };
    },
    inspectVcsContext: () => {
      inspection += 1;
      return inspection === 1
        ? { branch: "main", dirty: false }
        : { branch: "feature/checkpoint", dirty: true, ahead: 1 };
    },
  });

  const session = await engine.createSession();
  const stableManifest = JSON.stringify(session.getCapabilityManifest());
  await drain(session.send("first"));
  const first = session.getCapabilityTurnContext();
  await drain(session.send("second"));
  const second = session.getCapabilityTurnContext();

  assert.deepEqual(first?.dynamic.vcs, { branch: "main", dirty: false });
  assert.deepEqual(first?.dynamic.ruleIds, ["workspace/rules-v1"]);
  assert.deepEqual(second?.dynamic.vcs, {
    branch: "feature/checkpoint",
    dirty: true,
    ahead: 1,
  });
  assert.deepEqual(second?.dynamic.ruleIds, ["workspace/rules-v2"]);
  assert.equal(JSON.stringify(session.getCapabilityManifest()), stableManifest);
  assert.match(prompts[0] ?? "", /vcs=main;dirty=false/u);
  assert.match(prompts[0] ?? "", /ruleIds=workspace\/rules-v1/u);
  assert.match(prompts[1] ?? "", /vcs=feature\/checkpoint;dirty=true/u);
  assert.match(prompts[1] ?? "", /ruleIds=workspace\/rules-v2/u);

  await engine.dispose();
});

function bashEngineConfig(autoApproveSafe: boolean) {
  return runtimeFixtureConfig({
    provider: "mock",
    modelName: "default-model",
    settings: { shell: { enabled: true, autoApproveSafe } },
  });
}

test(
  "autoApproveSafe=true 注入 ruleBasedClassifier：known-safe 命令免确认执行",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      const engine = createEngine({
        config: bashEngineConfig(true),
        model: toolThenDoneModel("roll__bash", { command: "pwd" }),
        sources: [],
        skillLibrary: null,
        policy: new DefaultToolPolicy(),
      });
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("看下当前目录")) {
        events.push(event);
      }
      assert.ok(!events.some((event) => event.type === "confirmation-required"));
      const result = events.find((event) => event.type === "tool-result");
      assert.ok(result && result.type === "tool-result");
      assert.equal(result.isError, false);
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "autoApproveSafe=false 回归 unknownCommandClassifier：同一命令仍需确认",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      const engine = createEngine({
        config: bashEngineConfig(false),
        model: toolThenDoneModel("roll__bash", { command: "pwd" }),
        sources: [],
        skillLibrary: null,
        policy: new DefaultToolPolicy(),
      });
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("看下当前目录")) {
        events.push(event);
        if (event.type === "confirmation-required") {
          session.reject(event.approvalId);
        }
      }
      assert.ok(events.some((event) => event.type === "confirmation-required"));
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("supportsSafeCommandClassification=false 的 profile 谎报 known-safe 也仍逐条确认", async () => {
  const dir = tempDir();
  try {
    const engine = createEngine({
      config: bashEngineConfig(true),
      model: toolThenDoneModel("roll__powershell", { command: "Get-Location" }),
      sources: [],
      skillLibrary: null,
      policy: new DefaultToolPolicy(),
      shellProfile: { ...powershellProfile, classify: () => "known-safe" },
    });
    const session = await engine.createSession();
    const events = [];
    for await (const event of session.send("看下当前目录")) {
      events.push(event);
      if (event.type === "confirmation-required") {
        session.reject(event.approvalId);
      }
    }
    assert.ok(events.some((event) => event.type === "confirmation-required"));
    session.abort();
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function toolCapturingModel(capture: (names: string) => void): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (opts) => {
      capture(JSON.stringify(opts.tools ?? []));
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            { type: "finish", usage: mockUsage(), finishReason: STOP_REASON },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function sessionExecConfig(autoApproveSafe = true) {
  return runtimeFixtureConfig({
    provider: "mock",
    modelName: "default-model",
    settings: { shell: { enabled: true, autoApproveSafe, session: { enabled: true } } },
  });
}

test(
  "session exec 默认沿用 profile classifier：create/resume 的 known-safe 命令均免确认",
  { skip: process.platform === "win32" },
  async () => {
    for (const lifecycle of ["create", "resume"] as const) {
      const dir = tempDir();
      const store = lifecycle === "resume" ? new ThreadStore(join(dir, "threads")) : undefined;
      const engine = createEngine({
        config: sessionExecConfig(),
        model: toolThenDoneModel("roll__exec_command", {
          command: "pwd",
          yield_time_ms: 250,
        }),
        sources: [],
        skillLibrary: null,
        policy: new DefaultToolPolicy(),
        ...(store ? { store } : {}),
      });
      try {
        let session;
        if (lifecycle === "create") {
          session = await engine.createSession();
        } else {
          assert.ok(store);
          session = await engine.resumeSession(store.createThread({ model: "default-model" }));
        }
        const events = [];
        for await (const event of session.send("看下当前目录")) {
          events.push(event);
        }
        assert.ok(
          !events.some((event) => event.type === "confirmation-required"),
          `${lifecycle} 不应要求确认`,
        );
        const result = events.find((event) => event.type === "tool-result");
        assert.ok(result && result.type === "tool-result");
        assert.equal(result.isError, false);
        session.abort();
      } finally {
        await engine.dispose();
        store?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

test(
  "session exec 关闭 autoApproveSafe 后 known-safe 命令仍需确认",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    const engine = createEngine({
      config: sessionExecConfig(false),
      model: toolThenDoneModel("roll__exec_command", {
        command: "pwd",
        yield_time_ms: 250,
      }),
      sources: [],
      skillLibrary: null,
      policy: new DefaultToolPolicy(),
    });
    try {
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("看下当前目录")) {
        events.push(event);
        if (event.type === "confirmation-required") {
          session.reject(event.approvalId);
        }
      }
      assert.ok(events.some((event) => event.type === "confirmation-required"));
      session.abort();
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "sessionExecEnabled=false（单轮模式）不注册 exec 工具，bash 仍在（P2）",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      let tools = "";
      const engine = createEngine({
        config: sessionExecConfig(),
        model: toolCapturingModel((names) => {
          tools = names;
        }),
        sources: [],
        skillLibrary: null,
        sessionExecEnabled: false,
      });
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("hi")) {
        events.push(event);
      }
      assert.ok(events.length > 0);
      assert.ok(tools.includes("roll__bash"));
      assert.ok(!tools.includes("roll__exec_command"));
      assert.ok(!tools.includes("roll__exec_poll"));
      assert.ok(!tools.includes("roll__exec_list"));
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "默认（长驻模式）session.enabled 时注册 exec 工具（P2 对照）",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tempDir();
    try {
      let tools = "";
      const engine = createEngine({
        config: sessionExecConfig(),
        model: toolCapturingModel((names) => {
          tools = names;
        }),
        sources: [],
        skillLibrary: null,
      });
      const session = await engine.createSession();
      const events = [];
      for await (const event of session.send("hi")) {
        events.push(event);
      }
      assert.ok(events.length > 0);
      assert.ok(tools.includes("roll__exec_command"));
      assert.ok(tools.includes("roll__exec_poll"));
      assert.ok(tools.includes("roll__exec_list"));
      session.abort();
      await engine.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("PowerShell profile 注册 roll__powershell 与 session exec", async () => {
  const dir = tempDir();
  try {
    let tools = "";
    const engine = createEngine({
      config: sessionExecConfig(),
      model: toolCapturingModel((names) => {
        tools = names;
      }),
      sources: [],
      skillLibrary: null,
      shellProfile: powershellProfile,
    });
    const session = await engine.createSession();
    const events = [];
    for await (const event of session.send("hi")) {
      events.push(event);
    }
    assert.ok(events.length > 0);
    assert.ok(tools.includes("roll__powershell"));
    assert.ok(!tools.includes("roll__bash"));
    assert.ok(tools.includes("roll__exec_command"));
    assert.ok(tools.includes("roll__exec_poll"));
    assert.ok(tools.includes("roll__exec_list"));
    session.abort();
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行期 shell profile 探测在 engine 实例内缓存", async () => {
  const dir = tempDir();
  try {
    let calls = 0;
    const engine = createEngine({
      config: sessionExecConfig(),
      model: toolCapturingModel(() => {}),
      sources: [],
      skillLibrary: null,
      resolveShellProfileFn: () => {
        calls += 1;
        return { supported: true, profile: powershellProfile };
      },
    });
    const first = await engine.createSession();
    const second = await engine.createSession();
    assert.ok(first.id !== second.id);
    assert.equal(calls, 1);
    first.abort();
    second.abort();
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine 使用隔离的 Chat shell 环境且不读取后续全局变更", async () => {
  const dir = tempDir();
  const shellEnv: NodeJS.ProcessEnv = {
    PATH: "/tmp/current-roll:/usr/bin",
    ROLL_CURRENT_CLI: "/tmp/current-roll/roll",
  };
  let observedEnv: Readonly<Record<string, string | undefined>> | undefined;
  try {
    const engine = createEngine({
      config: sessionExecConfig(),
      model: toolCapturingModel(() => {}),
      sources: [],
      skillLibrary: null,
      shellEnv,
      resolveShellProfileFn: ({ env }) => {
        observedEnv = env;
        return { supported: true, profile: powershellProfile };
      },
    });
    shellEnv.PATH = "/mutated-after-construction";

    const session = await engine.createSession();

    assert.equal(observedEnv?.PATH, "/tmp/current-roll:/usr/bin");
    assert.equal(observedEnv?.ROLL_CURRENT_CLI, "/tmp/current-roll/roll");
    assert.notEqual(observedEnv, shellEnv);
    session.abort();
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "不支持的 PowerShell profile 只告警一次且不注册 shell 工具",
  { concurrency: false },
  async () => {
    const dir = tempDir();
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let engine: ConversationEngine | undefined;
    try {
      let calls = 0;
      const toolSnapshots: string[] = [];
      engine = createEngine({
        config: sessionExecConfig(),
        model: toolCapturingModel((names) => {
          toolSnapshots.push(names);
        }),
        sources: [],
        skillLibrary: null,
        resolveShellProfileFn: () => {
          calls += 1;
          return { supported: false, reason: "pwsh-not-found" };
        },
      });
      const first = await engine.createSession();
      const second = await engine.createSession();
      const events = [];
      for (const session of [first, second]) {
        for await (const event of session.send("hi")) {
          events.push(event);
        }
      }

      assert.equal(calls, 1);
      assert.ok(events.length > 0);
      assert.equal(writes.filter((line) => line.includes("未检测到 PowerShell 7")).length, 1);
      assert.equal(toolSnapshots.length, 2);
      for (const tools of toolSnapshots) {
        assert.ok(!tools.includes("roll__bash"));
        assert.ok(!tools.includes("roll__powershell"));
        assert.ok(!tools.includes("roll__exec_command"));
        assert.ok(!tools.includes("roll__exec_poll"));
        assert.ok(!tools.includes("roll__exec_list"));
      }
      first.abort();
      second.abort();
    } finally {
      await engine?.dispose();
      process.stderr.write = originalWrite;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

function installEngineConfig() {
  return runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
}

test("ConversationEngine 默认注册文件工具并标记 file-read/file-edit capability role", async () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const engine = createEngine({
      config: installEngineConfig(),
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
      skillLibrary: null,
      shellProfile: null,
    });

    const session = await engine.createSession();
    const tools = session.getCapabilityManifest().tools;
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__read_file"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__list_dir"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__grep"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__glob"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__edit_file"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__write_file"));
    assert.ok(tools.some((tool) => tool.role === "file-verify" && tool.id === "roll__verify_file"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine fileToolsEnabled: false 时不注册文件工具", async () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const engine = createEngine({
      config: installEngineConfig(),
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
      skillLibrary: null,
      shellProfile: null,
      fileToolsEnabled: false,
    });

    const session = await engine.createSession();
    const tools = session.getCapabilityManifest().tools;
    assert.ok(!tools.some((tool) => tool.role === "file-read"));
    assert.ok(!tools.some((tool) => tool.role === "file-edit"));
    assert.ok(!tools.some((tool) => tool.id === "roll__read_file"));
    assert.ok(!tools.some((tool) => tool.id === "roll__list_dir"));
    assert.ok(!tools.some((tool) => tool.id === "roll__edit_file"));
    assert.ok(!tools.some((tool) => tool.id === "roll__write_file"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConversationEngine resumeSession 重建 session 后文件工具行为与 createSession 一致", async () => {
  const dir = tempDir();
  try {
    const store = new ThreadStore(dir);
    const engine = createEngine({
      config: installEngineConfig(),
      model: new MockLanguageModelV4({}),
      store,
      sources: [],
      skillLibrary: null,
      shellProfile: null,
    });

    const created = await engine.createSession();
    await created.close();
    const resumed = await engine.resumeSession(created.id);
    assert.notEqual(resumed, created);
    const tools = resumed.getCapabilityManifest().tools;
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__read_file"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__list_dir"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__edit_file"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__write_file"));

    await engine.dispose();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function engineConfigWithInstructions(instructions: string) {
  return runtimeFixtureConfig({
    provider: "mock",
    modelName: "default-model",
    settings: { instructions },
  });
}

function capturingModel(captured: Array<{ readonly role: string; readonly content: unknown }>) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(...options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] } as const,
            { type: "text-start", id: "t" } as const,
            { type: "text-delta", id: "t", delta: "ok" } as const,
            { type: "text-end", id: "t" } as const,
            {
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop", raw: "stop" },
            } as const,
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

test("ConversationEngine 把显式 workspaceInstructions source 注入 session system prompt 并暴露 instructionsPath", async () => {
  const captured: Array<{ readonly role: string; readonly content: unknown }> = [];
  const engine = createEngine({
    config: engineConfigWithInstructions("auto"),
    model: capturingModel(captured),
    sources: [],
    skillLibrary: null,
    workspaceInstructions: {
      current: () => ({
        path: "/repo/AGENTS.md",
        content: "engine rules",
        truncated: false,
        totalChars: 12,
      }),
    },
  });
  const summary = await engine.getContextSummary();
  assert.equal(summary.instructionsPath, "/repo/AGENTS.md");
  const session = await engine.createSession();
  await drain(session.send("hi"));
  const system = captured.find((message) => message.role === "system");
  assert.ok(system);
  assert.ok(String(system.content).includes("# 工作区工程约定"));
  assert.ok(String(system.content).includes("engine rules"));
  await engine.dispose();
});

test("ConversationEngine workspaceInstructions 为 null 或 config off 时不注入", async () => {
  for (const variant of ["null", "off"] as const) {
    const captured: Array<{ readonly role: string; readonly content: unknown }> = [];
    const engine = createEngine({
      config: engineConfigWithInstructions(variant === "off" ? "off" : "auto"),
      model: capturingModel(captured),
      sources: [],
      skillLibrary: null,
      ...(variant === "null" ? { workspaceInstructions: null } : {}),
    });
    const summary = await engine.getContextSummary();
    assert.equal(summary.instructionsPath, undefined, variant);
    const session = await engine.createSession();
    await drain(session.send("hi"));
    const system = captured.find((message) => message.role === "system");
    assert.ok(system, variant);
    assert.ok(!String(system.content).includes("# 工作区工程约定"), variant);
    await engine.dispose();
  }
});

test("ConversationEngine 按 config 构造 source 时把告警转给 onWorkspaceInstructionsIssue", async () => {
  const dir = tempDir();
  try {
    const missing = join(dir, "nope.md");
    const issues: string[] = [];
    const engine = createEngine({
      config: engineConfigWithInstructions(missing),
      model: new MockLanguageModelV4({}),
      sources: [],
      skillLibrary: null,
      onWorkspaceInstructionsIssue: (message) => issues.push(message),
    });
    const summary = await engine.getContextSummary();
    assert.equal(summary.instructionsPath, undefined);
    assert.equal(issues.length, 1);
    assert.ok(issues[0]?.includes(missing));
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDynamicCapabilityContext 的 origin 会透传到 turn context", async () => {
  const config = runtimeFixtureConfig({ provider: "mock", modelName: "default-model" });
  const engine = createEngine({
    config,
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: engineTextStep("ok"),
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }),
    sources: [],
    skillLibrary: null,
    workspaceInstructions: null,
    hostMode: CAPABILITY_HOST_MODES.background,
    resolveDynamicCapabilityContext: () => ({
      origin: {
        kind: "scheduled",
        scheduleId: "sched-1",
        invocationId: "inv-1",
        scheduledFor: "2026-08-25T09:00:00.000Z",
        unattended: true,
      },
    }),
  });
  try {
    const session = await engine.createSession();
    await drain(session.send("hi"));
    const context = session.getCapabilityTurnContext();
    assert.equal(context?.version, 2);
    assert.equal(context?.dynamic.origin?.invocationId, "inv-1");
    assert.equal(context?.lifecycle.hostMode, CAPABILITY_HOST_MODES.background);
  } finally {
    await engine.dispose();
  }
});

test("buildSessionBashSettings 只在提供 onCommandSpawn 时写入该字段", () => {
  const config = runtimeFixtureConfig({ provider: "mock", modelName: "runtime-model" });
  const onCommandSpawn = () => {};
  const withHook = buildSessionBashSettings({
    settings: config.settings,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
    onCommandSpawn,
  });
  assert.equal(withHook.onCommandSpawn, onCommandSpawn);
  assert.equal(withHook.profile, powershellProfile);
  assert.deepEqual(withHook.env, { PATH: "/usr/bin" });
  assert.equal(withHook.turnTimeoutMs, config.settings.turnTimeoutMs);
  const without = buildSessionBashSettings({
    settings: config.settings,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
  });
  assert.equal("onCommandSpawn" in without, false);
});

test("SQLite 重启后旧观察继续投影，工具原文与结果 ID 保持可查", async () => {
  const dir = tempDir();
  let observations = 0;
  const source: AgentToolSource = {
    agentName: "browser",
    client: {
      callTool: async () => {
        const index = observations++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                page: { url: "https://example.test" },
                snapshot: {
                  snapshotId: `snapshot-${index}`,
                  browserInstance: "browser-a",
                  pageId: "page-a",
                  documentId: "document-a",
                  nodes: [
                    {
                      role: "textbox",
                      name: `field-${index}-${"x".repeat(2_000)}`,
                      ref: "@e1",
                      depth: 0,
                      ignored: false,
                    },
                  ],
                  refs: [
                    {
                      ref: "@e1",
                      role: "textbox",
                      name: `field-${index}-${"x".repeat(2_000)}`,
                      nth: 0,
                      disabled: false,
                    },
                  ],
                  nodeCount: 1,
                  truncated: false,
                  maxNodes: 100,
                  interactiveOnly: true,
                },
              }),
            },
          ],
        };
      },
    } as unknown as AgentToolSource["client"],
    tools: [
      {
        tool: { name: "snapshot", inputSchema: { type: "object", properties: {} } },
        annotations: { readOnlyHint: true },
        observationRetention: { kind: "browser-ax-snapshot" },
      },
    ],
  };
  const config = installEngineConfig();
  try {
    const firstStore = new ThreadStore(dir);
    const firstEngine = createEngine({
      config,
      model: sequencedEngineModel([
        engineToolCallStep("snapshot-call-0", "browser__snapshot", {}),
        engineToolCallStep("snapshot-call-1", "browser__snapshot", {}),
        engineTextStep("done"),
      ]),
      sources: [source],
      store: firstStore,
      skillLibrary: null,
      workspaceInstructions: null,
    });
    const firstSession = await firstEngine.createSession();
    const threadId = firstSession.id;
    await drain(firstSession.send("inspect"));
    assert.equal(observations, 2);
    assert.match(JSON.stringify(firstStore.getMessages(threadId)), /field-0-x{100}/u);
    const oldId = firstStore.listToolExecutions(threadId)[0]?.id;
    assert.ok(oldId);
    await firstEngine.dispose();
    firstStore.close();

    const reopenedStore = new ThreadStore(dir);
    let prompt: LanguageModelV4CallOptions["prompt"] = [];
    const resumedEngine = createEngine({
      config,
      model: textModelCapture((options) => {
        prompt = options.prompt;
      }),
      sources: [source],
      store: reopenedStore,
      skillLibrary: null,
      workspaceInstructions: null,
    });
    try {
      const resumed = await resumedEngine.resumeSession(threadId);
      await drain(resumed.send("continue"));
      const modelInput = JSON.stringify(prompt);
      assert.match(modelInput, /historicalObservation/u);
      assert.match(modelInput, new RegExp(oldId, "u"));
      assert.doesNotMatch(modelInput, /field-0-x{100}/u);
      assert.match(JSON.stringify(reopenedStore.getMessages(threadId)), /field-0-x{100}/u);
    } finally {
      await resumedEngine.dispose();
      reopenedStore.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSessionExecSettings 只在提供 onCommandSpawn 时写入该字段", () => {
  const config = runtimeFixtureConfig({ provider: "mock", modelName: "runtime-model" });
  const onCommandSpawn = () => {};
  const withHook = buildSessionExecSettings({
    settings: config.settings,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
    onCommandSpawn,
  });
  assert.equal(withHook.onCommandSpawn, onCommandSpawn);
  assert.equal(withHook.maxSessions, config.settings.shell.session.maxSessions);
  assert.equal(withHook.bufferCapacity, config.settings.shell.maxCaptureBytes);
  const without = buildSessionExecSettings({
    settings: config.settings,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
  });
  assert.equal("onCommandSpawn" in without, false);
});

function assertVisibleOrRecoverable(
  store: ThreadStore,
  threadId: string,
  prompt: string,
  fact: string,
): void {
  if (prompt.includes(fact)) return;
  assert.match(prompt, /roll__transcript/u);
  let checkpoint = store.getLatestCheckpoint(threadId);
  while (checkpoint) {
    let afterSequence = -1;
    while (true) {
      const page = store.readCheckpointTranscript(threadId, {
        checkpointId: checkpoint.id,
        kind: "message",
        afterSequence,
        limit: 20,
      });
      for (const entry of page.entries) {
        const chunk = executeTranscriptTool(
          (options) => store.readCheckpointTranscript(threadId, options),
          {
            checkpointId: checkpoint.id,
            sequence: entry.sequence,
            maxChars: 4_000,
          },
        );
        if (JSON.stringify(chunk.model).includes(fact)) return;
      }
      if (page.nextAfterSequence === undefined) break;
      afterSequence = page.nextAfterSequence;
    }
    checkpoint =
      checkpoint.previousCheckpointId === undefined
        ? undefined
        : store.getCheckpoint(threadId, checkpoint.previousCheckpointId);
  }
  assert.fail("omitted historical fact must remain available through optional transcript reads");
}

function runtimeFixtureConfig(input: {
  readonly settings?: unknown;
  readonly provider?: string;
  readonly modelName?: string;
}) {
  return {
    settings: runtimeSettingsSchema.parse(input.settings ?? {}),
    provider: input.provider ?? "mock",
    modelName: input.modelName ?? "default-model",
  };
}

type FixtureEngineOptions = Omit<
  ConversationEngineOptions,
  "settings" | "provider" | "modelName"
> & {
  readonly config: ReturnType<typeof runtimeFixtureConfig>;
};
function createEngine({ config, ...input }: FixtureEngineOptions): ConversationEngine {
  return new ConversationEngine({ ...config, ...input });
}
function switchModel(engine: ConversationEngine, input: EngineModelSwitch) {
  return engine.switchModel(input);
}
