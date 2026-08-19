import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { APICallError, simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SKILL_TOOL_ID, type SkillLibrary } from "@roll-agent/core/skills/library";
import { AgentSession } from "./agent-session.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import type { ToolResourceHint } from "../tool-bridge/tool-execution-coordinator.ts";
import type { ToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { readCancelledTurnRecoveryCheckpoint } from "./cancelled-turn-recovery.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import { ConfigurableToolPolicy } from "../policy/configurable-policy.ts";
import type { PolicyDecision, ToolPolicy } from "../types/policy.ts";
import type { SessionEvent } from "../types/events.ts";
import { ruleBasedClassifier } from "../bash/classifier/index.ts";
import type { ShellProfile } from "../bash/profile.ts";
import { killProcessGroup } from "../bash/kill.ts";
import {
  compactionCheckpointV1Schema,
  createCompactionCheckpoint,
  createEmptyCompactionToolState,
} from "./compaction-checkpoint.ts";
import { estimateMessagesTokens } from "./compactor.ts";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };
const TOOL_CALLS: LanguageModelV4FinishReason = { unified: "tool-calls", raw: "tool-calls" };

const posixProfile: ShellProfile = {
  id: "posix",
  toolName: "bash",
  supportsSessionExec: true,
  supportsSafeCommandClassification: true,
  buildSpawn: (command, workdir, env) => ({
    file: "/bin/sh",
    args: ["-c", command],
    options: { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
  }),
  classify: (command, workdir) => ruleBasedClassifier.classify(command, workdir),
  killTree: async () => {},
  systemPromptHints: () => [],
};

const allowToolPolicy: ToolPolicy = {
  check: (): PolicyDecision => ({ action: "allow" }),
};

function usage(inputTokens = 1, outputTokens = 1) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
}

function streamChunks(chunks: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function sequencedModel(steps: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
  });
}

test("AgentSession exposes a stable user input Tool only while the host capability is enabled", async () => {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options);
      return streamChunks(textStep("done"));
    },
  });
  const session = new AgentSession({
    id: "user-input-capability",
    model,
    sources: [],
    maxSteps: 4,
  });
  try {
    assert.equal(
      session.getCapabilityManifest().tools.some((tool) => tool.role === "user-input"),
      false,
    );
    session.setUserInputAvailable(true);
    const firstTool = session
      .getCapabilityManifest()
      .tools.find((tool) => tool.role === "user-input");
    assert.equal(firstTool?.id, "roll__user_input");
    session.setUserInputAvailable(false);
    assert.equal(
      session.getCapabilityManifest().tools.some((tool) => tool.role === "user-input"),
      false,
    );
    session.setUserInputAvailable(true);
    assert.equal(
      session.getCapabilityManifest().tools.find((tool) => tool.role === "user-input")?.id,
      firstTool?.id,
    );

    await collect(session.send("need structured input"));
    assert.match(JSON.stringify(calls[0]?.tools), /roll__user_input/u);
    const systemPrompt = JSON.stringify(
      calls[0]?.prompt.find((message) => message.role === "system"),
    );
    assert.match(systemPrompt, /不请求密码、令牌、密钥/u);
    assert.match(systemPrompt, /用户取消属于正常结果/u);
  } finally {
    await session.close();
  }
});

function textStep(text: string, inputTokens = 1, outputTokens = 1): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: usage(inputTokens, outputTokens), finishReason: STOP },
  ];
}

function reasoningOnlyStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: text },
    { type: "reasoning-end", id: "r" },
    { type: "finish", usage: usage(1, 3), finishReason: STOP },
  ];
}

function streamErrorStep(message: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "error", error: message },
  ];
}

function throwingStream(message: string) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.error(new Error(message));
      },
    }),
  };
}

function textThenStreamErrorStep(text: string, message: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "error", error: message },
  ];
}

function toolCallStep(
  toolName: string,
  input: unknown,
  inputTokens = 1,
  outputTokens = 1,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
    { type: "finish", usage: usage(inputTokens, outputTokens), finishReason: TOOL_CALLS },
  ];
}

function multiToolCallStep(
  calls: ReadonlyArray<{
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
  }>,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    ...calls.map(
      (call): LanguageModelV4StreamPart => ({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: JSON.stringify(call.input),
      }),
    ),
    { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
  ];
}

function textThenToolCallStep(
  text: string,
  toolName: string,
  input: unknown,
  inputTokens = 1,
  outputTokens = 1,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
    { type: "finish", usage: usage(inputTokens, outputTokens), finishReason: TOOL_CALLS },
  ];
}

function source(agentName: string, toolName: string, onCall?: () => void): AgentToolSource {
  const client = {
    callTool: async () => {
      onCall?.();
      return { content: [{ type: "text", text: "result-ok" }] };
    },
  } as unknown as Client;
  return {
    agentName,
    client,
    tools: [
      {
        tool: {
          name: toolName,
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: undefined,
      },
    ],
  };
}

function abortableSource(
  agentName: string,
  toolName: string,
  onCall?: () => void,
): AgentToolSource {
  const client = {
    callTool: async (
      _request: unknown,
      _resultSchema: unknown,
      options: { readonly signal?: AbortSignal } | undefined,
    ) => {
      onCall?.();
      await new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  } as unknown as Client;
  return {
    agentName,
    client,
    tools: [
      {
        tool: {
          name: toolName,
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: undefined,
      },
    ],
  };
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

function testBashSettings(workdir: string) {
  return {
    workdir,
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 600_000,
    turnTimeoutMs: 600_000,
    maxCaptureBytes: 1_048_576,
    maxModelOutputChars: 16_000,
    profile: posixProfile,
  };
}

function sessionExecSettings(profile: ShellProfile = posixProfile) {
  return {
    workdir: process.cwd(),
    profile,
    maxSessions: 8,
    defaultYieldMs: 250,
    maxOutputTokens: 10_000,
    bufferCapacity: 100_000,
  };
}

function sessionIdFromToolResult(
  events: readonly SessionEvent[],
  toolName = "exec_command",
): number {
  const result = events.find(
    (event) => event.type === "tool-result" && event.toolName === toolName,
  );
  assert.ok(result && result.type === "tool-result");
  const output = JSON.stringify(result.output);
  const match = /Session: (\d+)/u.exec(output);
  assert.ok(match, `期望 ${toolName} 返回 running session id，实际: ${output}`);
  return Number(match[1]);
}

interface ListedExecSession {
  readonly session_id: number;
  readonly state: string;
  readonly termination_cause?: string;
}

function listedExecSessions(events: readonly SessionEvent[]): readonly ListedExecSession[] {
  const result = events.find(
    (event) => event.type === "tool-result" && event.toolName === "exec_list",
  );
  assert.ok(result && result.type === "tool-result");
  const payload = JSON.parse(String(result.output)) as {
    readonly sessions: readonly ListedExecSession[];
  };
  return payload.sessions;
}

test("AgentSession 流式输出纯文本并累积历史", async () => {
  const model = sequencedModel([textStep("你好世界")]);
  const session = new AgentSession({ id: "s1", model, sources: [], maxSteps: 4 });
  const events = await collect(session.send("hi"));

  assert.equal(events[0]?.type, "message-start");
  assert.equal(events.at(-1)?.type, "message-finish");
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.ok(finish);
  assert.equal(finish.text, "你好世界");
  assert.ok(finish.totalUsage);
  assert.equal(finish.totalUsage.inputTokens, 1);
  assert.equal(finish.totalUsage.outputTokens, 1);
  assert.equal(session.getMessages()[0]?.role, "user");
});

test("AgentSession 跑通 agentic tool-call loop（无 policy 直接执行）", async () => {
  const model = sequencedModel([toolCallStep("echo-agent__echo", { q: "x" }), textStep("完成")]);
  const session = new AgentSession({
    id: "s2",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
  });
  const events = await collect(session.send("call echo"));

  const toolCall = events.find((event) => event.type === "tool-call");
  assert.ok(toolCall && toolCall.type === "tool-call");
  assert.equal(toolCall.agentName, "echo-agent");
  assert.equal(toolCall.toolName, "echo");
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
});

test("AgentSession 区分本轮累计输入和上下文输入压力", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 50),
    textStep("完成", 60),
  ]);
  const session = new AgentSession({
    id: "s2-usage",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
  });

  const events = await collect(session.send("call echo"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );

  assert.ok(finish);
  assert.equal(finish.totalUsage?.inputTokens, 110);
  assert.equal(finish.contextInputTokens, 60);
});

test("AgentSession 透出 cached 与 reasoning token", async () => {
  const model = sequencedModel([
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "ok" },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
          outputTokens: { total: 20, text: 12, reasoning: 8 },
        },
        finishReason: STOP,
      },
    ],
  ]);
  const session = new AgentSession({ id: "s-cache", model, sources: [], maxSteps: 2 });
  const events = await collect(session.send("hi"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );

  assert.ok(finish);
  assert.equal(finish.totalUsage?.cachedInputTokens, 40);
  assert.equal(finish.totalUsage?.reasoningTokens, 8);
  assert.equal(finish.sessionUsage?.cachedInputTokens, 40);
});

test("setProviderOptions only affects the next turn's streamText", async () => {
  const seen: Array<unknown> = [];
  const changes: Array<unknown> = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: LanguageModelV4CallOptions) => {
      seen.push(options.providerOptions);
      return streamChunks(textStep("ok"));
    },
  });
  const session = new AgentSession({
    id: "s-po",
    model,
    sources: [],
    maxSteps: 2,
    providerOptions: { alibaba: { enableThinking: false } },
    onProviderOptionsChange: (providerOptions) => changes.push(providerOptions),
  });
  await collect(session.send("a"));
  session.setProviderOptions({ alibaba: { enableThinking: true, thinkingBudget: 8192 } });
  await collect(session.send("b"));

  assert.deepEqual(seen[0], { alibaba: { enableThinking: false } });
  assert.deepEqual(seen[1], { alibaba: { enableThinking: true, thinkingBudget: 8192 } });
  assert.deepEqual(changes, [{ alibaba: { enableThinking: true, thinkingBudget: 8192 } }]);
});

test("AgentSession 达到 maxSteps 上限且仍在调工具时标记 stoppedAtStepLimit", async () => {
  const model = sequencedModel([toolCallStep("echo-agent__echo", { q: "x" })]);
  const session = new AgentSession({
    id: "s-step-limit",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 2,
  });
  const events = await collect(session.send("loop"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );

  assert.ok(finish);
  assert.equal(finish.stoppedAtStepLimit, true);
});

test("AgentSession debugEvents 输出 turn/model 阶段日志", async () => {
  const model = sequencedModel([textStep("ok")]);
  const session = new AgentSession({
    id: "s2-debug",
    model,
    sources: [],
    maxSteps: 2,
    turnTimeoutMs: 60_000,
    debugEvents: true,
  });

  const events = await collect(session.send("debug"));
  const debugMessages = events
    .filter((event): event is Extract<SessionEvent, { type: "debug" }> => event.type === "debug")
    .map((event) => `${event.stage}:${event.message}`);

  assert.ok(debugMessages.includes("turn:start"));
  assert.ok(debugMessages.includes("model:calling streamText"));
  assert.ok(debugMessages.includes("model:first stream event"));
  assert.ok(debugMessages.includes("model:response messages ready"));
});

test("AgentSession 保持 thinking 但不持久化 reasoning-only 输出", async () => {
  const model = sequencedModel([reasoningOnlyStep("内部思考和被误放进 reasoning 的最终答复")]);
  const session = new AgentSession({
    id: "s2-reasoning-only",
    model,
    sources: [],
    maxSteps: 2,
  });

  const events = await collect(session.send("hi"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  const reasoningEvents = events.filter(
    (
      event,
    ): event is Extract<
      SessionEvent,
      { type: "reasoning-start" | "reasoning-delta" | "reasoning-end" }
    > =>
      event.type === "reasoning-start" ||
      event.type === "reasoning-delta" ||
      event.type === "reasoning-end",
  );

  assert.ok(finish);
  assert.deepEqual(reasoningEvents, [
    { type: "reasoning-start", reasoningId: "r" },
    {
      type: "reasoning-delta",
      reasoningId: "r",
      delta: "内部思考和被误放进 reasoning 的最终答复",
    },
    { type: "reasoning-end", reasoningId: "r" },
  ]);
  assert.equal(finish.text, "");
  assert.equal(finish.totalUsage?.outputTokens, 3);
  assert.deepEqual(session.getMessages(), [{ role: "user", content: "hi" }]);
});

test("AgentSession chat 调用注入最终回复必须走 text 通道的系统提示", async () => {
  let serializedPrompt = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      serializedPrompt = JSON.stringify(options.prompt);
      return streamChunks(textStep("ok"));
    },
  });
  const session = new AgentSession({
    id: "s2-system",
    model,
    sources: [],
    maxSteps: 2,
  });

  await collect(session.send("hi"));

  assert.match(serializedPrompt, /普通 text 输出通道/);
  assert.match(serializedPrompt, /不要复述用户输入/);
});

test("AgentSession 在首次推理前直接预加载显式 skill，持久化仍保留原始输入", async () => {
  const summary = { name: "demo", description: "demo skill", source: "project" as const };
  const library: SkillLibrary = {
    list: () => [summary],
    load: () => ({
      summary,
      content: "DEMO_SKILL_BODY",
      referencePaths: ["references/extra.md"],
      skillRoot: "/tmp/demo-skill",
    }),
    loadReference: () => undefined,
  };
  let serializedSystem = "";
  let serializedUser = "";
  let modelCalls = 0;
  let persisted: readonly ModelMessage[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      modelCalls += 1;
      serializedSystem = JSON.stringify(
        options.prompt.find((message) => message.role === "system"),
      );
      serializedUser = JSON.stringify(options.prompt.find((message) => message.role === "user"));
      return streamChunks(textStep("done"));
    },
  });
  const session = new AgentSession({
    id: "explicit-skill",
    model,
    sources: [],
    maxSteps: 2,
    skillLibrary: library,
    onPersist: (messages) => {
      persisted = messages;
    },
  });

  const events = await collect(session.send("/demo 修一下类型"));

  assert.equal(modelCalls, 1);
  assert.doesNotMatch(serializedSystem, /DEMO_SKILL_BODY/u);
  assert.match(serializedUser, /DEMO_SKILL_BODY/u);
  assert.match(serializedUser, /SKILL_ROOT=\/tmp\/demo-skill/u);
  assert.match(serializedUser, /Harness-loaded explicit Skill context/u);
  assert.match(serializedUser, /修一下类型/u);
  assert.doesNotMatch(serializedUser, /\/demo 修一下类型/u);
  assert.equal(session.getMessages()[0]?.content, "/demo 修一下类型");
  assert.equal(persisted[0]?.content, "/demo 修一下类型");
  assert.equal(
    events.some((event) => event.type === "tool-call"),
    false,
  );
});

test("AgentSession 对未知或部分拼错的显式 skill 在模型调用前失败", async () => {
  const summary = { name: "demo", description: "demo skill", source: "project" as const };
  const library: SkillLibrary = {
    list: () => [summary],
    load: () => ({ summary, content: "body", referencePaths: [] }),
    loadReference: () => undefined,
  };
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return streamChunks(textStep("unexpected"));
    },
  });
  const session = new AgentSession({
    id: "explicit-skill-unknown",
    model,
    sources: [],
    maxSteps: 2,
    skillLibrary: library,
  });

  const events = await collect(session.send("/demo /typo 修一下"));

  assert.equal(modelCalls, 0);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.message, /未知 skill \/typo/u);

  const emptyEvents = await collect(session.send("/demo"));
  assert.equal(modelCalls, 0);
  const emptyError = emptyEvents.find((event) => event.type === "error");
  assert.ok(emptyError && emptyError.type === "error");
  assert.match(emptyError.message, /用法/u);
});

test("AgentSession 非 Provider 错误即使包含 context 文案也不压缩历史", async () => {
  const summary = { name: "demo", description: "demo skill", source: "project" as const };
  const original: readonly ModelMessage[] = [
    { role: "user", content: "old-1" },
    { role: "assistant", content: "answer-1" },
    { role: "user", content: "old-2" },
    { role: "assistant", content: "answer-2" },
  ];
  let modelCalls = 0;
  let replaceCalls = 0;
  const session = new AgentSession({
    id: "explicit-skill-context-like-error",
    model: new MockLanguageModelV4({
      doStream: async () => {
        modelCalls += 1;
        return streamChunks(textStep("unexpected"));
      },
    }),
    sources: [],
    maxSteps: 2,
    initialMessages: original,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    skillLibrary: {
      list: () => [summary],
      load: () => {
        throw new Error("input is too long");
      },
      loadReference: () => undefined,
    },
    onReplace: () => {
      replaceCalls += 1;
    },
  });

  const events = await collect(session.send("/demo execute"));

  assert.equal(modelCalls, 0);
  assert.equal(replaceCalls, 0);
  assert.deepEqual(session.getMessages(), original);
  assert.equal(
    events.some((event) => event.type === "compaction-start" || event.type === "context-compacted"),
    false,
  );
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.equal(error.message, "input is too long");
});

test("AgentSession context overflow 重放复用同一份显式 skill 快照", async () => {
  const summary = { name: "demo", description: "demo skill", source: "project" as const };
  let loads = 0;
  const library: SkillLibrary = {
    list: () => [summary],
    load: () => {
      loads += 1;
      return { summary, content: `BODY_VERSION_${String(loads)}`, referencePaths: [] };
    },
    loadReference: () => undefined,
  };
  const prompts: string[] = [];
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      modelCalls += 1;
      return streamChunks(
        modelCalls === 1 ? streamErrorStep("context_length_exceeded") : textStep("done"),
      );
    },
  });
  const session = new AgentSession({
    id: "explicit-skill-replay-snapshot",
    model,
    sources: [],
    maxSteps: 2,
    skillLibrary: library,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  await collect(session.send("/demo retry"));

  assert.equal(loads, 1);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((prompt) => prompt.includes("BODY_VERSION_1")));
  assert.ok(prompts.every((prompt) => !prompt.includes("BODY_VERSION_2")));
});

test("AgentSession 将 AI SDK 的内建 Tool schema 错误分类为 invalid_input 且取消不误报副作用", async () => {
  const summary = { name: "demo", description: "demo skill", source: "project" as const };
  const library: SkillLibrary = {
    list: () => [summary],
    load: () => ({ summary, content: "body", referencePaths: [] }),
    loadReference: () => undefined,
  };
  const model = sequencedModel([toolCallStep(SKILL_TOOL_ID, { name: 1 }), textStep("recovered")]);
  const session = new AgentSession({
    id: "invalid-built-in-input",
    model,
    sources: [],
    maxSteps: 4,
    skillLibrary: library,
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("load skill")) {
    events.push(event);
    if (event.type === "tool-result" && event.outcome?.kind === "invalid_input") {
      session.cancel();
    }
  }
  const result = events.find((event) => event.type === "tool-result");

  assert.ok(result && result.type === "tool-result");
  assert.equal(result.outcome?.kind, "invalid_input", JSON.stringify(result));
  const cancelled = events.find((event) => event.type === "turn-cancelled");
  assert.ok(cancelled && cancelled.type === "turn-cancelled");
  assert.doesNotMatch(cancelled.message, /正在进行|不会自动撤销|请检查结果/u);
});

test("AgentSession 不用英文错误文案猜测 invalid_input", async () => {
  const client = {
    callTool: async () => {
      throw new Error("Invalid input for tool plain-error");
    },
  } as unknown as Client;
  const failingSource: AgentToolSource = {
    agentName: "plain-error",
    client,
    tools: [
      {
        tool: {
          name: "read",
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: undefined,
      },
    ],
  };
  const model = sequencedModel([
    toolCallStep("plain-error__read", { q: "valid" }),
    textStep("recovered"),
  ]);
  const session = new AgentSession({
    id: "plain-error-message-is-not-schema-error",
    model,
    sources: [failingSource],
    maxSteps: 4,
    policy: allowToolPolicy,
  });

  const events = await collect(session.send("read"));
  const result = events.find((event) => event.type === "tool-result");

  assert.ok(result && result.type === "tool-result");
  assert.equal(result.outcome?.kind, "tool_failed", JSON.stringify(result));
});

test("AgentSession 写类动作触发 confirmation，approve 后执行", async () => {
  let calls = 0;
  const model = sequencedModel([
    toolCallStep("msg-agent__send_message", { q: "hi" }),
    textStep("已发送"),
  ]);
  const session = new AgentSession({
    id: "s3",
    model,
    sources: [source("msg-agent", "send_message", () => (calls += 1))],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
    turnTimeoutMs: 60_000,
  });

  const startedAt = Date.now();
  const events: SessionEvent[] = [];
  for await (const event of session.send("需要")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId);
    }
  }

  const confirmation = events.find((event) => event.type === "confirmation-required");
  assert.ok(confirmation && confirmation.type === "confirmation-required");
  assert.equal(confirmation.toolName, "send_message");
  assert.equal(confirmation.reason, "写/发送类操作");
  assert.ok(confirmation.expiresAt !== undefined);
  const expiresAt = Date.parse(confirmation.expiresAt);
  assert.ok(expiresAt >= startedAt + 60_000);
  assert.ok(expiresAt <= Date.now() + 60_000);
  assert.equal(calls, 1);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
});

test("AgentSession.approve 的 scope 透传到批准记忆：workdir 内二次编辑免于再次确认", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-session-approve-scope-"));
  writeFileSync(join(workdir, "a.txt"), "第一行\n第二行", "utf8");
  const model = sequencedModel([
    toolCallStep("roll__read_file", { path: "a.txt" }),
    toolCallStep("roll__edit_file", {
      file_path: "a.txt",
      edits: [{ old_string: "第一行", new_string: "改后一" }],
    }),
    textStep("已编辑第一行"),
    toolCallStep("roll__read_file", { path: "a.txt" }),
    toolCallStep("roll__edit_file", {
      file_path: "a.txt",
      edits: [{ old_string: "第二行", new_string: "改后二" }],
    }),
    textStep("已编辑第二行"),
  ]);
  const session = new AgentSession({
    id: "approve-scope-passthrough",
    model,
    sources: [],
    fileTools: { workdir },
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const firstEvents: SessionEvent[] = [];
  for await (const event of session.send("编辑第一行")) {
    firstEvents.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId, "session");
    }
  }
  const firstConfirmations = firstEvents.filter((event) => event.type === "confirmation-required");
  assert.equal(firstConfirmations.length, 1);
  const firstEditResult = firstEvents.find(
    (event) => event.type === "tool-result" && event.toolName === "edit_file",
  );
  assert.ok(
    firstEditResult && firstEditResult.type === "tool-result" && firstEditResult.isError === false,
  );

  const secondEvents: SessionEvent[] = [];
  for await (const event of session.send("编辑第二行")) {
    secondEvents.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId, "session");
    }
  }
  const secondConfirmations = secondEvents.filter(
    (event) => event.type === "confirmation-required",
  );
  assert.equal(
    secondConfirmations.length,
    0,
    "approve 的 scope=session 应已写入批准记忆，第二次编辑不应再次触发确认",
  );
  const secondEditResult = secondEvents.find(
    (event) => event.type === "tool-result" && event.toolName === "edit_file",
  );
  assert.ok(
    secondEditResult &&
      secondEditResult.type === "tool-result" &&
      secondEditResult.isError === false,
  );
});

test("AgentSession 未配置 turnTimeoutMs 时 confirmation 携带默认交互 deadline", async () => {
  let calls = 0;
  const model = sequencedModel([
    toolCallStep("msg-agent__send_message", { q: "hi" }),
    textStep("已发送"),
  ]);
  const session = new AgentSession({
    id: "s3-default-deadline",
    model,
    sources: [source("msg-agent", "send_message", () => (calls += 1))],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const startedAt = Date.now();
  const events: SessionEvent[] = [];
  for await (const event of session.send("需要")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId);
    }
  }

  const confirmation = events.find((event) => event.type === "confirmation-required");
  assert.ok(confirmation && confirmation.type === "confirmation-required");
  assert.ok(confirmation.expiresAt !== undefined);
  const expiresAt = Date.parse(confirmation.expiresAt);
  assert.ok(expiresAt >= startedAt + 5 * 60 * 1_000);
  assert.ok(expiresAt <= Date.now() + 5 * 60 * 1_000);
  assert.equal(calls, 1);
});

test("AgentSession 同批 Tool 先顺序完成全部准入，任一拒绝则整批零副作用", async () => {
  let calls = 0;
  const model = sequencedModel([
    multiToolCallStep([
      { toolCallId: "batch-1", toolName: "batch__first", input: { q: "one" } },
      { toolCallId: "batch-2", toolName: "batch__second", input: { q: "two" } },
    ]),
  ]);
  const session = new AgentSession({
    id: "batch-admission",
    model,
    sources: [
      source("batch", "first", () => (calls += 1)),
      source("batch", "second", () => (calls += 1)),
    ],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const events: SessionEvent[] = [];
  const confirmations: string[] = [];
  for await (const event of session.send("连续执行两个动作")) {
    events.push(event);
    if (event.type !== "confirmation-required") {
      continue;
    }
    confirmations.push(event.toolName);
    if (event.toolName === "first") {
      session.approve(event.approvalId);
    } else {
      assert.equal(calls, 0, "第二个准入完成前不应执行第一个工具");
      session.reject(event.approvalId, "拒绝第二个动作");
    }
  }

  assert.deepEqual(confirmations, ["first", "second"]);
  assert.equal(calls, 0);
  const outcomes = events
    .filter(
      (event): event is Extract<SessionEvent, { type: "tool-result" }> =>
        event.type === "tool-result",
    )
    .map((event) => [event.toolCallId, event.outcome?.kind]);
  assert.deepEqual(outcomes, [
    ["batch-1", "cancelled"],
    ["batch-2", "user_rejected"],
  ]);
});

test("AgentSession 用 MCP resourceHints 归一化跨 Agent 文件锁，同时并行无冲突文件", async () => {
  const runBatch = async (
    leftPath: string,
    rightPath: string,
    leftBaseDir = process.cwd(),
    rightBaseDir = process.cwd(),
  ): Promise<number> => {
    let active = 0;
    let maxActive = 0;
    const makeSource = (agentName: string, toolName: string): AgentToolSource => {
      const client = {
        callTool: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return { content: [{ type: "text", text: "ok" }] };
        },
      } as unknown as Client;
      return {
        agentName,
        client,
        resourceBaseDir: agentName === "left" ? leftBaseDir : rightBaseDir,
        tools: [
          {
            tool: {
              name: toolName,
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
            annotations: { destructiveHint: true },
            resourceHints: [{ field: "path", kind: "file" }],
          },
        ],
      };
    };
    const model = sequencedModel([
      multiToolCallStep([
        { toolCallId: "file-1", toolName: "left__write", input: { path: leftPath } },
        { toolCallId: "file-2", toolName: "right__write", input: { path: rightPath } },
      ]),
      textStep("done"),
    ]);
    const session = new AgentSession({
      id: `resource-${leftPath}-${rightPath}`,
      model,
      sources: [makeSource("left", "write"), makeSource("right", "write")],
      maxSteps: 4,
    });

    await collect(session.send("write files"));
    return maxActive;
  };

  const relative = "tmp/resource-lock.txt";
  assert.equal(await runBatch(relative, resolve(relative)), 1);
  assert.equal(
    await runBatch("out.txt", "/tmp/agent-root/out.txt", "/tmp/agent-root", "/tmp/other-agent"),
    1,
  );
  if (process.platform !== "win32") {
    const root = mkdtempSync(join(tmpdir(), "roll-resource-lock-"));
    const realBase = join(root, "real");
    const aliasBase = join(root, "alias");
    const futureRealBase = join(root, "future-real");
    const danglingAliasBase = join(root, "future-alias");
    try {
      mkdirSync(realBase);
      symlinkSync(realBase, aliasBase, "dir");
      assert.equal(await runBatch("out.txt", join(realBase, "out.txt"), aliasBase, root), 1);
      symlinkSync("future-real", danglingAliasBase, "dir");
      assert.equal(await runBatch("out.txt", "out.txt", danglingAliasBase, futureRealBase), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const caseRoot = mkdtempSync(join(tmpdir(), "roll-resource-case-lock-"));
  try {
    const probe = join(caseRoot, "CaseSensitivityProbe");
    writeFileSync(probe, "probe");
    const caseInsensitive = existsSync(join(caseRoot, "casesensitivityprobe"));
    const numericBase = join(caseRoot, "123");
    const cjkBase = join(caseRoot, "目录");
    mkdirSync(numericBase);
    mkdirSync(cjkBase);
    for (const baseDir of [numericBase, cjkBase, caseRoot]) {
      assert.equal(
        await runBatch("CaseTarget.txt", "casetarget.txt", baseDir, baseDir),
        caseInsensitive ? 1 : 2,
      );
    }
    assert.equal(
      await runBatch("straße.txt", "STRASSE.txt", caseRoot, caseRoot),
      caseInsensitive ? 1 : 2,
    );
    assert.equal(await runBatch("ẞ.txt", "SS.txt", caseRoot, caseRoot), caseInsensitive ? 1 : 2);
    assert.equal(await runBatch("straße-left.txt", "STRASSE-right.txt", caseRoot, caseRoot), 2);
  } finally {
    rmSync(caseRoot, { recursive: true, force: true });
  }
  const identityRoot = mkdtempSync(join(tmpdir(), "roll-resource-identity-lock-"));
  try {
    const target = join(identityRoot, "target.txt");
    const hardlinkAlias = join(identityRoot, "hardlink-alias.txt");
    writeFileSync(target, "target");
    linkSync(target, hardlinkAlias);
    assert.equal(await runBatch(target, hardlinkAlias), 1);

    const nfcFuturePath = join(identityRoot, "caf\u00e9.txt");
    const nfdFuturePath = join(identityRoot, "cafe\u0301.txt");
    assert.equal(await runBatch(nfcFuturePath, nfdFuturePath), 1);
  } finally {
    rmSync(identityRoot, { recursive: true, force: true });
  }
  assert.equal(await runBatch("tmp/left.txt", "tmp/right.txt"), 2);
});

test("AgentSession resourceHints value 解析 all-or-nothing，缺失 field 才允许跳过", async () => {
  let runIndex = 0;
  const runBatch = async (options: {
    readonly leftInput: Record<string, unknown>;
    readonly rightInput: Record<string, unknown>;
    readonly hints: readonly ToolResourceHint[];
    readonly resourceBaseDir?: string;
  }): Promise<number> => {
    let active = 0;
    let maxActive = 0;
    const client = {
      callTool: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Client;
    const makeTool = (name: string): AgentToolSource["tools"][number] => ({
      tool: { name, inputSchema: { type: "object" } },
      annotations: { destructiveHint: true },
      resourceHints: options.hints,
    });
    const source: AgentToolSource = {
      agentName: "resource-agent",
      client,
      tools: [makeTool("left"), makeTool("right")],
      ...(options.resourceBaseDir !== undefined
        ? { resourceBaseDir: options.resourceBaseDir }
        : {}),
    };
    const model = sequencedModel([
      multiToolCallStep([
        {
          toolCallId: "resource-left",
          toolName: "resource-agent__left",
          input: options.leftInput,
        },
        {
          toolCallId: "resource-right",
          toolName: "resource-agent__right",
          input: options.rightInput,
        },
      ]),
      textStep("done"),
    ]);
    runIndex += 1;
    const session = new AgentSession({
      id: `resource-value-${String(runIndex)}`,
      model,
      sources: [source],
      maxSteps: 4,
    });

    await collect(session.send("resolve resource values"));
    return maxActive;
  };
  const hints: readonly ToolResourceHint[] = [
    { field: "path", kind: "file", mode: "write" },
    { field: "conversationId", kind: "conversation", mode: "write" },
  ];

  assert.equal(
    await runBatch({
      leftInput: { path: ["left.txt", { invalid: true }], conversationId: "left" },
      rightInput: { path: ["right.txt", false], conversationId: "right" },
      hints,
      resourceBaseDir: process.cwd(),
    }),
    1,
  );
  assert.equal(
    await runBatch({
      leftInput: { path: { invalid: true }, conversationId: "left" },
      rightInput: { path: false, conversationId: "right" },
      hints,
      resourceBaseDir: process.cwd(),
    }),
    1,
  );
  assert.equal(
    await runBatch({
      leftInput: { path: "left.txt", conversationId: "left" },
      rightInput: { path: "right.txt", conversationId: "right" },
      hints,
    }),
    1,
  );
  assert.equal(
    await runBatch({
      leftInput: { conversationId: "left" },
      rightInput: { conversationId: "right" },
      hints,
    }),
    2,
  );
});

test("AgentSession 同批一成功一失败仍把两个结果交给下一次推理恢复", async () => {
  let modelCalls = 0;
  let recoveryPrompt = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return streamChunks(
          multiToolCallStep([
            { toolCallId: "batch-ok", toolName: "ok-agent__read", input: { q: "one" } },
            { toolCallId: "batch-fail", toolName: "fail-agent__read", input: { q: "two" } },
          ]),
        );
      }
      recoveryPrompt = JSON.stringify(options.prompt);
      return streamChunks(textStep("recovered from mixed batch"));
    },
  });
  const failingClient = {
    callTool: async () => {
      throw new Error("mixed batch failure");
    },
  } as unknown as Client;
  const failingSource: AgentToolSource = {
    agentName: "fail-agent",
    client: failingClient,
    tools: [
      {
        tool: {
          name: "read",
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: undefined,
      },
    ],
  };
  const session = new AgentSession({
    id: "batch-mixed-outcomes",
    model,
    sources: [source("ok-agent", "read"), failingSource],
    maxSteps: 4,
  });

  const events = await collect(session.send("run mixed batch"));
  const outcomes = new Map(
    events
      .filter(
        (event): event is Extract<SessionEvent, { type: "tool-result" }> =>
          event.type === "tool-result",
      )
      .map((event) => [event.toolCallId, event.outcome?.kind]),
  );

  assert.equal(modelCalls, 2);
  assert.equal(outcomes.get("batch-ok"), "success");
  assert.equal(outcomes.get("batch-fail"), "tool_failed");
  assert.match(recoveryPrompt, /result-ok/u);
  assert.match(recoveryPrompt, /mixed batch failure/u);
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(finish?.text, "recovered from mixed batch");
});

test("AgentSession cancel 同批执行中 Tool exactly-once，并允许下一轮恢复", async () => {
  const allToolsStarted = Promise.withResolvers<void>();
  let startedTools = 0;
  let modelCalls = 0;
  const onToolStart = (): void => {
    startedTools += 1;
    if (startedTools === 2) {
      allToolsStarted.resolve();
    }
  };
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return streamChunks(
        modelCalls === 1
          ? multiToolCallStep([
              { toolCallId: "slow-a", toolName: "slow-a__wait", input: { q: "one" } },
              { toolCallId: "slow-b", toolName: "slow-b__wait", input: { q: "two" } },
            ])
          : textStep("recovered after batch cancellation"),
      );
    },
  });
  const session = new AgentSession({
    id: "batch-running-cancel",
    model,
    sources: [
      abortableSource("slow-a", "wait", onToolStart),
      abortableSource("slow-b", "wait", onToolStart),
    ],
    maxSteps: 4,
  });

  const firstTurn = collect(session.send("run cancellable batch"));
  await allToolsStarted.promise;
  assert.equal(session.cancel(), true);
  const cancelledEvents = await firstTurn;

  assert.equal(startedTools, 2);
  assert.equal(cancelledEvents.filter((event) => event.type === "turn-cancelled").length, 1);
  assert.equal(
    cancelledEvents.some((event) => event.type === "message-finish"),
    false,
  );
  const records = session.getToolExecutions({}, true);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => [record.toolCallId, record.outcome.kind]).sort(), [
    ["slow-a", "cancelled"],
    ["slow-b", "cancelled"],
  ]);
  assert.ok(
    records.every(
      (record) => record.outcome.kind === "cancelled" && record.outcome.reason === "user",
    ),
  );

  const recoveredEvents = await collect(session.send("continue after cancellation"));
  const finish = recoveredEvents.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(finish?.text, "recovered after batch cancellation");
  assert.equal(modelCalls, 2);
});

test(
  "AgentSession cancel 可中断悬挂的 dynamic capability context，且不调用 Provider",
  { timeout: 1_000 },
  async () => {
    const resolverStarted = Promise.withResolvers<void>();
    const neverResolves = new Promise<never>(() => {});
    let resolverSignal: AbortSignal | undefined;
    let modelCalls = 0;
    const session = new AgentSession({
      id: "dynamic-context-cancel",
      model: new MockLanguageModelV4({
        doStream: async () => {
          modelCalls += 1;
          return streamChunks(textStep("不应调用"));
        },
      }),
      sources: [],
      maxSteps: 2,
      resolveDynamicCapabilityContext: (abortSignal) => {
        resolverSignal = abortSignal;
        resolverStarted.resolve();
        return neverResolves;
      },
    });

    const turn = collect(session.send("cancel while resolving context"));
    await resolverStarted.promise;
    assert.equal(session.cancel(), true);
    const events = await turn;

    assert.equal(resolverSignal?.aborted, true);
    assert.equal(modelCalls, 0);
    const cancelled = events.find((event) => event.type === "turn-cancelled");
    assert.ok(cancelled && cancelled.type === "turn-cancelled");
    assert.equal(cancelled.reason, "user");
    assert.equal(
      events.some((event) => event.type === "message-finish"),
      false,
    );
  },
);

test(
  "AgentSession turnTimeout 可结束悬挂的 dynamic capability context，且不调用 Provider",
  { timeout: 1_000 },
  async () => {
    const neverResolves = new Promise<never>(() => {});
    let modelCalls = 0;
    const session = new AgentSession({
      id: "dynamic-context-timeout",
      model: new MockLanguageModelV4({
        doStream: async () => {
          modelCalls += 1;
          return streamChunks(textStep("不应调用"));
        },
      }),
      sources: [],
      maxSteps: 2,
      turnTimeoutMs: 30,
      resolveDynamicCapabilityContext: () => neverResolves,
    });

    const events = await collect(session.send("timeout while resolving context"));

    assert.equal(modelCalls, 0);
    const cancelled = events.find((event) => event.type === "turn-cancelled");
    assert.ok(cancelled && cancelled.type === "turn-cancelled");
    assert.equal(cancelled.reason, "timeout");
    assert.match(cancelled.message, /等待时间过长/u);
    assert.doesNotMatch(cancelled.message, /30ms|session|外部副作用/u);
    assert.equal(
      events.some((event) => event.type === "message-finish"),
      false,
    );
  },
);

test(
  "AgentSession cancel 写盘失败时回滚内存并报告 persistence error",
  { timeout: 1_000 },
  async () => {
    const resolverStarted = Promise.withResolvers<void>();
    const neverResolves = new Promise<never>(() => {});
    let modelCalls = 0;
    let persistCalls = 0;
    const session = new AgentSession({
      id: "dynamic-context-cancel-persist-failure",
      model: new MockLanguageModelV4({
        doStream: async () => {
          modelCalls += 1;
          return streamChunks(textStep("不应调用"));
        },
      }),
      sources: [],
      maxSteps: 2,
      resolveDynamicCapabilityContext: () => {
        resolverStarted.resolve();
        return neverResolves;
      },
      onPersist: () => {
        persistCalls += 1;
        throw new Error("disk full");
      },
    });

    const turn = collect(session.send("cancel before persistence"));
    await resolverStarted.promise;
    assert.equal(session.cancel(), true);
    const events = await turn;

    assert.equal(modelCalls, 0);
    assert.equal(persistCalls, 1);
    assert.deepEqual(session.getMessages(), []);
    const cancelled = events.find((event) => event.type === "turn-cancelled");
    assert.ok(cancelled && cancelled.type === "turn-cancelled");
    assert.match(cancelled.message, /未能保存/u);
    assert.doesNotMatch(cancelled.message, /会保留/u);
    const persistenceError = events.find(
      (event): event is Extract<SessionEvent, { type: "error" }> => event.type === "error",
    );
    assert.equal(persistenceError?.stage, "execute");
    assert.match(persistenceError?.message ?? "", /取消状态持久化失败: disk full/u);
  },
);

test("AgentSession reject 后终止当前 turn，不让模型重复调用工具", async () => {
  let calls = 0;
  const model = sequencedModel([
    textThenToolCallStep("需要", "msg-agent__send_message", { q: "hi" }),
    textStep("好的"),
  ]);
  const session = new AgentSession({
    id: "s4",
    model,
    sources: [source("msg-agent", "send_message", () => (calls += 1))],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("需要")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.reject(event.approvalId, "用户取消");
    }
  }

  assert.equal(calls, 0);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === true);
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.ok(finish);
  assert.equal(finish.text, "已取消执行: 用户取消");
  assert.deepEqual(
    events
      .filter(
        (event): event is Extract<SessionEvent, { type: "text-delta" }> =>
          event.type === "text-delta",
      )
      .map((event) => event.delta),
    ["已取消执行: 用户取消"],
  );
  assert.equal(events.filter((event) => event.type === "tool-call").length, 1);
  assert.equal(session.getMessages().at(-1)?.role, "assistant");
  assert.equal(session.getMessages().at(-1)?.content, "已取消执行: 用户取消");
});

test("AgentSession policy deny 返回类型化错误并允许模型恢复", async () => {
  let calls = 0;
  const denyPolicy: ToolPolicy = {
    check(): PolicyDecision {
      return { action: "deny", reason: "禁止" };
    },
  };
  const model = sequencedModel([toolCallStep("x-agent__do_it", { q: "v" }), textStep("收到")]);
  const session = new AgentSession({
    id: "s5",
    model,
    sources: [source("x-agent", "do_it", () => (calls += 1))],
    maxSteps: 8,
    policy: denyPolicy,
  });

  const events = await collect(session.send("do it"));
  assert.equal(calls, 0);
  assert.equal(
    events.some((event) => event.type === "confirmation-required"),
    false,
  );
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === true);
  assert.equal(toolResult.outcome?.kind, "policy_denied");
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.ok(finish);
  assert.equal(finish.text, "收到");
  assert.match(JSON.stringify(session.getMessages().at(-1)?.content), /收到/u);
});

test("AgentSession cancel 中途确认不悬挂且持久化取消标记", async () => {
  let calls = 0;
  const model = sequencedModel([
    toolCallStep("msg-agent__send_message", { q: "hi" }),
    textStep("done"),
  ]);
  const session = new AgentSession({
    id: "s6",
    model,
    sources: [source("msg-agent", "send_message", () => (calls += 1))],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("send hi")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.cancel();
    }
  }

  assert.ok(events.some((event) => event.type === "confirmation-required"));
  const cancelled = events.find((event) => event.type === "turn-cancelled");
  assert.ok(cancelled && cancelled.type === "turn-cancelled");
  assert.equal(cancelled.reason, "user");
  assert.equal(calls, 0);
  assert.doesNotMatch(cancelled.message, /正在进行|不会自动撤销|请检查结果/u);
  const records = session.getToolExecutions({}, true);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.outcome, {
    kind: "cancelled",
    reason: "user",
    executionState: "not_executed",
  });
  assert.match(JSON.stringify(records[0]?.display), /确定未执行/u);
  assert.doesNotMatch(JSON.stringify(records[0]?.display), /最终结果尚未确认/u);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "message-finish"),
    false,
  );
  assert.equal(session.getMessages().length, 2);
  assert.match(String(session.getMessages().at(-1)?.content), /已停止本轮/);
});

test("AgentSession recovery prompt 以最新真实用户意图为最终约束", async () => {
  let calls = 0;
  const persisted: ModelMessage[][] = [];
  const sourceUnderTest = source("msg-agent", "send_message", () => {
    calls += 1;
  });
  const firstSession = new AgentSession({
    id: "cancelled-recovery-latest-user",
    model: sequencedModel([toolCallStep("msg-agent__send_message", { q: "git status --short" })]),
    sources: [sourceUnderTest],
    maxSteps: 4,
    policy: new DefaultToolPolicy(),
    onPersist: (messages) => persisted.push([...messages]),
  });

  for await (const event of firstSession.send("执行 git status --short")) {
    if (event.type === "confirmation-required") {
      firstSession.cancel();
    }
  }
  assert.equal(calls, 0);
  assert.equal(persisted.length, 1);
  const restoredMessages = JSON.parse(JSON.stringify(persisted[0])) as ModelMessage[];

  let latestUserPrompt: LanguageModelV4CallOptions["prompt"] | undefined;
  const latestUserSession = new AgentSession({
    id: "cancelled-recovery-latest-user-restored",
    model: new MockLanguageModelV4({
      doStream: async (options) => {
        latestUserPrompt = options.prompt;
        return streamChunks(textStep("E2E_CONNECTION_OK"));
      },
    }),
    initialMessages: restoredMessages,
    sources: [sourceUnderTest],
    maxSteps: 4,
  });
  const latestUserEvents = await collect(
    latestUserSession.send("请只回复 E2E_CONNECTION_OK，不要调用工具。"),
  );
  const serializedLatestPrompt = JSON.stringify(latestUserPrompt);
  const finalPromptMessage = latestUserPrompt?.at(-1);

  assert.equal(finalPromptMessage?.role, "user");
  assert.match(JSON.stringify(finalPromptMessage), /E2E_CONNECTION_OK.*不要调用工具/u);
  assert.match(serializedLatestPrompt, /roll__interrupted_turn_recovery/u);
  assert.match(serializedLatestPrompt, /\\"executionState\\":\\"not_executed\\"/u);
  assert.match(serializedLatestPrompt, /不授权继续或重试旧任务/u);
  assert.match(serializedLatestPrompt, /最新真实用户消息的目标和约束为准/u);
  assert.ok(
    serializedLatestPrompt.indexOf("git status --short") <
      serializedLatestPrompt.lastIndexOf("E2E_CONNECTION_OK"),
  );
  assert.equal(calls, 0);
  assert.equal(
    latestUserEvents.some(
      (event) => event.type === "message-finish" && event.text === "E2E_CONNECTION_OK",
    ),
    true,
  );

  let step = 0;
  let continuePrompt: LanguageModelV4CallOptions["prompt"] | undefined;
  const continueSession = new AgentSession({
    id: "cancelled-recovery-explicit-continue",
    model: new MockLanguageModelV4({
      doStream: async (options) => {
        continuePrompt ??= options.prompt;
        const chunks =
          step === 0
            ? multiToolCallStep([
                {
                  toolCallId: "continued-call",
                  toolName: "msg-agent__send_message",
                  input: { q: "check prior task" },
                },
              ])
            : textStep("已按新请求核对");
        step += 1;
        return streamChunks(chunks);
      },
    }),
    initialMessages: restoredMessages,
    sources: [sourceUnderTest],
    maxSteps: 4,
    policy: allowToolPolicy,
  });
  const continueEvents = await collect(
    continueSession.send("继续上一任务并检查状态；确认后再决定，不要直接重试。"),
  );

  assert.equal(continuePrompt?.at(-1)?.role, "user");
  assert.match(JSON.stringify(continuePrompt?.at(-1)), /继续上一任务并检查状态/u);
  assert.equal(calls, 1);
  assert.equal(
    continueEvents.some(
      (event) => event.type === "message-finish" && event.text === "已按新请求核对",
    ),
    true,
  );
});

test("AgentSession cancel 保留已完成工具步骤，丢弃未完成的后续输出", async () => {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      if (call === 1) {
        return streamChunks(toolCallStep("echo-agent__echo", { q: "x" }));
      }
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: textStep("不应持久化"),
          initialDelayInMs: 500,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "s6-completed-step",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    onPersist: (messages) => persisted.push([...messages]),
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("run echo")) {
    events.push(event);
    if (event.type === "step-finish" && event.finishReason === "tool-calls") {
      session.cancel();
    }
  }

  const messages = JSON.stringify(session.getMessages());
  assert.match(messages, /result-ok/);
  assert.match(messages, /已停止本轮/);
  assert.doesNotMatch(messages, /不应持久化/);
  assert.equal(persisted.length, 1);
  assert.equal(events.filter((event) => event.type === "turn-cancelled").length, 1);
});

test("已完成只读 Tool 后 Esc 不误报仍在运行或不可撤销操作", async () => {
  const readOnlySource: AgentToolSource = {
    ...source("read-agent", "inspect"),
    tools: [
      {
        tool: {
          name: "inspect",
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: { readOnlyHint: true },
      },
    ],
  };
  const session = new AgentSession({
    id: "read-only-complete-cancel",
    model: sequencedModel([
      toolCallStep("read-agent__inspect", { q: "status" }),
      textStep("不应完成"),
    ]),
    sources: [readOnlySource],
    maxSteps: 4,
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("读取状态")) {
    events.push(event);
    if (event.type === "tool-result" && event.outcome?.kind === "success") {
      session.cancel();
    }
  }

  const cancelled = events.find((event) => event.type === "turn-cancelled");
  assert.ok(cancelled && cancelled.type === "turn-cancelled");
  assert.match(cancelled.message, /已完成进度会保留/u);
  assert.doesNotMatch(cancelled.message, /正在进行|不会自动撤销/u);
});

test("AgentSession cancel 为执行中的 Tool exactly-once 记录 cancelled outcome", async () => {
  let started = false;
  let cancelledByTest = false;
  const session = new AgentSession({
    id: "s6-tool-cancel-ledger",
    model: sequencedModel([
      toolCallStep("slow-agent__slow", { q: "cancel-me" }),
      textStep("不应到达"),
    ]),
    sources: [
      abortableSource("slow-agent", "slow", () => {
        started = true;
        cancelledByTest = session.cancel();
      }),
    ],
    maxSteps: 4,
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("run slow")) {
    events.push(event);
  }

  assert.equal(started, true);
  assert.equal(cancelledByTest, true);
  assert.equal(events.filter((event) => event.type === "turn-cancelled").length, 1);
  const records = session.getToolExecutions({}, true);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record && "input" in record);
  assert.equal(record.toolCallId, "c1");
  assert.equal(record.outcome.kind, "cancelled");
  assert.equal(record.outcome.reason, "user");
  assert.equal(record.outcome.executionState, "outcome_unknown");
  assert.equal(record.input.encoding, "json");
  if (record.input.encoding === "json") {
    assert.deepEqual(record.input.value, { q: "cancel-me" });
  }
});

test("AgentSession Esc 在工具落盘与 step 完成之间仍为下一轮保留完整进度", async () => {
  const persisted: ModelMessage[][] = [];
  const sessionForCancel: { current: AgentSession | undefined } = { current: undefined };
  let cancelRequested = false;
  const resultClient = {
    callTool: async () => ({
      content: [{ type: "text", text: "原始查询已修复" }],
    }),
  } as unknown as Client;
  const resultSource: AgentToolSource = {
    agentName: "query-agent",
    client: resultClient,
    tools: [
      {
        tool: {
          name: "repair",
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: undefined,
      },
    ],
  };
  const firstSession = new AgentSession({
    id: "esc-ledger-step-race",
    model: sequencedModel([toolCallStep("query-agent__repair", { q: "broken SQL" })]),
    sources: [resultSource],
    maxSteps: 4,
    onToolExecution: () => {
      if (!cancelRequested) {
        cancelRequested = sessionForCancel.current?.cancel() ?? false;
      }
    },
    onPersist: (messages) => persisted.push([...messages]),
  });
  sessionForCancel.current = firstSession;

  const firstEvents = await collect(firstSession.send("修复查询"));
  const cancelled = firstEvents.find((event) => event.type === "turn-cancelled");
  assert.ok(cancelled && cancelled.type === "turn-cancelled");
  assert.equal(cancelRequested, true);
  assert.equal(cancelled.reason, "user");
  assert.match(cancelled.message, /已停止本轮操作/u);
  assert.doesNotMatch(cancelled.message, /session|外部副作用|tool result|Exit code/iu);
  assert.equal(persisted.length, 1);

  const publicMessages = JSON.stringify(firstSession.getMessages());
  assert.doesNotMatch(
    publicMessages,
    /roll:hidden|cancelledTurnRecovery|Roll interrupted-turn recovery checkpoint/u,
  );
  assert.match(publicMessages, /已停止本轮操作/u);

  const restoredMessages = JSON.parse(JSON.stringify(persisted[0])) as ModelMessage[];
  let recoveryPrompt = "";
  const restoredSession = new AgentSession({
    id: "esc-ledger-step-race-restored",
    model: new MockLanguageModelV4({
      doStream: async (options) => {
        recoveryPrompt = JSON.stringify(options.prompt);
        return streamChunks(textStep("继续处理"));
      },
    }),
    initialMessages: restoredMessages,
    sources: [resultSource],
    maxSteps: 4,
  });

  assert.doesNotMatch(
    JSON.stringify(restoredSession.getMessages()),
    /roll:hidden|cancelledTurnRecovery|Roll interrupted-turn recovery checkpoint/u,
  );
  const resumedEvents = await collect(restoredSession.send("继续"));
  assert.match(recoveryPrompt, /原始查询已修复/u);
  assert.match(recoveryPrompt, /不要自动重复/u);
  assert.equal(
    resumedEvents.some((event) => event.type === "message-finish" && event.text === "继续处理"),
    true,
  );
});

test("AgentSession cancel 的 Tool ledger 写盘失败时仍回滚并上报取消", async () => {
  let started = false;
  let ledgerCalls = 0;
  const session = new AgentSession({
    id: "s6-tool-cancel-ledger-failure",
    model: sequencedModel([
      toolCallStep("slow-agent__slow", { q: "cancel-me" }),
      textStep("不应到达"),
    ]),
    sources: [
      abortableSource("slow-agent", "slow", () => {
        started = true;
        session.cancel();
      }),
    ],
    maxSteps: 4,
    onToolExecution: () => {
      ledgerCalls += 1;
      throw new Error("ledger full");
    },
  });

  const events = await collect(session.send("run slow"));

  assert.equal(started, true);
  assert.equal(ledgerCalls, 1);
  assert.deepEqual(session.getMessages(), []);
  assert.deepEqual(session.getToolExecutions({}, true), []);
  const cancelled = events.find((event) => event.type === "turn-cancelled");
  assert.ok(cancelled && cancelled.type === "turn-cancelled");
  assert.match(cancelled.message, /未能保存/u);
  assert.doesNotMatch(cancelled.message, /会保留/u);
  const persistenceError = events.find(
    (event): event is Extract<SessionEvent, { type: "error" }> => event.type === "error",
  );
  assert.equal(persistenceError?.stage, "execute");
  assert.match(persistenceError?.message ?? "", /取消工具账本持久化失败: ledger full/u);
});

test("AgentSession turnTimeout 为执行中的 Tool exactly-once 记录 cancelled outcome", async () => {
  const session = new AgentSession({
    id: "s6-tool-timeout-ledger",
    model: sequencedModel([
      toolCallStep("slow-agent__slow", { q: "timeout-me" }),
      textStep("不应到达"),
    ]),
    sources: [abortableSource("slow-agent", "slow")],
    maxSteps: 4,
    turnTimeoutMs: 30,
  });

  const events = await collect(session.send("run slow"));

  const cancelled = events.find((event) => event.type === "turn-cancelled");
  assert.ok(cancelled && cancelled.type === "turn-cancelled");
  assert.equal(cancelled.reason, "timeout");
  const records = session.getToolExecutions({}, true);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record && "input" in record);
  assert.equal(record.toolCallId, "c1");
  assert.equal(record.outcome.kind, "cancelled");
  assert.equal(record.outcome.reason, "timeout");
  assert.equal(record.input.encoding, "json");
  if (record.input.encoding === "json") {
    assert.deepEqual(record.input.value, { q: "timeout-me" });
  }
});

test("AgentSession turnTimeout 显式上报 timeout，不再退化为 aborted", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: textStep("too late"),
        initialDelayInMs: 200,
        chunkDelayInMs: null,
      }),
    }),
  });
  const session = new AgentSession({
    id: "s6-timeout",
    model,
    sources: [],
    maxSteps: 2,
    turnTimeoutMs: 30,
  });

  const events = await collect(session.send("slow"));
  const cancelled = events.find((event) => event.type === "turn-cancelled");
  assert.ok(cancelled && cancelled.type === "turn-cancelled");
  assert.equal(cancelled.reason, "timeout");
  assert.match(cancelled.message, /等待时间过长/);
  assert.doesNotMatch(cancelled.message, /30ms|session|外部副作用/u);
  assert.equal(cancelled.execSessionIds, undefined);
  assert.doesNotMatch(cancelled.message, /roll__exec_list/u);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  const persistedMessage = String(session.getMessages().at(-1)?.content);
  assert.match(persistedMessage, /等待时间过长/);
  assert.doesNotMatch(persistedMessage, /roll__exec_list|30ms|session|外部副作用/u);
});

test("已结束的 exec_command 不会在后续模型超时时误报为仍在运行", async () => {
  const portableProfile: ShellProfile = {
    id: process.platform === "win32" ? "powershell" : "posix",
    toolName: process.platform === "win32" ? "powershell" : "bash",
    supportsSessionExec: true,
    supportsSafeCommandClassification: false,
    waitForTreeKillAfterRootExit: false,
    buildSpawn: (_command, workdir, env) => ({
      file: process.execPath,
      args: ["-e", "process.stdout.write('done')"],
      options: {
        cwd: workdir,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      },
    }),
    classify: () => "unknown",
    killTree: async () => undefined,
    systemPromptHints: () => [],
  };
  let callCount = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      callCount += 1;
      if (callCount === 1) {
        return streamChunks(
          toolCallStep("roll__exec_command", {
            command: "portable-short-fixture",
            yield_time_ms: 3_000,
          }),
        );
      }
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: textStep("too late"),
          initialDelayInMs: 1_000,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const session = new AgentSession({
    id: "completed-exec-before-timeout",
    model,
    sources: [],
    maxSteps: 4,
    turnTimeoutMs: 500,
    policy: allowToolPolicy,
    bashSession: sessionExecSettings(portableProfile),
  });

  try {
    const events = await collect(session.send("run then wait"));
    const completed = events.find(
      (event) =>
        event.type === "tool-result" &&
        event.toolName === "exec_command" &&
        String(event.output).includes("Exit code: 0"),
    );
    assert.ok(completed);
    const cancelled = events.find((event) => event.type === "turn-cancelled");
    assert.ok(cancelled && cancelled.type === "turn-cancelled");
    assert.equal(cancelled.reason, "timeout");
    assert.equal(cancelled.execSessionIds, undefined);
    assert.doesNotMatch(cancelled.message, /仍在运行|任务 #/u);
  } finally {
    await session.close();
  }
});

test("provider 网络超时保持 error，不冒充 turnTimeout", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error("provider request timed out");
    },
  });
  const session = new AgentSession({
    id: "s6-provider-timeout",
    model,
    sources: [],
    maxSteps: 2,
    turnTimeoutMs: 5_000,
  });

  const events = await collect(session.send("provider timeout"));
  assert.equal(
    events.some((event) => event.type === "turn-cancelled"),
    false,
  );
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.message, /provider request timed out/);
});

test(
  "AgentSession cancel 只中断当前 turn 通过 exec_command 触达的 session",
  { skip: process.platform === "win32" },
  async () => {
    const steps: LanguageModelV4StreamPart[][] = [
      toolCallStep("roll__exec_command", { command: "sleep 30", yield_time_ms: 250 }),
      textStep("untouched started"),
    ];
    const session = new AgentSession({
      id: "session-exec-cancel-command",
      model: sequencedModel(steps),
      sources: [],
      maxSteps: 8,
      policy: allowToolPolicy,
      bashSession: sessionExecSettings({
        ...posixProfile,
        killTree: async (pid, intent) => {
          killProcessGroup(pid, intent === "interrupt" ? "SIGINT" : "SIGKILL");
        },
      }),
    });

    try {
      const untouchedEvents = await collect(session.send("start untouched"));
      const untouchedId = sessionIdFromToolResult(untouchedEvents);
      steps.push(
        toolCallStep("roll__exec_command", {
          command: "printf cancel-current; sleep 30",
          yield_time_ms: 30_000,
        }),
        toolCallStep("roll__exec_list", {}),
        textStep("listed"),
      );

      const cancelledEvents: SessionEvent[] = [];
      let cancelRequested = false;
      for await (const event of session.send("start and cancel current")) {
        cancelledEvents.push(event);
        if (
          !cancelRequested &&
          event.type === "tool-output-delta" &&
          event.delta.includes("cancel-current")
        ) {
          cancelRequested = session.cancel();
        }
      }

      assert.equal(cancelRequested, true);
      const cancelled = cancelledEvents.find((event) => event.type === "turn-cancelled");
      assert.ok(cancelled && cancelled.type === "turn-cancelled");
      assert.equal(cancelled.reason, "user");
      assert.equal(cancelled.execSessionIds?.length, 1);
      const cancelledId = cancelled.execSessionIds?.[0];
      assert.ok(cancelledId);
      assert.notEqual(cancelledId, untouchedId);
      assert.doesNotMatch(cancelled.message, /session|外部副作用/u);
      assert.match(cancelled.message, /已停止本轮操作/u);

      const listed = listedExecSessions(await collect(session.send("list sessions")));
      assert.ok(listed.some((item) => item.session_id === untouchedId && item.state === "running"));
      assert.ok(
        listed.some(
          (item) => item.session_id === cancelledId && item.termination_cause === "interrupt",
        ),
      );
    } finally {
      await session.close();
    }
  },
);

test(
  "AgentSession cancel 只中断当前 turn 通过 exec_poll 触达的 session",
  { skip: process.platform === "win32" },
  async () => {
    const steps: LanguageModelV4StreamPart[][] = [
      toolCallStep("roll__exec_command", { command: "sleep 30", yield_time_ms: 250 }),
      textStep("first started"),
      toolCallStep("roll__exec_command", {
        command: "while true; do printf poll-current; sleep 0.1; done",
        yield_time_ms: 250,
      }),
      textStep("second started"),
    ];
    const session = new AgentSession({
      id: "session-exec-cancel-poll",
      model: sequencedModel(steps),
      sources: [],
      maxSteps: 8,
      policy: allowToolPolicy,
      bashSession: sessionExecSettings({
        ...posixProfile,
        killTree: async (pid, intent) => {
          killProcessGroup(pid, intent === "interrupt" ? "SIGINT" : "SIGKILL");
        },
      }),
    });

    try {
      const untouchedId = sessionIdFromToolResult(await collect(session.send("start first")));
      const polledId = sessionIdFromToolResult(await collect(session.send("start second")));
      steps.push(
        toolCallStep("roll__exec_poll", {
          session_id: polledId,
          chars: "",
          yield_time_ms: 5_000,
        }),
        toolCallStep("roll__exec_list", {}),
        textStep("listed"),
      );

      const cancelledEvents: SessionEvent[] = [];
      let cancelRequested = false;
      for await (const event of session.send("poll and cancel second")) {
        cancelledEvents.push(event);
        if (
          !cancelRequested &&
          event.type === "tool-output-delta" &&
          event.delta.includes("poll-current")
        ) {
          cancelRequested = session.cancel();
        }
      }

      assert.equal(cancelRequested, true);
      const cancelled = cancelledEvents.find((event) => event.type === "turn-cancelled");
      assert.ok(cancelled && cancelled.type === "turn-cancelled");
      assert.deepEqual(cancelled.execSessionIds, [polledId]);
      const listed = listedExecSessions(await collect(session.send("list sessions")));
      assert.ok(listed.some((item) => item.session_id === untouchedId && item.state === "running"));
      assert.ok(
        listed.some(
          (item) => item.session_id === polledId && item.termination_cause === "interrupt",
        ),
      );
    } finally {
      await session.close();
    }
  },
);

test("AgentSession cancel 在两次 poll 之间仍中断本轮后台 session", async () => {
  const killIntents: Array<"interrupt" | "terminate"> = [];
  const portableProfile: ShellProfile = {
    id: process.platform === "win32" ? "powershell" : "posix",
    toolName: process.platform === "win32" ? "powershell" : "bash",
    supportsSessionExec: true,
    supportsSafeCommandClassification: false,
    waitForTreeKillAfterRootExit: false,
    buildSpawn: (_command, workdir, env) => ({
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      options: {
        cwd: workdir,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
      },
    }),
    classify: () => "unknown",
    killTree: async (pid, intent) => {
      killIntents.push(intent);
      if (pid === undefined) {
        throw new Error("portable session fixture did not expose a PID");
      }
      process.kill(pid, "SIGKILL");
    },
    systemPromptHints: () => [],
  };
  let modelCall = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCall += 1;
      if (modelCall === 1) {
        return streamChunks(
          toolCallStep("roll__exec_command", {
            command: "portable-long-running-fixture",
            yield_time_ms: 250,
          }),
        );
      }
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: textStep("between-polls"),
          initialDelayInMs: null,
          chunkDelayInMs: 100,
        }),
      };
    },
  });
  const session = new AgentSession({
    id: "session-exec-cancel-between-polls",
    model,
    sources: [],
    maxSteps: 8,
    policy: allowToolPolicy,
    bashSession: sessionExecSettings(portableProfile),
  });

  try {
    const events: SessionEvent[] = [];
    let runningSessionId: number | undefined;
    let cancelRequested = false;
    for await (const event of session.send("start and cancel between polls")) {
      events.push(event);
      if (event.type === "tool-result" && event.toolName === "exec_command") {
        const match = /Session: (\d+) \(running\)/u.exec(JSON.stringify(event.output));
        assert.ok(match?.[1], "exec_command 应先返回 running session id");
        runningSessionId = Number.parseInt(match[1], 10);
      }
      if (
        !cancelRequested &&
        event.type === "text-delta" &&
        event.delta.includes("between-polls")
      ) {
        assert.ok(runningSessionId, "取消前 exec_command 应已完成并返回 running");
        cancelRequested = session.cancel();
      }
    }

    assert.equal(cancelRequested, true);
    assert.ok(runningSessionId);
    const cancelled = events.find((event) => event.type === "turn-cancelled");
    assert.ok(cancelled && cancelled.type === "turn-cancelled");
    assert.equal(cancelled.reason, "user");
    assert.deepEqual(cancelled.execSessionIds, [runningSessionId]);
    assert.deepEqual(killIntents, ["interrupt"]);
    assert.equal(
      events.some(
        (event) =>
          (event.type === "tool-call" || event.type === "tool-result") &&
          event.toolName === "exec_poll",
      ),
      false,
    );
  } finally {
    await session.close();
  }
});

test(
  "AgentSession timeout 保留后台 session，并在取消事件与持久消息中暴露恢复 id",
  { skip: process.platform === "win32" },
  async () => {
    let dynamicResolution = 0;
    const steps: LanguageModelV4StreamPart[][] = [
      toolCallStep("roll__exec_command", { command: "sleep 30", yield_time_ms: 30_000 }),
      toolCallStep("roll__exec_list", {}),
      textStep("listed"),
    ];
    const session = new AgentSession({
      id: "session-exec-timeout",
      model: sequencedModel(steps),
      sources: [],
      maxSteps: 8,
      turnTimeoutMs: 500,
      capabilityContext: {
        profile: "bash",
        hostMode: "interactive",
        cwd: process.cwd(),
        platform: process.platform,
        agentCount: 0,
      },
      resolveDynamicCapabilityContext: () => {
        dynamicResolution += 1;
        return { ruleIds: [`tenant/rules-v${String(dynamicResolution)}`] };
      },
      policy: allowToolPolicy,
      bashSession: sessionExecSettings({
        ...posixProfile,
        killTree: async (pid, intent) => {
          killProcessGroup(pid, intent === "interrupt" ? "SIGINT" : "SIGKILL");
        },
      }),
    });
    const stableManifest = JSON.stringify(session.getCapabilityManifest());

    try {
      const timeoutEvents = await collect(session.send("start beyond turn timeout"));
      const firstContext = session.getCapabilityTurnContext();
      const cancelled = timeoutEvents.find((event) => event.type === "turn-cancelled");
      assert.ok(cancelled && cancelled.type === "turn-cancelled");
      assert.equal(cancelled.reason, "timeout");
      assert.equal(cancelled.execSessionIds?.length, 1);
      const sessionId = cancelled.execSessionIds?.[0];
      assert.ok(sessionId);
      const sessionListToolId = session
        .getCapabilityManifest()
        .tools.find((tool) => tool.role === "session-list")?.id;
      assert.ok(sessionListToolId);
      assert.match(cancelled.message, new RegExp(`任务 #${String(sessionId)}`, "u"));
      assert.doesNotMatch(cancelled.message, new RegExp(sessionListToolId, "u"));
      assert.match(cancelled.message, /下一条消息/u);
      assert.deepEqual(firstContext?.dynamic.ruleIds, ["tenant/rules-v1"]);
      assert.deepEqual(firstContext?.dynamic.sessions, []);

      const listed = listedExecSessions(await collect(session.send("recover session")));
      const secondContext = session.getCapabilityTurnContext();
      assert.ok(listed.some((item) => item.session_id === sessionId && item.state === "running"));
      assert.deepEqual(secondContext?.dynamic.ruleIds, ["tenant/rules-v2"]);
      assert.ok(
        secondContext?.dynamic.sessions.some(
          (item) => item.sessionId === sessionId && item.state === "running",
        ),
      );
      assert.equal(JSON.stringify(session.getCapabilityManifest()), stableManifest);
    } finally {
      await session.close();
    }
  },
);

test(
  "AgentSession one-shot timeout 不宣称后台 session 可跨进程恢复",
  { skip: process.platform === "win32" },
  async () => {
    const session = new AgentSession({
      id: "session-exec-timeout-one-shot",
      model: sequencedModel([
        toolCallStep("roll__exec_command", { command: "sleep 30", yield_time_ms: 30_000 }),
      ]),
      sources: [],
      maxSteps: 4,
      turnTimeoutMs: 500,
      capabilityContext: {
        profile: "bash",
        hostMode: "one-shot",
        cwd: process.cwd(),
        platform: process.platform,
        agentCount: 0,
      },
      policy: allowToolPolicy,
      bashSession: sessionExecSettings({
        ...posixProfile,
        killTree: async (pid, intent) => {
          killProcessGroup(pid, intent === "interrupt" ? "SIGINT" : "SIGKILL");
        },
      }),
    });

    try {
      const manifest = session.getCapabilityManifest();
      assert.equal(manifest.lifecycle.hostMode, "one-shot");
      assert.equal(manifest.lifecycle.sessionDurability, "process-local");
      const events = await collect(session.send("start in one shot"));
      const cancelled = events.find((event) => event.type === "turn-cancelled");
      assert.ok(cancelled && cancelled.type === "turn-cancelled");
      assert.match(cancelled.message, /本次命令结束/u);
      assert.match(cancelled.message, /之后无法继续查看/u);
      assert.doesNotMatch(cancelled.message, /one-shot|session|roll__exec_list/u);
    } finally {
      await session.close();
    }
  },
);

test(
  "AgentSession.close 幂等且等待后台 session cleanup 完成",
  { skip: process.platform === "win32" },
  async () => {
    const killStarted = Promise.withResolvers<void>();
    const releaseKill = Promise.withResolvers<void>();
    let killCalls = 0;
    const profile: ShellProfile = {
      ...posixProfile,
      killTree: async (pid) => {
        killCalls += 1;
        killStarted.resolve();
        await releaseKill.promise;
        killProcessGroup(pid, "SIGKILL");
      },
    };
    const session = new AgentSession({
      id: "session-close-idempotent",
      model: sequencedModel([
        toolCallStep("roll__exec_command", { command: "sleep 30", yield_time_ms: 250 }),
        textStep("started"),
      ]),
      sources: [],
      maxSteps: 8,
      policy: allowToolPolicy,
      bashSession: sessionExecSettings(profile),
    });

    try {
      await collect(session.send("start background"));
      let firstSettled = false;
      const firstClose = session.close();
      firstClose.then(
        () => {
          firstSettled = true;
        },
        () => {
          firstSettled = true;
        },
      );
      const secondClose = session.close();

      await killStarted.promise;
      await Promise.resolve();
      assert.equal(firstSettled, false);
      assert.equal(killCalls, 1);

      releaseKill.resolve();
      await Promise.all([firstClose, secondClose]);
      await session.close();
      assert.equal(killCalls, 1);
    } finally {
      releaseKill.resolve();
      await session.close();
    }
  },
);

test("AgentSession.close 不被忽略 abort 的 provider 阻塞，迟到轮不再持久化", async () => {
  const streamStarted = Promise.withResolvers<void>();
  const releaseStream = Promise.withResolvers<void>();
  const persisted: ModelMessage[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      streamStarted.resolve();
      await releaseStream.promise;
      return streamChunks(textStep("迟到回复"));
    },
  });
  const session = new AgentSession({
    id: "session-close-ignored-abort",
    model,
    sources: [],
    maxSteps: 2,
    onPersist: (messages) => persisted.push([...messages]),
  });
  const collecting = collect(session.send("启动迟到请求"));

  await streamStarted.promise;
  const startedAt = performance.now();
  await session.close();
  assert.ok(performance.now() - startedAt < 1_000, "close 不应等待忽略 abort 的 provider");

  releaseStream.resolve();
  await collecting;
  assert.deepEqual(persisted, []);
  assert.deepEqual(session.getMessages(), []);
});

test("AgentSession 超阈值自动压缩(reactive,truncate)并回调 onReplace", async () => {
  const model = sequencedModel([textStep("a"), textStep("b"), textStep("c")]);
  let replaced: number | undefined;
  const session = new AgentSession({
    id: "c1",
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 1,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onReplace: (messages) => {
      replaced = messages.length;
    },
  });

  await collect(session.send("t1"));
  await collect(session.send("t2"));
  const events = await collect(session.send("t3"));

  const compacted = events.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "auto");
  assert.equal(compacted.strategy, "truncate");
  assert.equal(compacted.removed, 2);
  assert.equal(compacted.beforeInputTokens, 1);
  assert.equal(replaced, 2);
  assert.equal(events.at(-1)?.type, "message-finish");
});

test("AgentSession 从历史恢复且尚无实测 usage 时,首轮按估算触发自动压缩", async () => {
  const model = sequencedModel([textStep("after", 1)]);
  const longAnswer = "answer-".repeat(40);
  const initialMessages: ModelMessage[] = [];
  for (let index = 1; index <= 6; index += 1) {
    initialMessages.push({ role: "user", content: `old-${String(index)}` });
    initialMessages.push({ role: "assistant", content: `${String(index)}:${longAnswer}` });
  }
  const session = new AgentSession({
    id: "c1-resume-pressure",
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 300,
    initialMessages,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 2,
      keepRecentTokens: 100_000,
    },
  });

  const events = await collect(session.send("resume me"));
  const compacted = events.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "auto");
  assert.equal(compacted.beforeInputTokens, undefined);
  assert.ok(compacted.removed >= 8, `removed ${String(compacted.removed)}`);
  assert.equal(events.at(-1)?.type, "message-finish");
});

test("AgentSession 轮内步骤后上下文压力超阈值时暂停、压缩并在同一个 send 内自动续跑", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    textStep("continued", 40),
  ]);
  const session = new AgentSession({
    id: "c1-mid-turn-pressure",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 200,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const events = await collect(session.send("tool loop"));
  const finishes = events.filter((event) => event.type === "message-finish");
  assert.equal(finishes.length, 2);
  const compacted = events.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "auto");
  assert.ok(compacted.removed >= 4, `removed ${String(compacted.removed)}`);
  const compactedIndex = events.indexOf(compacted);
  const firstFinishIndex = events.indexOf(finishes[0] as SessionEvent);
  assert.ok(compactedIndex > firstFinishIndex);
  const lastFinish = finishes.at(-1);
  assert.ok(lastFinish && lastFinish.type === "message-finish");
  assert.equal(lastFinish.text, "continued");
  assert.equal(events.at(-1)?.type, "message-finish");
  const modelCalls = model.doStreamCalls;
  assert.equal(modelCalls.length, 2);
  const secondPrompt = modelCalls[1]?.prompt ?? [];
  assert.equal(secondPrompt.at(-1)?.role, "tool");
  assert.equal(secondPrompt.filter((message) => message.role === "user").length, 1);
});

test("AgentSession 轮内多步超压时在同一 send 内压缩并续跑完成本轮", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    toolCallStep("echo-agent__echo", { q: "y" }, 180),
    textStep("finished", 190),
  ]);
  const session = new AgentSession({
    id: "c1-mid-turn-pressure-noop",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 200,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const events = await collect(session.send("tool loop"));
  const compactions = events.filter((event) => event.type === "context-compacted");
  assert.ok(compactions.length >= 1);
  const finishes = events.filter(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(finishes.length, 2);
  assert.equal(finishes.at(-1)?.text, "finished");
  assert.equal(events.at(-1)?.type, "message-finish");
  assert.equal(model.doStreamCalls.length, 3);
});

function bigResultSource(agentName: string, toolName: string, chars: number): AgentToolSource {
  const client = {
    callTool: async () => ({ content: [{ type: "text", text: "r".repeat(chars) }] }),
  } as unknown as Client;
  return {
    agentName,
    client,
    tools: [
      {
        tool: {
          name: toolName,
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: undefined,
      },
    ],
  };
}

test("AgentSession 仅靠工具结果把压力推过线时,暂停后仍会尝试压缩再续跑", async () => {
  const model = sequencedModel([
    toolCallStep("big-agent__read", { q: "x" }, 130),
    textStep("continued", 40),
  ]);
  const session = new AgentSession({
    id: "c1-tool-result-pressure",
    model,
    sources: [bigResultSource("big-agent", "read", 5000)],
    maxSteps: 8,
    contextWindow: 200,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const events = await collect(session.send("read it"));
  const compacted = events.filter((event) => event.type === "context-compacted");
  assert.ok(compacted.length >= 1, "pause must at least attempt compaction");
  const finishes = events.filter((event) => event.type === "message-finish");
  assert.equal(finishes.length, 2);
  assert.equal(events.at(-1)?.type, "message-finish");
  assert.equal(model.doStreamCalls.length, 2);
});

test("AgentSession 轮内暂停后压缩报错:已持久化的前半段不回滚,并以 error 事件收尾", async () => {
  const steps = [toolCallStep("echo-agent__echo", { q: "x" }, 170), textStep("never", 40)];
  let index = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
    doGenerate: async () => {
      throw new Error("draft provider exploded");
    },
  });
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "c1-mid-turn-compaction-error",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 200,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
  });

  const events = await collect(session.send("tool loop"));
  assert.equal(events.filter((event) => event.type === "message-finish").length, 1);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(persisted.length, 1);
  const firstSegment = persisted[0] ?? [];
  assert.equal(firstSegment[0]?.role, "user");
  const inMemory = session.getMessages();
  assert.equal(inMemory.length, 4 + firstSegment.length);
  assert.equal(inMemory.at(-1)?.role, "tool");
  assert.equal(model.doStreamCalls.length, 1);
});

test("AgentSession 轮内压缩期间被取消时发出 turn-cancelled 而不是静默结束", async () => {
  const steps = [toolCallStep("echo-agent__echo", { q: "x" }, 170), textStep("never", 40)];
  let index = 0;
  const holder: { session?: AgentSession } = {};
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
    doGenerate: async () => {
      holder.session?.cancel();
      throw new Error("aborted while drafting");
    },
  });
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "c1-mid-turn-compaction-cancel",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 200,
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });
  holder.session = session;

  const events = await collect(session.send("tool loop"));
  assert.ok(events.some((event) => event.type === "turn-cancelled"));
  assert.equal(events.filter((event) => event.type === "message-finish").length, 1);
  assert.equal(model.doStreamCalls.length, 1);
  const marker = session.getMessages().at(-1);
  assert.equal(marker?.role, "assistant");
  assert.match(JSON.stringify(marker), /已停止本轮|取消/u);
  assert.doesNotMatch(JSON.stringify(marker), /未能保存/u);
  const persistedTail = persisted.at(-1) ?? [];
  assert.equal(persistedTail.length, 2);
  assert.match(JSON.stringify(persistedTail[0]), /roll-recovery/u);
});

test("AgentSession 续跑共享 runtime.max-steps 预算,不会绕过单轮步骤上限", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    toolCallStep("echo-agent__echo", { q: "y" }, 60),
    textStep("never", 60),
  ]);
  const session = new AgentSession({
    id: "c1-continuation-step-budget",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 2,
    contextWindow: 200,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const events = await collect(session.send("tool loop"));
  const finishes = events.filter(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(finishes.length, 2);
  assert.equal(finishes.at(-1)?.stoppedAtStepLimit, true);
  assert.equal(model.doStreamCalls.length, 2);
});

test("AgentSession 首步就超压但没有任何可压缩内容时不暂停,同一 stream 内继续", async () => {
  const model = sequencedModel([
    toolCallStep("big-agent__read", { q: "x" }, 130),
    textStep("continued", 40),
  ]);
  const session = new AgentSession({
    id: "c1-nothing-to-compact-no-pause",
    model,
    sources: [bigResultSource("big-agent", "read", 5000)],
    maxSteps: 8,
    contextWindow: 200,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const events = await collect(session.send("read it"));
  assert.equal(events.filter((event) => event.type === "context-compacted").length, 0);
  assert.equal(events.filter((event) => event.type === "message-finish").length, 1);
  assert.equal(events.filter((event) => event.type === "message-start").length, 1);
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(events.at(-1)?.type, "message-finish");
});

test("AgentSession 工具步骤完成后第二次模型调用失败时保留已完成步骤并写入失败恢复记录", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }),
    streamErrorStep("ECONNRESET"),
    textStep("ok"),
  ]);
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "c1-second-call-failure-keeps-steps",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 4,
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
  });

  const events = await collect(session.send("tool loop"));
  const last = events.at(-1);
  assert.equal(last?.type, "error");
  assert.match(last?.type === "error" ? last.message : "", /ECONNRESET/u);
  assert.equal(model.doStreamCalls.length, 2);

  const messages = session.getMessages();
  assert.equal(messages[0]?.role, "user");
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /"toolCallId":"c1"/u);
  assert.match(serialized, /result-ok/u);
  const marker = messages.at(-1);
  assert.equal(marker?.role, "assistant");
  assert.match(JSON.stringify(marker), /失败|中断/u);
  assert.match(JSON.stringify(marker), /不会自动撤销|请先检查/u);
  const persistedTail = JSON.stringify(persisted.at(-1) ?? []);
  assert.match(persistedTail, /result-ok/u);
  assert.match(persistedTail, /roll-recovery/u);

  await collect(session.send("继续"));
  assert.equal(model.doStreamCalls.length, 3);
  const nextPrompt = JSON.stringify(model.doStreamCalls[2]?.prompt ?? []);
  assert.match(nextPrompt, /result-ok/u);
  assert.match(nextPrompt, /roll__interrupted_turn_recovery/u);
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const PRESSURE_CONTINUATION_SESSION = {
  maxSteps: 8,
  contextWindow: 200,
  initialMessages: [
    { role: "user", content: "old-1" },
    { role: "assistant", content: "answer-1" },
    { role: "user", content: "old-2" },
    { role: "assistant", content: "answer-2" },
  ] satisfies ModelMessage[],
  compaction: {
    enabled: true,
    strategy: "truncate",
    threshold: 0.75,
    keepRecentTurns: 1,
    keepRecentTokens: 1,
  },
} as const;

function assertTurnRecordedExactlyOnce(
  label: string,
  serialized: string,
  expected: { readonly user: number; readonly toolCallIds: number },
): void {
  assert.equal(countOccurrences(serialized, "tool loop"), expected.user, `${label}: user`);
  assert.equal(
    countOccurrences(serialized, '"toolCallId":"c1"'),
    expected.toolCallIds,
    `${label}: c1`,
  );
}

function assertPromptHasNoDuplicateTurnRecords(
  prompt: LanguageModelV4CallOptions["prompt"] | undefined,
  toolCallIds: readonly string[],
): void {
  const messages = prompt ?? [];
  const userTurns = messages.filter(
    (message) =>
      message.role === "user" &&
      message.content.some((part) => part.type === "text" && part.text === "tool loop"),
  );
  assert.equal(userTurns.length, 1, "next prompt: user");
  const parts: Array<{ readonly type: string; readonly toolCallId?: string }> = [];
  for (const message of messages) {
    if (typeof message.content !== "string") {
      parts.push(...message.content);
    }
  }
  for (const toolCallId of toolCallIds) {
    const calls = parts.filter(
      (part) => part.type === "tool-call" && part.toolCallId === toolCallId,
    );
    const results = parts.filter(
      (part) => part.type === "tool-result" && part.toolCallId === toolCallId,
    );
    assert.ok(calls.length <= 1, `next prompt: tool-call ${toolCallId} duplicated`);
    assert.equal(calls.length, results.length, `next prompt: ${toolCallId} call/result pairing`);
  }
}

function assertPromptRecordsTurnOnce(
  prompt: LanguageModelV4CallOptions["prompt"] | undefined,
): void {
  const messages = prompt ?? [];
  const userTurns = messages.filter(
    (message) =>
      message.role === "user" &&
      message.content.some((part) => part.type === "text" && part.text === "tool loop"),
  );
  const parts: Array<{ readonly type: string; readonly toolCallId?: string }> = [];
  for (const message of messages) {
    if (typeof message.content !== "string") {
      parts.push(...message.content);
    }
  }
  assert.equal(userTurns.length, 1, "next prompt: user");
  assert.equal(
    parts.filter((part) => part.type === "tool-call" && part.toolCallId === "c1").length,
    1,
    "next prompt: tool-call c1",
  );
  assert.equal(
    parts.filter((part) => part.type === "tool-result" && part.toolCallId === "c1").length,
    1,
    "next prompt: tool-result c1",
  );
}

test("AgentSession 压力续跑中模型调用失败时不会重复已落盘的 user 与工具步骤", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    streamErrorStep("ECONNRESET"),
    textStep("ok", 40),
  ]);
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "c1-continuation-failure-exactly-once",
    model,
    sources: [source("echo-agent", "echo")],
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
    ...PRESSURE_CONTINUATION_SESSION,
  });

  const events = await collect(session.send("tool loop"));
  assert.equal(events.at(-1)?.type, "error");
  assert.ok(events.some((event) => event.type === "context-compacted"));
  assert.equal(model.doStreamCalls.length, 2);
  assertTurnRecordedExactlyOnce("durable", JSON.stringify(persisted.flat()), {
    user: 1,
    toolCallIds: 2,
  });
  assertTurnRecordedExactlyOnce("active", JSON.stringify(session.getMessages()), {
    user: 1,
    toolCallIds: 2,
  });
  assert.equal(session.getToolExecutions().length, 1);
  assert.match(JSON.stringify(persisted.at(-1) ?? []), /roll-recovery/u);

  await collect(session.send("继续"));
  assertPromptRecordsTurnOnce(model.doStreamCalls.at(-1)?.prompt);
});

test("AgentSession 压力续跑中被取消时不会重复已落盘的 user 与工具步骤", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls += 1;
      if (calls === 1) {
        return streamChunks(toolCallStep("echo-agent__echo", { q: "x" }, 170));
      }
      if (calls === 2) {
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              const signal = options.abortSignal;
              if (signal?.aborted) {
                controller.error(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => {
                controller.error(signal.reason);
              });
            },
          }),
        };
      }
      return streamChunks(textStep("ok", 40));
    },
  });
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "c1-continuation-cancel-exactly-once",
    model,
    sources: [source("echo-agent", "echo")],
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
    ...PRESSURE_CONTINUATION_SESSION,
  });

  const events: SessionEvent[] = [];
  let starts = 0;
  for await (const event of session.send("tool loop")) {
    events.push(event);
    if (event.type === "message-start") {
      starts += 1;
      if (starts === 2) {
        session.cancel();
      }
    }
  }
  assert.equal(events.at(-1)?.type, "turn-cancelled");
  assert.equal(calls, 2);
  assertTurnRecordedExactlyOnce("durable", JSON.stringify(persisted.flat()), {
    user: 1,
    toolCallIds: 2,
  });
  assertTurnRecordedExactlyOnce("active", JSON.stringify(session.getMessages()), {
    user: 1,
    toolCallIds: 2,
  });
  assert.equal(session.getToolExecutions().length, 1);

  await collect(session.send("继续"));
  assertPromptRecordsTurnOnce(model.doStreamCalls.at(-1)?.prompt);
});

test("AgentSession 压力续跑中上下文溢出时不会重复已落盘的 user", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    streamErrorStep("context_length_exceeded"),
    streamErrorStep("context_length_exceeded"),
  ]);
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "c1-continuation-overflow-exactly-once",
    model,
    sources: [source("echo-agent", "echo")],
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
    ...PRESSURE_CONTINUATION_SESSION,
  });

  const events = await collect(session.send("tool loop"));
  assert.equal(events.at(-1)?.type, "error");
  assertTurnRecordedExactlyOnce("durable", JSON.stringify(persisted.flat()), {
    user: 1,
    toolCallIds: 2,
  });
  assertTurnRecordedExactlyOnce("active", JSON.stringify(session.getMessages()), {
    user: 1,
    toolCallIds: 2,
  });
  assert.equal(session.getToolExecutions().length, 1);
});

test("AgentSession 压力续跑中溢出且在恢复压缩期间被取消时不会重复已落盘的 user", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    streamErrorStep("context_length_exceeded"),
  ]);
  const persisted: ModelMessage[][] = [];
  const ledger: ToolExecutionRecord[] = [];
  const holder: { session?: AgentSession } = {};
  let cancelled = false;
  const session = new AgentSession({
    id: "c1-continuation-overflow-cancel-exactly-once",
    model,
    sources: [source("echo-agent", "echo")],
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
    onToolExecution: (record) => {
      ledger.push(record);
    },
    listToolExecutions: (options) => {
      if (model.doStreamCalls.length >= 2 && !cancelled) {
        cancelled = true;
        holder.session?.cancel();
      }
      return ledger
        .map((record, sequence) => ({ ...record, sequence }))
        .filter((record) => record.sequence > (options?.afterSequence ?? -1))
        .slice(0, options?.limit ?? 100);
    },
    ...PRESSURE_CONTINUATION_SESSION,
  });
  holder.session = session;

  const events = await collect(session.send("tool loop"));
  assert.equal(cancelled, true);
  assert.equal(events.at(-1)?.type, "turn-cancelled");
  assertTurnRecordedExactlyOnce("durable", JSON.stringify(persisted.flat()), {
    user: 1,
    toolCallIds: 2,
  });
  assertTurnRecordedExactlyOnce("active", JSON.stringify(session.getMessages()), {
    user: 1,
    toolCallIds: 2,
  });
  assert.equal(session.getToolExecutions().length, 1);
});

test("AgentSession 续跑中完成新工具步骤后溢出并在恢复压缩期间被取消时,新步骤只进账本与恢复证据,不写回 raw", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    multiToolCallStep([{ toolCallId: "c2", toolName: "echo-agent__echo", input: { q: "y" } }]),
    streamErrorStep("context_length_exceeded"),
    textStep("ok"),
  ]);
  const persisted: ModelMessage[][] = [];
  const ledger: ToolExecutionRecord[] = [];
  const holder: { session?: AgentSession } = {};
  let cancelled = false;
  const session = new AgentSession({
    id: "c2-continuation-overflow-cancel-ledger-only",
    model,
    sources: [source("echo-agent", "echo")],
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
    onToolExecution: (record) => {
      ledger.push(record);
    },
    listToolExecutions: (options) => {
      if (model.doStreamCalls.length >= 3 && !cancelled) {
        cancelled = true;
        holder.session?.cancel();
      }
      return ledger
        .map((record, sequence) => ({ ...record, sequence }))
        .filter((record) => record.sequence > (options?.afterSequence ?? -1))
        .slice(0, options?.limit ?? 100);
    },
    ...PRESSURE_CONTINUATION_SESSION,
  });
  holder.session = session;

  const events = await collect(session.send("tool loop"));
  assert.equal(cancelled, true);
  assert.equal(events.at(-1)?.type, "turn-cancelled");
  assert.equal(model.doStreamCalls.length, 3);
  const durable = JSON.stringify(persisted.flat());
  assertTurnRecordedExactlyOnce("durable", durable, { user: 1, toolCallIds: 2 });
  assert.equal(countOccurrences(durable, '"toolCallId":"c2"'), 0, "durable: c2 raw");
  const active = JSON.stringify(session.getMessages());
  assertTurnRecordedExactlyOnce("active", active, { user: 1, toolCallIds: 2 });
  assert.equal(countOccurrences(active, '"toolCallId":"c2"'), 0, "active: c2 raw");
  assert.deepEqual(
    session.getToolExecutions().map((record) => record.toolCallId),
    ["c1", "c2"],
  );
  const recovery = (persisted.at(-1) ?? [])
    .map((message) => readCancelledTurnRecoveryCheckpoint(message))
    .find((checkpoint) => checkpoint !== undefined);
  assert.ok(recovery, "recovery record persisted");
  const payload = JSON.parse(
    recovery.modelContext.slice(recovery.modelContext.lastIndexOf("\n") + 1),
  ) as {
    readonly evidence: ReadonlyArray<{ readonly agentName: string; readonly toolName: string }>;
  };
  assert.deepEqual(
    payload.evidence.map((entry) => `${entry.agentName}/${entry.toolName}`),
    ["echo-agent/echo"],
  );

  await collect(session.send("继续"));
  assertPromptRecordsTurnOnce(model.doStreamCalls.at(-1)?.prompt);
  assert.equal(
    countOccurrences(JSON.stringify(model.doStreamCalls.at(-1)?.prompt), '"toolCallId":"c2"'),
    0,
    "next prompt: c2 raw",
  );
});

test("AgentSession 续跑中复用同一 toolCallId 再次执行后溢出并在恢复压缩期间被取消时,第二次执行进入恢复证据", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    multiToolCallStep([{ toolCallId: "c1", toolName: "echo-agent__echo", input: { q: "again" } }]),
    streamErrorStep("context_length_exceeded"),
    textStep("ok"),
  ]);
  const persisted: ModelMessage[][] = [];
  const ledger: ToolExecutionRecord[] = [];
  const holder: { session?: AgentSession } = {};
  let cancelled = false;
  const session = new AgentSession({
    id: "shared-id-continuation-overflow-cancel",
    model,
    sources: [source("echo-agent", "echo")],
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
    onToolExecution: (record) => {
      ledger.push(record);
    },
    listToolExecutions: (options) => {
      if (model.doStreamCalls.length >= 3 && !cancelled) {
        cancelled = true;
        holder.session?.cancel();
      }
      return ledger
        .map((record, sequence) => ({ ...record, sequence }))
        .filter((record) => record.sequence > (options?.afterSequence ?? -1))
        .slice(0, options?.limit ?? 100);
    },
    ...PRESSURE_CONTINUATION_SESSION,
  });
  holder.session = session;

  const events = await collect(session.send("tool loop"));
  assert.equal(cancelled, true);
  assert.equal(events.at(-1)?.type, "turn-cancelled");
  assertTurnRecordedExactlyOnce("durable", JSON.stringify(persisted.flat()), {
    user: 1,
    toolCallIds: 2,
  });
  assertTurnRecordedExactlyOnce("active", JSON.stringify(session.getMessages()), {
    user: 1,
    toolCallIds: 2,
  });
  assert.deepEqual(
    session.getToolExecutions().map((record) => record.toolCallId),
    ["c1", "c1"],
  );
  const recovery = (persisted.at(-1) ?? [])
    .map((message) => readCancelledTurnRecoveryCheckpoint(message))
    .find((checkpoint) => checkpoint !== undefined);
  assert.ok(recovery, "recovery record persisted");
  const payload = JSON.parse(
    recovery.modelContext.slice(recovery.modelContext.lastIndexOf("\n") + 1),
  ) as {
    readonly evidence: ReadonlyArray<{ readonly agentName: string; readonly toolName: string }>;
  };
  assert.deepEqual(
    payload.evidence.map((entry) => `${entry.agentName}/${entry.toolName}`),
    ["echo-agent/echo"],
  );

  await collect(session.send("继续"));
  assertPromptRecordsTurnOnce(model.doStreamCalls.at(-1)?.prompt);
  assert.match(
    JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
    /roll__interrupted_turn_recovery/u,
  );
});

test("AgentSession 首段执行工具后溢出并在恢复压缩期间被取消时,工具步骤只进账本与恢复证据,不写回 raw", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }),
    streamErrorStep("context_length_exceeded"),
    textStep("ok"),
  ]);
  const persisted: ModelMessage[][] = [];
  const ledger: ToolExecutionRecord[] = [];
  const holder: { session?: AgentSession } = {};
  let cancelled = false;
  const session = new AgentSession({
    id: "c1-first-segment-overflow-cancel-ledger-only",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 4,
    contextWindow: 200,
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
    onToolExecution: (record) => {
      ledger.push(record);
    },
    listToolExecutions: (options) => {
      if (!cancelled) {
        cancelled = true;
        holder.session?.cancel();
      }
      return ledger
        .map((record, sequence) => ({ ...record, sequence }))
        .filter((record) => record.sequence > (options?.afterSequence ?? -1))
        .slice(0, options?.limit ?? 100);
    },
    compaction: PRESSURE_CONTINUATION_SESSION.compaction,
  });
  holder.session = session;

  const events = await collect(session.send("tool loop"));
  assert.equal(cancelled, true);
  assert.equal(events.at(-1)?.type, "turn-cancelled");
  const durable = JSON.stringify(persisted.flat());
  assertTurnRecordedExactlyOnce("durable", durable, { user: 1, toolCallIds: 0 });
  assertTurnRecordedExactlyOnce("active", JSON.stringify(session.getMessages()), {
    user: 1,
    toolCallIds: 0,
  });
  assert.deepEqual(
    session.getToolExecutions().map((record) => record.toolCallId),
    ["c1"],
  );
  const recovery = (persisted.at(-1) ?? [])
    .map((message) => readCancelledTurnRecoveryCheckpoint(message))
    .find((checkpoint) => checkpoint !== undefined);
  assert.ok(recovery, "recovery record persisted");
  assert.match(recovery.modelContext, /"agentName":"echo-agent"/u);

  await collect(session.send("继续"));
  const nextPrompt = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
  assert.equal(countOccurrences(nextPrompt, '"toolCallId":"c1"'), 0, "next prompt: c1 raw");
  assert.match(nextPrompt, /roll__interrupted_turn_recovery/u);
});

for (const interruption of ["error", "cancel"] as const) {
  test(`AgentSession 续跑中完成新工具步骤后遇到 ${interruption} 时,新步骤恰好落盘一次且不重复首段`, async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        if (calls === 1) {
          return streamChunks(toolCallStep("echo-agent__echo", { q: "x" }, 170));
        }
        if (calls === 2) {
          return streamChunks(
            multiToolCallStep([
              { toolCallId: "c2", toolName: "echo-agent__echo", input: { q: "y" } },
            ]),
          );
        }
        if (calls === 3) {
          if (interruption === "error") {
            return streamChunks(streamErrorStep("ECONNRESET"));
          }
          return {
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                const signal = options.abortSignal;
                if (signal?.aborted) {
                  controller.error(signal.reason);
                  return;
                }
                signal?.addEventListener("abort", () => {
                  controller.error(signal.reason);
                });
              },
            }),
          };
        }
        return streamChunks(textStep("ok", 40));
      },
    });
    const persisted: ModelMessage[][] = [];
    const session = new AgentSession({
      id: `c2-continuation-${interruption}-exactly-once`,
      model,
      sources: [source("echo-agent", "echo")],
      onPersist: (messages) => {
        persisted.push([...messages]);
      },
      ...PRESSURE_CONTINUATION_SESSION,
    });

    const events: SessionEvent[] = [];
    let toolResults = 0;
    for await (const event of session.send("tool loop")) {
      events.push(event);
      if (event.type === "tool-result") {
        toolResults += 1;
        if (toolResults === 2 && interruption === "cancel") {
          session.cancel();
        }
      }
    }
    assert.equal(events.at(-1)?.type, interruption === "error" ? "error" : "turn-cancelled");
    assert.equal(calls, 3);
    for (const [label, serialized] of [
      ["durable", JSON.stringify(persisted.flat())],
      ["active", JSON.stringify(session.getMessages())],
    ] as const) {
      assertTurnRecordedExactlyOnce(label, serialized, { user: 1, toolCallIds: 2 });
      assert.equal(countOccurrences(serialized, '"toolCallId":"c2"'), 2, `${label}: c2`);
    }
    assert.deepEqual(
      session.getToolExecutions().map((record) => record.toolCallId),
      ["c1", "c2"],
    );

    const nextEvents = await collect(session.send("继续"));
    assert.ok(nextEvents.some((event) => event.type === "context-compacted"));
    const prompt = model.doStreamCalls.at(-1)?.prompt;
    assertPromptHasNoDuplicateTurnRecords(prompt, ["c1", "c2"]);
    assert.equal(
      countOccurrences(JSON.stringify(prompt), '"toolCallId":"c2"'),
      2,
      "next prompt: c2",
    );
  });
}

test("AgentSession 模型流在宣告工具调用后、调用结束前中断时,未执行的调用以 not_executed 进账本与失败恢复记录", async () => {
  let toolCalls = 0;
  const model = sequencedModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo-agent__echo",
        input: JSON.stringify({ q: "x" }),
      },
      { type: "error", error: "ECONNRESET" },
    ],
    textStep("ok"),
  ]);
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "c1-announced-tool-stream-error",
    model,
    sources: [
      source("echo-agent", "echo", () => {
        toolCalls += 1;
      }),
    ],
    maxSteps: 4,
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
  });

  const events = await collect(session.send("tool loop"));
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(toolCalls, 0);
  const executions = session.getToolExecutions();
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.toolCallId, "c1");
  assert.equal(executions[0]?.outcome.kind, "cancelled");
  assert.match(JSON.stringify(executions[0]?.outcome), /not_executed/u);
  const tail = persisted.at(-1) ?? [];
  const recovery = tail
    .map((message) => readCancelledTurnRecoveryCheckpoint(message))
    .find((checkpoint) => checkpoint !== undefined);
  assert.ok(recovery, "recovery record persisted");
  assert.match(recovery.modelContext, /"agentName":"echo-agent"/u);
  assert.match(recovery.modelContext, /"executionState":"not_executed"/u);
  assert.match(JSON.stringify(tail.at(-1)), /继续输入或重试/u);
  assert.equal(countOccurrences(JSON.stringify(session.getMessages()), '"toolCallId":"c1"'), 0);

  await collect(session.send("继续"));
  const nextPrompt = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
  assert.match(nextPrompt, /roll__interrupted_turn_recovery/u);
  assert.match(nextPrompt, /not_executed/u);
});

test("AgentSession 同 ID 新调用只宣告便上下文溢出时,以 not_executed 进账本与 bounded recovery", async () => {
  let toolCalls = 0;
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "first" }),
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo-agent__echo",
        input: JSON.stringify({ q: "announced-only" }),
      },
      { type: "error", error: "context_length_exceeded" },
    ],
    textStep("ok"),
  ]);
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "same-id-announced-tool-context-overflow",
    model,
    sources: [
      source("echo-agent", "echo", () => {
        toolCalls += 1;
      }),
    ],
    maxSteps: 4,
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
  });

  const events = await collect(session.send("tool loop"));
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(toolCalls, 1);
  const executions = session.getToolExecutions({}, true);
  assert.deepEqual(
    executions.map((record) => record.toolCallId),
    ["c1", "c1"],
  );
  assert.equal(executions[0]?.outcome.kind, "success");
  assert.equal(executions[1]?.outcome.kind, "cancelled");
  assert.match(JSON.stringify(executions[1]?.outcome), /not_executed/u);
  assert.doesNotMatch(JSON.stringify(executions[1]?.outcome), /outcome_unknown/u);
  const recovery = (persisted.at(-1) ?? [])
    .map((message) => readCancelledTurnRecoveryCheckpoint(message))
    .find((checkpoint) => checkpoint !== undefined);
  assert.ok(recovery, "bounded recovery record persisted");
  assert.match(recovery.modelContext, /"kind":"success"/u);
  assert.match(recovery.modelContext, /"executionState":"not_executed"/u);
  assert.ok(recovery.modelContext.length <= 12_000);
  assert.match(JSON.stringify(persisted.at(-1)), /已有操作开始执行/u);
  assert.equal(countOccurrences(JSON.stringify(session.getMessages()), '"type":"tool-call"'), 0);

  await collect(session.send("继续"));
  const nextPrompt = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
  assert.match(nextPrompt, /roll__interrupted_turn_recovery/u);
  assert.match(nextPrompt, /not_executed/u);
});

test("AgentSession 上下文溢出的 pending Tool 恢复写失败时,下一轮在 Provider 前 fail closed", async () => {
  let toolCalls = 0;
  let persistCalls = 0;
  const model = sequencedModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo-agent__echo",
        input: JSON.stringify({ q: "announced-only" }),
      },
      { type: "error", error: "context_length_exceeded" },
    ],
    textStep("must not run"),
  ]);
  const session = new AgentSession({
    id: "context-overflow-pending-recovery-fail-closed",
    model,
    sources: [
      source("echo-agent", "echo", () => {
        toolCalls += 1;
      }),
    ],
    maxSteps: 4,
    onPersist: () => {
      persistCalls += 1;
      throw new Error("recovery store unavailable");
    },
  });

  const firstEvents = await collect(session.send("tool loop"));
  assert.equal(firstEvents.at(-1)?.type, "error");
  assert.equal(toolCalls, 0);
  assert.equal(model.doStreamCalls.length, 1);
  const [execution] = session.getToolExecutions();
  assert.equal(execution?.outcome.kind, "cancelled");
  assert.match(JSON.stringify(execution?.outcome), /not_executed/u);

  const secondEvents = await collect(session.send("继续"));
  assert.equal(secondEvents.at(-1)?.type, "error");
  assert.match(
    secondEvents.find((event) => event.type === "error")?.message ?? "",
    /工具执行恢复状态持久化失败/u,
  );
  assert.equal(model.doStreamCalls.length, 1, "recovery failure must block the provider");
  assert.equal(toolCalls, 0);
  assert.equal(persistCalls, 2);
});

test("AgentSession 上下文溢出时 Tool 账本写盘失败不落盘终态", async () => {
  let ledgerCalls = 0;
  let toolCalls = 0;
  const persisted: ModelMessage[][] = [];
  const model = sequencedModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo-agent__echo",
        input: JSON.stringify({ q: "announced-only" }),
      },
      { type: "error", error: "context_length_exceeded" },
    ],
    textStep("must not run"),
  ]);
  const session = new AgentSession({
    id: "context-overflow-ledger-failure",
    model,
    sources: [
      source("echo-agent", "echo", () => {
        toolCalls += 1;
      }),
    ],
    maxSteps: 4,
    onToolExecution: () => {
      ledgerCalls += 1;
      throw new Error("ledger full");
    },
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
  });

  const events = await collect(session.send("tool loop"));

  assert.equal(toolCalls, 0);
  assert.equal(ledgerCalls, 1);
  assert.deepEqual(session.getToolExecutions({}, true), []);
  assert.deepEqual(session.getMessages(), []);
  assert.deepEqual(persisted, [], "ledger failure must not persist a turn terminal state");
  assert.ok(
    events.some(
      (event) =>
        event.type === "error" && /上下文溢出工具状态持久化失败: ledger full/u.test(event.message),
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "error" && /context_length_exceeded/u.test(event.message),
    ),
  );
});

test("AgentSession 前一模型步骤的同 ID 成功执行不会把新宣告调用误判为已执行", async () => {
  let toolCalls = 0;
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "first" }),
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo-agent__echo",
        input: JSON.stringify({ q: "announced-only" }),
      },
      { type: "error", error: "ECONNRESET" },
    ],
    textStep("ok"),
  ]);
  const session = new AgentSession({
    id: "same-id-second-occurrence-not-executed",
    model,
    sources: [
      source("echo-agent", "echo", () => {
        toolCalls += 1;
      }),
    ],
    maxSteps: 4,
  });

  const events = await collect(session.send("tool loop"));
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(toolCalls, 1);
  const executions = session.getToolExecutions({}, true);
  assert.equal(executions.length, 2);
  assert.equal(executions[0]?.outcome.kind, "success");
  assert.equal(executions[1]?.outcome.kind, "cancelled");
  assert.deepEqual(
    executions.map((record) => record.toolCallId),
    ["c1", "c1"],
  );
  assert.match(JSON.stringify(executions[1]?.outcome), /not_executed/u);
  assert.doesNotMatch(JSON.stringify(executions[1]?.outcome), /outcome_unknown/u);
});

test("AgentSession 同 ID 的新 occurrence 真正开始后被取消时仍记录 outcome_unknown", async () => {
  let toolCalls = 0;
  let cancelled = false;
  const sessionRef: { current: AgentSession | undefined } = { current: undefined };
  const sameIdSource: AgentToolSource = {
    agentName: "same-id-agent",
    client: {
      callTool: async (
        _request: unknown,
        _resultSchema: unknown,
        options: { readonly signal?: AbortSignal } | undefined,
      ) => {
        toolCalls += 1;
        if (toolCalls === 1) {
          return { content: [{ type: "text", text: "first-success" }] };
        }
        cancelled = sessionRef.current?.cancel() ?? false;
        return await new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    } as unknown as Client,
    tools: [
      {
        tool: {
          name: "run",
          inputSchema: {
            type: "object" as const,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
        annotations: { readOnlyHint: true },
      },
    ],
  };
  const session = new AgentSession({
    id: "same-id-second-occurrence-started",
    model: sequencedModel([
      toolCallStep("same-id-agent__run", { q: "first" }),
      toolCallStep("same-id-agent__run", { q: "second" }),
      textStep("must not finish"),
    ]),
    sources: [sameIdSource],
    maxSteps: 4,
  });
  sessionRef.current = session;

  const events = await collect(session.send("run twice"));
  assert.equal(cancelled, true);
  assert.equal(events.at(-1)?.type, "turn-cancelled");
  assert.equal(toolCalls, 2);
  const executions = session.getToolExecutions({}, true);
  assert.deepEqual(
    executions.map((record) => record.toolCallId),
    ["c1", "c1"],
  );
  assert.equal(executions[0]?.outcome.kind, "success");
  assert.equal(executions[1]?.outcome.kind, "cancelled");
  assert.match(JSON.stringify(executions[1]?.outcome), /outcome_unknown/u);
});

test("AgentSession 未覆盖 Tool ledger 的恢复写入失败时阻止手动 compaction", async () => {
  let streamCalls = 0;
  let generateCalls = 0;
  let toolCalls = 0;
  let persistCalls = 0;
  const steps = [toolCallStep("echo-agent__echo", { q: "once" }), textStep("done")];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[streamCalls] ?? steps.at(-1) ?? [];
      streamCalls += 1;
      return streamChunks(chunks);
    },
    doGenerate: async () => {
      generateCalls += 1;
      throw new Error("compactor must not run");
    },
  });
  const session = new AgentSession({
    id: "uncovered-ledger-blocks-manual-compaction",
    model,
    sources: [
      source("echo-agent", "echo", () => {
        toolCalls += 1;
      }),
    ],
    maxSteps: 4,
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onPersist: () => {
      persistCalls += 1;
      throw new Error("transcript unavailable");
    },
  });

  const failedTurn = await collect(session.send("run once"));
  assert.equal(failedTurn.at(-1)?.type, "error");
  assert.equal(toolCalls, 1);
  assert.equal(streamCalls, 2);
  assert.equal(persistCalls, 1);

  const compacted = await collect(session.compact("manual"));
  assert.equal(compacted.at(-1)?.type, "error");
  assert.match(
    compacted.find((event) => event.type === "error")?.message ?? "",
    /transcript unavailable/u,
  );
  assert.equal(generateCalls, 0);
  assert.equal(streamCalls, 2);
  assert.equal(toolCalls, 1);
  assert.equal(persistCalls, 2);
});

test("AgentSession 首次模型调用失败且没有任何已完成步骤时不写入失败记录,保持干净重试", async () => {
  const model = sequencedModel([streamErrorStep("ECONNRESET"), textStep("ok")]);
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "c1-first-call-failure-clean-retry",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 4,
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
  });

  const events = await collect(session.send("hello"));
  assert.equal(events.at(-1)?.type, "error");
  assert.deepEqual(session.getMessages(), []);
  assert.deepEqual(persisted, []);
});

test("AgentSession 用户拒绝工具后即使压力超阈值也不会压缩续跑,本轮到此结束", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 170),
    textStep("BUG_CONTINUED", 40),
  ]);
  const rejectPolicy: ToolPolicy = {
    check: (): PolicyDecision => ({ action: "confirm", reason: "confirm everything" }),
  };
  const session = new AgentSession({
    id: "c1-rejection-under-pressure",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 200,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    policy: rejectPolicy,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("tool loop")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.reject(event.approvalId, "用户取消");
    }
  }
  const finishes = events.filter(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(finishes.length, 1);
  assert.doesNotMatch(finishes[0]?.text ?? "", /BUG_CONTINUED/u);
  assert.equal(events.filter((event) => event.type === "context-compacted").length, 0);
  assert.equal(model.doStreamCalls.length, 1);
});

test("AgentSession 有 compaction checkpoint 时把 reminder 计入首轮压力预算,单靠 reminder 也会触发自动压缩", async () => {
  const model = sequencedModel([textStep("ok")]);
  const session = new AgentSession({
    id: "c1-checkpoint-reminder-counts-toward-pressure",
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 400,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const manual = await collect(session.compact("manual"));
  const checkpointed = manual.find(
    (event): event is Extract<SessionEvent, { type: "context-compacted" }> =>
      event.type === "context-compacted",
  );
  assert.equal(checkpointed?.checkpointGeneration, 1);
  const remainingTokens = estimateMessagesTokens(session.getMessages());
  assert.ok(remainingTokens * 4 < 400 * 0.75);

  const events = await collect(session.send("hello"));
  const compactedIndex = events.findIndex((event) => event.type === "context-compacted");
  const startIndex = events.findIndex((event) => event.type === "message-start");
  assert.notEqual(compactedIndex, -1);
  assert.ok(compactedIndex < startIndex);
  const compacted = events[compactedIndex];
  assert.equal(compacted?.type === "context-compacted" ? compacted.reason : undefined, "auto");
  assert.equal(events.at(-1)?.type, "message-finish");
});

test("AgentSession 累计输入超阈值但上下文输入未超阈值时不自动压缩", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 50),
    textStep("done", 60),
    textStep("after"),
  ]);
  const session = new AgentSession({
    id: "c1-aggregate-pressure",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 400,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const first = await collect(session.send("tool loop"));
  const firstFinish = first.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(firstFinish?.totalUsage?.inputTokens, 110);
  assert.equal(firstFinish?.contextInputTokens, 60);

  const second = await collect(session.send("next"));
  const compacted = second.find((event) => event.type === "context-compacted");
  assert.equal(compacted, undefined);
  assert.equal(second.at(-1)?.type, "message-finish");
});

test("AgentSession 上下文输入超阈值时下轮自动压缩", async () => {
  const model = sequencedModel([
    toolCallStep("echo-agent__echo", { q: "x" }, 50),
    textStep("done", 330),
    textStep("after"),
  ]);
  const session = new AgentSession({
    id: "c1-context-pressure",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 8,
    contextWindow: 400,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const first = await collect(session.send("tool loop"));
  const firstFinish = first.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.equal(firstFinish?.totalUsage?.inputTokens, 380);
  assert.equal(firstFinish?.contextInputTokens, 330);
  assert.equal(
    first.some((event) => event.type === "context-compacted"),
    false,
  );

  const second = await collect(session.send("next"));
  const compacted = second.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "auto");
  assert.equal(compacted.beforeInputTokens, 330);
  assert.ok(compacted.removed >= 4, `removed ${String(compacted.removed)}`);
  assert.equal(second.at(-1)?.type, "message-finish");
});

test("AgentSession context 长度错误后压缩并在同一个 send 内自动重放", async () => {
  const model = sequencedModel([
    streamErrorStep("context_length_exceeded: prompt is too long"),
    textStep("recovered"),
  ]);
  let replaced: readonly unknown[] | undefined;
  const session = new AgentSession({
    id: "c1-overflow",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onReplace: (messages) => {
      replaced = messages;
    },
  });

  const recovered = await collect(session.send("too much"));
  assert.equal(
    recovered.some((event) => event.type === "error"),
    false,
  );
  assert.equal(recovered.filter((event) => event.type === "message-start").length, 1);
  assert.equal(recovered.at(-1)?.type, "message-finish");
  const compacted = recovered.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "auto");
  assert.equal(compacted.removed, 2);
  assert.equal(replaced?.length, 2);
  assert.equal(session.getMessages().length, 4);
  assert.equal(session.getMessages().at(-2)?.content, "too much");
  assert.match(JSON.stringify(session.getMessages().at(-1)?.content), /recovered/u);
});

test("AgentSession Provider stream throw context 错误也压缩并重放当前 send", async () => {
  let modelCalls = 0;
  let persisted: readonly ModelMessage[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return modelCalls === 1
        ? throwingStream("context window exceeded")
        : streamChunks(textStep("recovered after stream throw"));
    },
  });
  const session = new AgentSession({
    id: "overflow-stream-throw",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onPersist: (messages) => {
      persisted = messages;
    },
  });

  const events = await collect(session.send("retry thrown stream"));

  assert.equal(modelCalls, 2);
  assert.equal(events.filter((event) => event.type === "message-start").length, 1);
  assert.equal(events.filter((event) => event.type === "context-compacted").length, 1);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.equal(events.at(-1)?.type, "message-finish");
  assert.equal(persisted[0]?.content, "retry thrown stream");
  assert.match(JSON.stringify(persisted[1]?.content), /recovered after stream throw/u);
});

test("AgentSession overflow checkpoint 持久化失败时不发起第二次 Turn 推理", async () => {
  let modelCalls = 0;
  let commitCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return streamChunks(streamErrorStep("context_length_exceeded"));
    },
  });
  const session = new AgentSession({
    id: "overflow-checkpoint-persist-failure",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    commitCompaction: () => {
      commitCalls += 1;
      throw new Error("checkpoint persist failed");
    },
  });

  const events = await collect(session.send("persist once"));

  assert.equal(modelCalls, 1);
  assert.equal(commitCalls, 1);
  assert.equal(events.filter((event) => event.type === "compaction-start").length, 1);
  assert.equal(events.filter((event) => event.type === "context-compacted").length, 0);
  assert.equal(events.filter((event) => event.type === "message-finish").length, 0);
  assert.ok(
    events.some(
      (event) => event.type === "error" && /checkpoint persist failed/u.test(event.message),
    ),
  );
  assert.equal(
    session
      .getMessages()
      .filter((message) => message.role === "user" && message.content === "persist once").length,
    1,
  );
});

test("AgentSession overflow compaction 被取消时不发起第二次 Turn 推理", async () => {
  const compactionStarted = Promise.withResolvers<void>();
  const compactionAborted = Promise.withResolvers<void>();
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return streamChunks(streamErrorStep("context window exceeded"));
    },
    doGenerate: async (options) => {
      compactionStarted.resolve();
      return new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          compactionAborted.resolve();
          reject(options.abortSignal?.reason ?? new Error("compaction cancelled"));
        };
        if (options.abortSignal?.aborted) {
          onAbort();
          return;
        }
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const session = new AgentSession({
    id: "overflow-compaction-cancelled",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onPersist: () => {
      throw new Error("cancel persistence failed");
    },
  });

  const pending = collect(session.send("cancel recovery"));
  await compactionStarted.promise;
  assert.equal(session.cancel(), true);
  await compactionAborted.promise;
  const events = await pending;

  assert.equal(modelCalls, 1);
  assert.equal(events.filter((event) => event.type === "compaction-start").length, 1);
  assert.equal(events.filter((event) => event.type === "context-compacted").length, 0);
  const cancelled = events.filter((event) => event.type === "turn-cancelled");
  assert.equal(cancelled.length, 1);
  assert.match(cancelled[0]?.message ?? "", /未能保存/u);
  assert.doesNotMatch(cancelled[0]?.message ?? "", /会保留/u);
  assert.equal(
    events.some((event) => event.type === "text-delta" && event.delta.includes("recovered")),
    false,
  );
});

test("AgentSession overflow compaction 达到 Turn 超时时不发起第二次 Turn 推理", async () => {
  const compactionStarted = Promise.withResolvers<void>();
  const compactionAborted = Promise.withResolvers<void>();
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return streamChunks(streamErrorStep("maximum context reached"));
    },
    doGenerate: async (options) => {
      compactionStarted.resolve();
      return new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          compactionAborted.resolve();
          reject(options.abortSignal?.reason ?? new Error("compaction timed out"));
        };
        if (options.abortSignal?.aborted) {
          onAbort();
          return;
        }
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const session = new AgentSession({
    id: "overflow-compaction-timeout",
    model,
    sources: [],
    maxSteps: 2,
    turnTimeoutMs: 100,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const pending = collect(session.send("timeout recovery"));
  await compactionStarted.promise;
  await compactionAborted.promise;
  const events = await pending;

  assert.equal(modelCalls, 1);
  assert.equal(events.filter((event) => event.type === "compaction-start").length, 1);
  assert.equal(events.filter((event) => event.type === "context-compacted").length, 0);
  assert.equal(
    events.some((event) => event.type === "text-delta" && event.delta.includes("recovered")),
    false,
  );
});

test("AgentSession context 自动重放最多一次，连续 overflow 有界失败", async () => {
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return streamChunks(streamErrorStep("context_length_exceeded"));
    },
  });
  const session = new AgentSession({
    id: "overflow-bounded",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const events = await collect(session.send("retry once"));

  assert.equal(modelCalls, 2);
  assert.equal(events.filter((event) => event.type === "message-start").length, 1);
  assert.equal(events.filter((event) => event.type === "error").length, 1);
  assert.equal(events.filter((event) => event.type === "context-compacted").length, 1);
  assert.equal(
    events.some((event) => event.type === "message-finish"),
    false,
  );
});

test("AgentSession context 压缩无进展时不自动重放", async () => {
  let modelCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return streamChunks(streamErrorStep("context window exceeded"));
    },
  });
  const session = new AgentSession({
    id: "overflow-no-progress",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "only" },
      { role: "assistant", content: "turn" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1000,
    },
  });

  const events = await collect(session.send("cannot shrink"));

  assert.equal(modelCalls, 1);
  assert.ok(events.some((event) => event.type === "error"));
});

test("AgentSession context failure marker 持久化失败时回滚内存 Turn", async () => {
  const session = new AgentSession({
    id: "overflow-marker-persist-failure",
    model: sequencedModel([streamErrorStep("context_length_exceeded")]),
    sources: [],
    maxSteps: 2,
    onPersist: () => {
      throw new Error("db write failed");
    },
  });

  const events = await collect(session.send("must remain durable"));

  assert.deepEqual(session.getMessages(), []);
  assert.ok(
    events.some(
      (event) =>
        event.type === "error" && /上下文溢出记录持久化失败: db write failed/u.test(event.message),
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "error" && /context_length_exceeded/u.test(event.message),
    ),
  );
});

test("AgentSession 已输出文本后 context overflow 不重放", async () => {
  let modelCalls = 0;
  let persisted: readonly ModelMessage[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      modelCalls += 1;
      return streamChunks(textThenStreamErrorStep("partial", "prompt is too long"));
    },
  });
  const session = new AgentSession({
    id: "overflow-partial-text",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onPersist: (messages) => {
      persisted = messages;
    },
  });

  const events = await collect(session.send("partial"));

  assert.equal(modelCalls, 1);
  assert.ok(events.some((event) => event.type === "text-delta"));
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.message, /为避免重复执行，未自动重试/u);
  assert.doesNotMatch(error.message, /副作用|重放/u);
  assert.equal(persisted[0]?.content, "partial");
  assert.match(String(persisted[1]?.content), /部分文本/u);
});

test("AgentSession Tool 已执行后下一 Step overflow 不重放副作用", async () => {
  let modelCalls = 0;
  let toolCalls = 0;
  let persisted: readonly ModelMessage[] = [];
  const steps = [
    toolCallStep("side-effect__write", { q: "x" }),
    streamErrorStep("maximum context reached"),
  ];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[modelCalls] ?? streamErrorStep("maximum context reached");
      modelCalls += 1;
      return streamChunks(chunks);
    },
  });
  const session = new AgentSession({
    id: "overflow-after-tool",
    model,
    sources: [source("side-effect", "write", () => (toolCalls += 1))],
    maxSteps: 4,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onPersist: (messages) => {
      persisted = messages;
    },
  });

  const events = await collect(session.send("write once"));

  assert.equal(modelCalls, 2);
  assert.equal(toolCalls, 1);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.message, /为避免重复执行，未自动重试/u);
  assert.doesNotMatch(error.message, /副作用|重放/u);
  assert.equal(persisted[0]?.content, "write once");
  const recoveryMessage = persisted[1];
  assert.ok(recoveryMessage);
  const recovery = readCancelledTurnRecoveryCheckpoint(recoveryMessage);
  assert.ok(recovery);
  assert.match(recovery.modelContext, /"outcome":\{"kind":"success"/u);
  assert.match(String(persisted[2]?.content), /部分结果可能已经生效且不会自动撤销/u);
  assert.doesNotMatch(String(persisted[2]?.content), /外部副作用|回滚|工具活动/u);
});

test("AgentSession summarize 结构化 draft 无效时降级 truncate 且不继续原始历史", async () => {
  const steps = [textStep("a"), textStep("b"), textStep("c")];
  let index = 0;
  let generateCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
    doGenerate: async () => {
      generateCalls += 1;
      return {
        content: [{ type: "text", text: '{"goal":' }],
        finishReason: STOP,
        usage: usage(5, 3),
        warnings: [],
      };
    },
  });
  const session = new AgentSession({
    id: "c1-fallback",
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 1,
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  await collect(session.send("t1"));
  await collect(session.send("t2"));
  const events = await collect(session.send("t3"));

  const compacted = events.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.strategy, "truncate");
  assert.equal(compacted.removed, 2);
  assert.equal(generateCalls, 1);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  assert.equal(events.at(-1)?.type, "message-finish");
});

test("AgentSession compaction provider/transport 失败时不 truncate、不替换、不提交", async () => {
  const failures: Error[] = [
    ...[408, 429, 503].map(
      (statusCode) =>
        new APICallError({
          message: `provider failed with ${String(statusCode)}`,
          url: "https://provider.invalid/v1/generate",
          requestBodyValues: {},
          statusCode,
        }),
    ),
    Object.assign(new Error("provider request timed out"), { name: "TimeoutError" }),
    new Error("ECONNRESET"),
  ];
  const original: ModelMessage[] = [
    { role: "user", content: "old-1" },
    { role: "assistant", content: "answer-1" },
    { role: "user", content: "old-2" },
    { role: "assistant", content: "answer-2" },
  ];

  for (const failure of failures) {
    let replaceCalls = 0;
    let commitCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw failure;
      },
    });
    const session = new AgentSession({
      id: `compaction-provider-failure-${failure.name}-${failure.message}`,
      model,
      sources: [],
      maxSteps: 2,
      initialMessages: original,
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 1,
      },
      onReplace: () => {
        replaceCalls += 1;
      },
      commitCompaction: () => {
        commitCalls += 1;
        throw new Error("must not commit after a provider failure");
      },
    });

    const events = await collect(session.compact("manual"));

    assert.equal(replaceCalls, 0);
    assert.equal(commitCalls, 0);
    assert.deepEqual([...session.getMessages()], original);
    assert.equal(
      events.some((event) => event.type === "context-compacted"),
      false,
    );
    const error = events.find((event) => event.type === "error");
    assert.ok(error && error.type === "error");
    assert.ok(error.message.includes(failure.message));
  }
});

test("AgentSession 结构化 draft 接受多语言语义并确定性派生 summary", async () => {
  let inferencePrompt = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      inferencePrompt = JSON.stringify(options.prompt);
      return streamChunks(textStep("unused"));
    },
    doGenerate: async (options) => {
      const evidenceId = /evidence_[0-9a-f]{24}/u.exec(JSON.stringify(options.prompt))?.[0];
      assert.ok(evidenceId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              startsNewGoalScope: false,
              goal: null,
              constraints: [],
              decisions: [],
              completedWork: [],
              pendingWork: [
                {
                  priorItemId: null,
                  text: "短い要約",
                  sourceEvidenceIds: [evidenceId],
                  sourceQuotes: ["old-1"],
                },
              ],
              resources: [],
              runningSessions: [],
              uncertainties: [],
              resolutions: [],
              evidenceReviews: [],
            }),
          },
        ],
        finishReason: STOP,
        usage: usage(5, 3),
        warnings: [],
      };
    },
  });
  const session = new AgentSession({
    id: "summary-advisory-does-not-truncate",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "old-2" },
      { role: "assistant", content: "answer-2" },
    ],
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const events = await collect(session.compact("manual"));
  const compacted = events.find((event) => event.type === "context-compacted");

  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.strategy, "summarize");
  assert.doesNotMatch(JSON.stringify(session.getMessages()), /短い要約|old-1/u);
  await collect(session.send("继续"));
  assert.match(inferencePrompt, /sourceQuotes.*old-1/u);
  assert.doesNotMatch(inferencePrompt, /短い要約/u);
});

test("AgentSession 无 Store 时连续两次 compaction 仍继承内存 checkpoint 与 append-only evidence", async () => {
  const emptyDraft = {
    startsNewGoalScope: false,
    goal: null,
    constraints: [],
    decisions: [],
    completedWork: [],
    pendingWork: [],
    resources: [],
    runningSessions: [],
    uncertainties: [],
    resolutions: [],
    evidenceReviews: [],
  };
  let streamCall = 0;
  const inferencePrompts: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      streamCall += 1;
      inferencePrompts.push(JSON.stringify(options.prompt));
      return streamChunks(textStep(`new-answer-${String(streamCall)}`));
    },
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(emptyDraft) }],
      finishReason: STOP,
      usage: usage(5, 3),
      warnings: [],
    }),
  });
  const session = new AgentSession({
    id: "in-memory-two-compactions",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: [
      { role: "user", content: "old-user-evidence" },
      { role: "assistant", content: "old-assistant-evidence" },
      { role: "user", content: "current-user-evidence" },
      { role: "assistant", content: "current-assistant-evidence" },
    ],
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    debugEvents: true,
  });

  const first = await collect(session.compact("manual"));
  assert.equal(first.find((event) => event.type === "context-compacted")?.checkpointGeneration, 1);
  const phaseMessages = first
    .filter((event): event is Extract<SessionEvent, { type: "debug" }> => event.type === "debug")
    .map((event) => event.message);
  assert.ok(phaseMessages.includes("evidence ready"));
  assert.ok(phaseMessages.includes("draft generation finished"));
  assert.ok(phaseMessages.includes("checkpoint validation finished"));
  assert.ok(phaseMessages.includes("checkpoint commit finished"));
  await collect(session.send("new-user-evidence"));
  const second = await collect(session.compact("manual"));
  assert.equal(second.find((event) => event.type === "context-compacted")?.checkpointGeneration, 2);
  const active = JSON.stringify(session.getMessages());
  assert.doesNotMatch(active, /old-user-evidence/u);
  assert.match(active, /new-user-evidence/u);
  const third = await collect(session.compact("manual"));
  const thirdCompaction = third.find((event) => event.type === "context-compacted");
  assert.ok(thirdCompaction && thirdCompaction.type === "context-compacted");
  assert.equal(thirdCompaction.removed, 0);
  assert.equal(thirdCompaction.checkpointGeneration, undefined);
  await collect(session.send("inspect checkpoint"));
  assert.match(inferencePrompts.at(-1) ?? "", /old-user-evidence/u);
  assert.match(inferencePrompts.at(-1) ?? "", /new-user-evidence/u);
});

test("AgentSession 无 Store 恢复 V1 checkpoint 时 fail closed 保留 active snapshot", async () => {
  const legacyCheckpoint = compactionCheckpointV1Schema.parse({
    version: 1,
    id: "afc291a0-117d-4a63-a285-1d16c195a927",
    generation: 1,
    createdAt: "2026-07-17T10:00:00.000Z",
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 9 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
    constraints: [],
    resources: [],
    toolState: createEmptyCompactionToolState(),
    runningWork: [],
    context: {
      cwd: process.cwd(),
      stableRuleIds: [],
      skills: [],
      explicitSkillNames: [],
    },
    summary: { status: "skipped" },
  });
  const semanticPrompts: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => streamChunks(textStep("post-v1-assistant")),
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      semanticPrompts.push(prompt);
      const evidenceIds = [
        ...new Set([...prompt.matchAll(/evidence_[0-9a-f]{24}/gu)].map((match) => match[0])),
      ];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              startsNewGoalScope: false,
              goal: null,
              constraints: [],
              decisions: [],
              completedWork: [],
              pendingWork: [],
              resources: [],
              runningSessions: [],
              uncertainties: [],
              resolutions: [],
              evidenceReviews: evidenceIds.map((evidenceId) => ({
                evidenceId,
                disposition: "irrelevant",
                reason: "watermark regression fixture",
              })),
            }),
          },
        ],
        finishReason: STOP,
        usage: usage(5, 3),
        warnings: [],
      };
    },
  });
  const session = new AgentSession({
    id: "in-memory-v1-watermark",
    model,
    sources: [],
    maxSteps: 2,
    initialCheckpoint: legacyCheckpoint,
    initialMessages: [
      { role: "user", content: "v1-active-user" },
      { role: "assistant", content: "v1-active-assistant" },
      { role: "user", content: "v1-current-user" },
      { role: "assistant", content: "v1-current-assistant" },
    ],
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const first = await collect(session.compact("manual"));
  assert.equal(first.find((event) => event.type === "context-compacted")?.removed, 0);
  assert.deepEqual(semanticPrompts, []);
  assert.deepEqual(session.getMessages(), [
    { role: "user", content: "v1-active-user" },
    { role: "assistant", content: "v1-active-assistant" },
    { role: "user", content: "v1-current-user" },
    { role: "assistant", content: "v1-current-assistant" },
  ]);

  await collect(session.send("post-v1-user"));
  const second = await collect(session.compact("manual"));
  assert.equal(second.find((event) => event.type === "context-compacted")?.removed, 0);
  assert.deepEqual(semanticPrompts, []);
  assert.match(JSON.stringify(session.getMessages()), /v1-active-user/u);
  assert.match(JSON.stringify(session.getMessages()), /post-v1-user/u);
});

test("AgentSession V1 malformed draft 撤销旧约束时仍保留上一真实目标", async () => {
  const legacyCheckpoint = compactionCheckpointV1Schema.parse({
    version: 1,
    id: "5e30f71d-d419-4ab7-b2c5-8d7c3b832e40",
    generation: 1,
    createdAt: "2026-07-17T10:00:00.000Z",
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 1 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
    goal: {
      verbatimRequest: "修复调度器，但绝对不要修改公开 API",
      sourceSequence: 0,
      status: "active",
    },
    constraints: [{ quote: "绝对不要修改公开 API", sourceSequence: 0 }],
    resources: [],
    toolState: createEmptyCompactionToolState(),
    runningWork: [],
    context: {
      cwd: process.cwd(),
      stableRuleIds: [],
      skills: [],
      explicitSkillNames: [],
    },
    summary: { status: "skipped" },
  });
  const inferencePrompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: '{"goal":' }],
      finishReason: STOP,
      usage: usage(5, 3),
      warnings: [],
    }),
    doStream: async (options) => {
      inferencePrompts.push(JSON.stringify(options.prompt));
      return streamChunks(textStep("继续处理"));
    },
  });
  const session = new AgentSession({
    id: "v1-malformed-draft-goal",
    model,
    sources: [],
    maxSteps: 2,
    initialCheckpoint: legacyCheckpoint,
    initialMessages: [
      { role: "user", content: "现在允许修改公开 API" },
      { role: "assistant", content: "收到" },
      { role: "user", content: "继续" },
      { role: "assistant", content: "处理中" },
    ],
    commitCompaction: (input) =>
      createCompactionCheckpoint({
        draft: input.draft,
        semanticState: input.semanticState,
        semanticEvidence: input.semanticEvidenceWatermarks,
        generation: 2,
        previousCheckpointId: legacyCheckpoint.id,
        transcript: {
          messages: {
            fromSequenceExclusive: legacyCheckpoint.transcript.messages.throughSequence,
            throughSequence:
              input.evidenceWatermarks.transcriptMessagesThroughSequence +
              (input.legacySnapshotTranscriptFragments?.length ?? 0),
          },
          toolExecutions: {
            fromSequenceExclusive: legacyCheckpoint.transcript.toolExecutions.throughSequence,
            throughSequence: input.evidenceWatermarks.toolExecutionsThroughSequence,
          },
          completeness: legacyCheckpoint.transcript.completeness,
        },
      }),
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  const compacted = await collect(session.compact("manual"));
  const compactedEvent = compacted.find((event) => event.type === "context-compacted");
  assert.ok(
    compactedEvent && compactedEvent.type === "context-compacted",
    JSON.stringify(compacted),
  );
  assert.equal(compactedEvent.strategy, "truncate");
  assert.equal(compactedEvent.checkpointGeneration, 2);

  await collect(session.send("检查恢复状态"));
  const prompt = inferencePrompts.at(-1) ?? "";
  assert.match(prompt, /修复调度器，但绝对不要修改公开 API/u);
  assert.match(prompt, /\\"constraints\\":\[\]/u);
  assert.doesNotMatch(prompt, /\\"category\\":\\"goal\\"[^}]*现在允许修改公开 API/u);
});

test("AgentSession 仅截断 Tool Result 时不提前退休仍在 active history 的 V1 snapshot", async () => {
  const legacyCheckpoint = compactionCheckpointV1Schema.parse({
    version: 1,
    id: "0af778c2-706c-47ed-a77e-2fc3c57d56da",
    generation: 1,
    createdAt: "2026-07-17T10:00:00.000Z",
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 5 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
    constraints: [],
    resources: [],
    toolState: createEmptyCompactionToolState(),
    runningWork: [],
    context: {
      cwd: process.cwd(),
      stableRuleIds: [],
      skills: [],
      explicitSkillNames: [],
    },
    summary: { status: "skipped" },
  });
  const legacyMarker = "LEGACY_ACTIVE_SNAPSHOT_MUST_REMAIN";
  const initialMessages: ModelMessage[] = [
    {
      role: "user",
      content:
        "以下摘要由另一个语言模型在压缩早前对话后产出。请据此继续推进、避免重复已完成的工作:\n\n" +
        legacyMarker,
    },
    { role: "assistant", content: "好的,我已读取之前工作的交接摘要,继续推进。" },
    { role: "user", content: "inspect the large result" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "legacy-large", toolName: "snapshot", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "legacy-large",
          toolName: "snapshot",
          output: { type: "text", value: "x".repeat(3_000) },
        },
      ],
    },
    { role: "assistant", content: "large result observed" },
  ];
  let commitCalls = 0;
  const session = new AgentSession({
    id: "v1-tool-only-truncation",
    model: sequencedModel([]),
    sources: [],
    maxSteps: 2,
    initialCheckpoint: legacyCheckpoint,
    initialMessages,
    commitCompaction: () => {
      commitCalls += 1;
      throw new Error("V1 checkpoint must not retire while its active snapshot remains");
    },
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 10,
      keepRecentTokens: 1,
    },
  });

  const compacted = await collect(session.compact("manual"));
  const compactedEvent = compacted.find((event) => event.type === "context-compacted");
  assert.ok(
    compactedEvent && compactedEvent.type === "context-compacted",
    JSON.stringify(compacted),
  );
  assert.equal(compactedEvent.removed, 0);
  assert.equal(compactedEvent.truncatedTools, undefined);
  assert.equal(compactedEvent.checkpointGeneration, undefined);
  assert.equal(commitCalls, 0);
  assert.deepEqual(session.getMessages(), initialMessages);
  assert.match(JSON.stringify(session.getMessages()), new RegExp(legacyMarker, "u"));
});

test("AgentSession replace 持久化失败时不替换内存历史", async () => {
  const original = [
    { role: "user" as const, content: "old-1" },
    { role: "assistant" as const, content: "answer-1" },
    { role: "user" as const, content: "old-2" },
    { role: "assistant" as const, content: "answer-2" },
  ];
  const session = new AgentSession({
    id: "c1-replace-fail",
    model: sequencedModel([]),
    sources: [],
    maxSteps: 2,
    initialMessages: original,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onReplace: () => {
      throw new Error("persist failed");
    },
  });

  const events = await collect(session.compact("manual"));

  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.message, /persist failed/);
  assert.deepEqual([...session.getMessages()], original);
});

test("AgentSession compact iterator 提前关闭时取消 summary 且不替换历史", async () => {
  const original = [
    { role: "user" as const, content: "old-1" },
    { role: "assistant" as const, content: "answer-1" },
    { role: "user" as const, content: "old-2" },
    { role: "assistant" as const, content: "answer-2" },
  ];
  let resolveGenerateStarted: () => void = () => undefined;
  let resolveGenerateReleased: () => void = () => undefined;
  let resolveGenerateSettled: () => void = () => undefined;
  const generateStarted = new Promise<void>((resolve) => {
    resolveGenerateStarted = resolve;
  });
  const generateReleased = new Promise<void>((resolve) => {
    resolveGenerateReleased = resolve;
  });
  const generateSettled = new Promise<void>((resolve) => {
    resolveGenerateSettled = resolve;
  });
  let abortObserved = false;
  let replaceCalls = 0;
  let closeCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => streamChunks(textStep("session-reused")),
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          abortObserved = true;
          resolveGenerateReleased();
        },
        { once: true },
      );
      if (options.abortSignal?.aborted) {
        abortObserved = true;
        resolveGenerateReleased();
      }
      resolveGenerateStarted();
      await generateReleased;
      resolveGenerateSettled();
      return {
        content: [{ type: "text", text: "SUMMARY-TEXT" }],
        finishReason: STOP,
        usage: usage(5, 3),
        warnings: [],
      };
    },
  });
  const session = new AgentSession({
    id: "c1-compact-abort",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: original,
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    onReplace: () => {
      replaceCalls += 1;
    },
    onClose: () => {
      closeCalls += 1;
    },
  });

  const iterator = session.compact("manual")[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, "compaction-start");
  await generateStarted;

  await iterator.return?.();
  await generateSettled;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(abortObserved, true);
  assert.equal(replaceCalls, 0);
  assert.equal(closeCalls, 0);
  assert.deepEqual([...session.getMessages()], original);

  const reused = await collect(session.send("after abandoned compaction"));
  assert.ok(reused.some((event) => event.type === "message-finish"));
  await session.close();
  assert.equal(closeCalls, 1);
});

test("AgentSession send iterator 提前关闭时只取消本轮且 session 可复用", async () => {
  const streamStarted = Promise.withResolvers<void>();
  const streamAborted = Promise.withResolvers<void>();
  const cancelledTurnPersisted = Promise.withResolvers<void>();
  let streamCalls = 0;
  let closeCalls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        options.abortSignal?.addEventListener("abort", () => streamAborted.resolve(), {
          once: true,
        });
        streamStarted.resolve();
        await streamAborted.promise;
        return streamChunks(textStep("discarded"));
      }
      return streamChunks(textStep("session-reused"));
    },
  });
  const session = new AgentSession({
    id: "send-iterator-abandoned",
    model,
    sources: [],
    maxSteps: 2,
    onPersist: () => cancelledTurnPersisted.resolve(),
    onClose: () => {
      closeCalls += 1;
    },
  });

  const iterator = session.send("first")[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, "message-start");
  await streamStarted.promise;

  await iterator.return?.();
  await streamAborted.promise;
  await cancelledTurnPersisted.promise;

  assert.equal(closeCalls, 0);
  const reused = await collect(session.send("second"));
  assert.ok(reused.some((event) => event.type === "message-finish"));

  await session.close();
  assert.equal(closeCalls, 1);
});

test("AgentSession 手动 /compact 即使 enabled=false 也生效", async () => {
  const model = sequencedModel([textStep("a"), textStep("b")]);
  const session = new AgentSession({
    id: "c2",
    model,
    sources: [],
    maxSteps: 2,
    compaction: {
      enabled: false,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });

  await collect(session.send("t1"));
  await collect(session.send("t2"));
  const events = await collect(session.compact("manual"));

  const compacted = events.find((event) => event.type === "context-compacted");
  assert.ok(compacted && compacted.type === "context-compacted");
  assert.equal(compacted.reason, "manual");
  assert.equal(compacted.removed, 2);
  assert.equal(session.getMessages().length, 2);
});

test("AgentSession 手动 /compact 透传独立超时且失败时不替换历史", async (t) => {
  let capturedTimeoutMs: number | undefined;
  let capturedMaxOutputTokens: number | undefined;
  let capturedReasoning: unknown;
  const timeoutSignal = new AbortController().signal;
  t.mock.method(AbortSignal, "timeout", (timeoutMs: number) => {
    capturedTimeoutMs = timeoutMs;
    return timeoutSignal;
  });
  const timeoutError = Object.assign(new Error("provider request timed out"), {
    name: "TimeoutError",
  });
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      capturedMaxOutputTokens = options.maxOutputTokens;
      capturedReasoning = options.reasoning;
      throw timeoutError;
    },
  });
  const initialMessages: ModelMessage[] = [
    { role: "user", content: "old-1" },
    { role: "assistant", content: "answer-1" },
    { role: "user", content: "old-2" },
    { role: "assistant", content: "answer-2" },
  ];
  const session = new AgentSession({
    id: "manual-compaction-timeout",
    model,
    sources: [],
    maxSteps: 2,
    initialMessages,
    compaction: {
      enabled: true,
      strategy: "summarize",
      timeoutMs: 23_456,
      maxOutputTokens: 9_876,
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    structuredOutputReasoning: "high",
    debugEvents: true,
  });

  const events = await collect(session.compact("manual"));

  assert.equal(
    events.some((event) => event.type === "context-compacted"),
    false,
  );
  assert.equal(capturedTimeoutMs, 23_456);
  assert.equal(capturedMaxOutputTokens, 9_876);
  assert.equal(capturedReasoning, "high");
  const generationTiming = events.find(
    (event) => event.type === "debug" && event.message === "draft generation finished",
  );
  assert.ok(generationTiming && generationTiming.type === "debug");
  assert.equal(generationTiming.stage, "compaction");
  assert.ok((generationTiming.elapsedMs ?? -1) >= 0);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.equal(error.message, timeoutError.message);
  assert.deepEqual(session.getMessages(), initialMessages);
});

test("AgentSession 累计 session token 用量并随 message-finish 上报", async () => {
  const model = sequencedModel([textStep("x"), textStep("y")]);
  const session = new AgentSession({ id: "c3", model, sources: [], maxSteps: 2 });

  await collect(session.send("a"));
  const events = await collect(session.send("b"));
  const finish = events.find(
    (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
      event.type === "message-finish",
  );
  assert.ok(finish?.sessionUsage);
  assert.equal(finish.sessionUsage.inputTokens, 2);
  assert.equal(finish.sessionUsage.outputTokens, 2);
  assert.equal(session.getSessionUsage().inputTokens, 2);
});

test("AgentSession 拒绝同一 session 并发 send，避免 emit/gate 状态串线", async () => {
  const model = sequencedModel([
    toolCallStep("msg-agent__send_message", { q: "hi" }),
    textStep("done"),
  ]);
  const session = new AgentSession({
    id: "s7",
    model,
    sources: [source("msg-agent", "send_message")],
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });

  const iterator = session.send("send hi")[Symbol.asyncIterator]();
  let firstConfirmationSeen = false;
  while (!firstConfirmationSeen) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === "confirmation-required") {
      firstConfirmationSeen = true;
    }
  }

  await assert.rejects(async () => {
    await session.send("second")[Symbol.asyncIterator]().next();
  }, /active turn/);

  session.abort();
  let drained = false;
  while (!drained) {
    const next = await iterator.next();
    drained = next.done === true;
  }
});

test(
  "bash 工具：模型调用 roll__bash 产出 delta 与 tool-result 事件",
  { skip: process.platform === "win32" },
  async () => {
    const { tmpdir } = await import("node:os");
    const model = sequencedModel([
      toolCallStep("roll__bash", { command: "echo session-bash" }),
      textStep("完成"),
    ]);
    const session = new AgentSession({
      id: "bash-1",
      model,
      sources: [],
      maxSteps: 5,
      policy: new ConfigurableToolPolicy({
        defaultMode: "auto",
        overrides: { "roll.bash": "auto" },
      }),
      bash: {
        profile: posixProfile,
        workdir: tmpdir(),
        defaultTimeoutMs: 10_000,
        maxTimeoutMs: 600_000,
        turnTimeoutMs: 600_000,
        maxCaptureBytes: 1_048_576,
        maxModelOutputChars: 16_000,
      },
    });

    const events: SessionEvent[] = [];
    for await (const event of session.send("跑一下 echo")) {
      events.push(event);
    }

    const toolCall = events.find((event) => event.type === "tool-call");
    assert.equal(toolCall?.type, "tool-call");
    assert.equal(toolCall.agentName, "roll");
    assert.equal(toolCall.toolName, "bash");

    const deltas = events.filter((event) => event.type === "tool-output-delta");
    assert.ok(deltas.length >= 1);
    assert.ok(
      deltas.some(
        (event) => event.type === "tool-output-delta" && event.delta.includes("session-bash"),
      ),
    );

    const toolResult = events.find((event) => event.type === "tool-result");
    assert.equal(toolResult?.type, "tool-result");
    assert.equal(toolResult.isError, false);
    assert.ok(JSON.stringify(toolResult.output).includes("Exit code: 0"));
  },
);

test(
  "bash 工具 E2E：工作区外 pattern 文件触发确认，工作区内 pattern 文件自动执行",
  { skip: process.platform === "win32" },
  async () => {
    const workdir = mkdtempSync(join(tmpdir(), "roll-bash-e2e-work-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "roll-bash-e2e-outside-"));
    try {
      writeFileSync(join(workdir, "haystack.txt"), "needle\nother\n");
      writeFileSync(join(workdir, "patterns.txt"), "needle\n");
      const outsidePattern = join(outsideDir, "patterns.txt");
      writeFileSync(outsidePattern, "needle\n");

      const unsafeSession = new AgentSession({
        id: "bash-e2e-unsafe",
        model: sequencedModel([
          toolCallStep("roll__bash", {
            command: `grep -f ${outsidePattern} haystack.txt`,
            explanation: "读取工作区外的匹配规则，以完成用户要求的内容筛选。",
          }),
          textStep("不应继续执行"),
        ]),
        sources: [],
        maxSteps: 5,
        policy: new DefaultToolPolicy(),
        bashClassifier: ruleBasedClassifier,
        bash: testBashSettings(workdir),
      });
      const unsafeEvents: SessionEvent[] = [];
      for await (const event of unsafeSession.send("用工作区外 pattern 文件 grep")) {
        unsafeEvents.push(event);
        if (event.type === "confirmation-required") {
          unsafeSession.reject(event.approvalId);
        }
      }
      const unsafeConfirmation = unsafeEvents.find(
        (event) => event.type === "confirmation-required",
      );
      assert.ok(unsafeConfirmation?.type === "confirmation-required");
      assert.equal(unsafeConfirmation.reason, undefined);
      const denied = unsafeEvents.find((event) => event.type === "tool-result");
      assert.equal(denied?.type, "tool-result");
      assert.equal(denied.isError, true);
      assert.ok(JSON.stringify(denied.output).includes("已取消执行"));
      unsafeSession.abort();

      const safeSession = new AgentSession({
        id: "bash-e2e-safe",
        model: sequencedModel([
          toolCallStep("roll__bash", { command: "grep -f patterns.txt haystack.txt" }),
          textStep("完成"),
        ]),
        sources: [],
        maxSteps: 5,
        policy: new DefaultToolPolicy(),
        bashClassifier: ruleBasedClassifier,
        bash: testBashSettings(workdir),
      });
      const safeEvents = await collect(safeSession.send("用工作区内 pattern 文件 grep"));
      assert.ok(!safeEvents.some((event) => event.type === "confirmation-required"));
      const result = safeEvents.find((event) => event.type === "tool-result");
      assert.equal(result?.type, "tool-result");
      assert.equal(result.isError, false);
      assert.ok(JSON.stringify(result.output).includes("needle"));
      assert.ok(JSON.stringify(result.output).includes("Exit code: 0"));
      safeSession.abort();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  },
);

test("未配置 bash 时工具不存在", async () => {
  const session = new AgentSession({
    id: "no-bash",
    model: sequencedModel([textStep("hi")]),
    sources: [],
    maxSteps: 3,
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("hi")) {
    events.push(event);
  }
  assert.ok(!events.some((event) => event.type === "tool-call"));
});

function fakeSkillLibrary(
  name: string,
  content: string,
): import("@roll-agent/core/skills/library").SkillLibrary {
  const summary = { name, description: "测试 skill", source: "user" } as const;
  return {
    list: () => [summary],
    load: (requested) =>
      requested === name ? { summary, content, referencePaths: [] } : undefined,
    loadReference: () => undefined,
  };
}

test("systemPrompt compatibility field appends without replacing capability grounding", async () => {
  let capturedSystem = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const system = options.prompt[0];
      capturedSystem = system?.role === "system" ? system.content : "";
      return streamChunks(textStep("done"));
    },
  });
  const session = new AgentSession({
    id: "extra-system-prompt",
    model,
    sources: [],
    maxSteps: 2,
    systemPrompt: "CUSTOM_ONLY",
  });

  await collect(session.send("hello"));

  assert.match(capturedSystem, /# 工具使用纪律/u);
  assert.match(capturedSystem, /没有这两类证据，就如实说明尚未执行或结果待确认/u);
  assert.match(capturedSystem, /# 附加会话指令/u);
  assert.match(capturedSystem, /CUSTOM_ONLY/u);
});

test("applyAgentRefresh 后新 agent 工具与新 system prompt 从下一轮生效", async () => {
  let capturedSystem: string | undefined;
  let index = 0;
  const steps = [toolCallStep("new-agent__probe", { q: "x" }), textStep("完成")];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const first = options.prompt[0];
      if (first && first.role === "system") {
        capturedSystem = first.content;
      }
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
  });
  let calls = 0;
  const session = new AgentSession({
    id: "refresh-1",
    model,
    sources: [source("old-agent", "noop")],
    maxSteps: 8,
    systemPrompt: "OLD_PROMPT",
  });

  session.applyAgentRefresh({
    source: source("new-agent", "probe", () => (calls += 1)),
    systemPrompt: "NEW_PROMPT",
  });

  const events = await collect(session.send("call new agent"));
  assert.match(capturedSystem ?? "", /# 工具使用纪律/u);
  assert.match(capturedSystem ?? "", /# 附加会话指令/u);
  assert.match(capturedSystem ?? "", /NEW_PROMPT/u);
  assert.doesNotMatch(capturedSystem ?? "", /OLD_PROMPT/u);
  assert.equal(calls, 1);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
});

test("applyAgentRefresh 注入 skill library 后 roll__skill 可用", async () => {
  const model = sequencedModel([
    toolCallStep("roll__skill", { name: "new-skill" }),
    textStep("ok"),
  ]);
  const session = new AgentSession({ id: "refresh-2", model, sources: [], maxSteps: 8 });

  session.applyAgentRefresh({
    source: source("new-agent", "probe"),
    skillLibrary: fakeSkillLibrary("new-skill", "SKILL BODY 内容"),
    systemPrompt: "NEW_PROMPT",
  });

  const events = await collect(session.send("load skill"));
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
  assert.deepEqual(
    session.getSkillSummaries().map((skill) => skill.name),
    ["new-skill"],
  );
});

test("applyAgentRefresh 对同名 agent 幂等，不产生带后缀的重复工具", async () => {
  const model = sequencedModel([textStep("noop")]);
  const session = new AgentSession({
    id: "refresh-3",
    model,
    sources: [source("echo-agent", "echo")],
    maxSteps: 4,
  });

  session.applyAgentRefresh({
    source: source("echo-agent", "echo"),
    systemPrompt: "NEW_PROMPT",
  });

  const events = await collect(session.send("hi"));
  assert.ok(events.some((event) => event.type === "message-finish"));
});

test("agent_install 工具无 policy 也强制确认，批准后热刷新生效", async () => {
  const model = sequencedModel([
    toolCallStep("roll__agent_install", { agent: "probe" }),
    textStep("装好了"),
  ]);
  let installed = 0;
  const session = new AgentSession({
    id: "install-1",
    model,
    sources: [],
    maxSteps: 8,
    agentInstall: {
      catalog: [{ shortName: "probe", description: "测试 agent" }],
      install: async (shortName, report) => {
        installed += 1;
        report(`安装 ${shortName}...`);
        return {
          outcome: {
            ok: true,
            agentName: "probe-agent",
            missingEnv: [],
            refreshApplied: false,
          },
          refresh: {
            source: source("probe-agent", "run"),
            systemPrompt: "REFRESHED_PROMPT",
          },
        };
      },
    },
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("install probe")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId);
    }
  }

  const confirmation = events.find((event) => event.type === "confirmation-required");
  assert.ok(confirmation && confirmation.type === "confirmation-required");
  assert.equal(confirmation.toolName, "agent_install");
  assert.equal(installed, 1);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === false);
  assert.match(JSON.stringify(toolResult.output), /下一轮对话开始可用/);
});

test("agent_install 被拒绝时不执行安装", async () => {
  const model = sequencedModel([
    toolCallStep("roll__agent_install", { agent: "probe" }),
    textStep("好的"),
  ]);
  let installed = 0;
  const session = new AgentSession({
    id: "install-2",
    model,
    sources: [],
    maxSteps: 8,
    agentInstall: {
      catalog: [{ shortName: "probe", description: "测试 agent" }],
      install: async () => {
        installed += 1;
        return {
          outcome: { ok: true, agentName: "probe-agent", missingEnv: [], refreshApplied: false },
        };
      },
    },
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("install probe")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.reject(event.approvalId, "不装了");
    }
  }

  assert.equal(installed, 0);
  const toolResult = events.find((event) => event.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result" && toolResult.isError === true);
  assert.match(JSON.stringify(toolResult.output), /已取消执行/);
});

test("send 支持附件输入并以 parts 数组持久化用户消息", async () => {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options);
      return streamChunks(textStep("看到了"));
    },
  });
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "attachment-send",
    model,
    sources: [],
    maxSteps: 2,
    onPersist: (messages) => persisted.push([...messages]),
  });
  try {
    await collect(
      session.send({
        text: "看下这张截图",
        attachments: [{ data: "aGVsbG8=", mediaType: "image/png" }],
      }),
    );

    const storedUser = persisted[0]?.find((message) => message.role === "user");
    assert.deepEqual(storedUser?.content, [
      { type: "text", text: "看下这张截图" },
      { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
    ]);

    const modelUser = calls[0]?.prompt.find((message) => message.role === "user");
    assert.ok(Array.isArray(modelUser?.content));
    const fileParts = modelUser.content.filter((part) => part.type === "file");
    assert.equal(fileParts.length, 1);
    assert.equal(fileParts[0]?.mediaType, "image/png");

    await collect(session.send("纯文本跟进"));
    const followUp = persisted[1]?.find((message) => message.role === "user");
    assert.equal(followUp?.content, "纯文本跟进");
  } finally {
    await session.close();
  }
});

test("send 对无效附件在开始回合前抛错", async () => {
  const session = new AgentSession({
    id: "attachment-invalid",
    model: sequencedModel([textStep("unused")]),
    sources: [],
    maxSteps: 2,
  });
  try {
    await assert.rejects(
      collect(session.send({ text: "x", attachments: [{ data: "", mediaType: "image/png" }] })),
      /data 不能为空/u,
    );
    const events = await collect(session.send("正常继续"));
    assert.ok(events.some((event) => event.type === "text-delta"));
  } finally {
    await session.close();
  }
});

test("AgentSession 注册文件工具并按 role 标记 capability", async () => {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options);
      return streamChunks(textStep("done"));
    },
  });
  const session = new AgentSession({
    id: "file-tools-capability",
    model,
    sources: [],
    maxSteps: 2,
    fileTools: { workdir: process.cwd() },
  });
  try {
    const tools = session.getCapabilityManifest().tools;
    assert.equal(
      tools.find((tool) => tool.role === "file-read" && tool.id === "roll__read_file")?.id,
      "roll__read_file",
    );
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__edit_file"));
    assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__write_file"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__list_dir"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__grep"));
    assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__glob"));
    assert.ok(tools.some((tool) => tool.role === "file-verify" && tool.id === "roll__verify_file"));
    await collect(session.send("hi"));
    assert.match(JSON.stringify(calls[0]?.tools), /roll__edit_file/u);
  } finally {
    await session.close();
  }
});

test("appendInterruptedTurnMessages 在 pending 工具未入账时拒绝写入终态", () => {
  const persisted: ModelMessage[][] = [];
  const session = new AgentSession({
    id: "interrupted-write-gate",
    model: sequencedModel([textStep("unused")]),
    sources: [],
    maxSteps: 1,
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
  });
  const events: SessionEvent[] = [];
  const queue = {
    push: (event: SessionEvent) => {
      events.push(event);
    },
  };
  const internals = session as unknown as {
    appendInterruptedTurnMessages(
      queue: { push(event: SessionEvent): void },
      activeTurn: { pendingToolCalls: ReadonlyMap<string, unknown> },
      turnStartedAt: number,
      input: {
        rollbackTo: number;
        messages: readonly ModelMessage[];
        debugLabel: string;
        failureLabel: string;
      },
    ): boolean;
  };
  const marker: ModelMessage = { role: "assistant", content: "终态" };

  const blocked = internals.appendInterruptedTurnMessages(
    queue,
    { pendingToolCalls: new Map([["c1", {}]]) },
    0,
    { rollbackTo: 0, messages: [marker], debugLabel: "gate test", failureLabel: "终态持久化失败" },
  );

  assert.equal(blocked, false);
  assert.deepEqual(session.getMessages(), []);
  assert.deepEqual(persisted, []);
  const gateError = events.find(
    (event): event is Extract<SessionEvent, { type: "error" }> => event.type === "error",
  );
  assert.match(gateError?.message ?? "", /终态持久化失败: 存在未写入账本的待处理工具调用/u);

  const allowed = internals.appendInterruptedTurnMessages(
    queue,
    { pendingToolCalls: new Map() },
    0,
    { rollbackTo: 0, messages: [marker], debugLabel: "gate test", failureLabel: "终态持久化失败" },
  );

  assert.equal(allowed, true);
  assert.equal(persisted.length, 1);
});

test("AgentSession 上下文溢出时仅宣告未执行的调用不再声称已开始执行", async () => {
  const persisted: ModelMessage[][] = [];
  const model = sequencedModel([
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "echo-agent__echo",
        input: JSON.stringify({ q: "announced-only" }),
      },
      { type: "error", error: "context_length_exceeded" },
    ],
    textStep("must not run"),
  ]);
  let toolCalls = 0;
  const session = new AgentSession({
    id: "overflow-announced-only-note",
    model,
    sources: [
      source("echo-agent", "echo", () => {
        toolCalls += 1;
      }),
    ],
    maxSteps: 4,
    onPersist: (messages) => {
      persisted.push([...messages]);
    },
  });

  const events = await collect(session.send("tool loop"));

  assert.equal(events.at(-1)?.type, "error");
  assert.equal(toolCalls, 0);
  const flat = JSON.stringify(persisted);
  assert.match(flat, /not_executed/u);
  assert.match(flat, /本轮因上下文窗口溢出而中断/u);
  assert.doesNotMatch(flat, /已有操作开始执行/u);
});
