import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession, type AgentSessionOptions } from "./agent-session.ts";
import { estimatePreparedRequest } from "./request-budget.ts";
import { ThreadStore } from "../store/thread-store.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import type { SessionEvent } from "../types/events.ts";

const settings = {
  enabled: true,
  strategy: "summarize",
  threshold: 0.75,
  keepRecentTurns: 1,
  keepRecentTokens: 1,
  maxOutputTokens: 512,
} satisfies NonNullable<AgentSessionOptions["compaction"]>;

function usage(input = 100) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function summaryResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(),
    warnings: [],
  };
}

function response(
  params: LanguageModelV4CallOptions,
  text: string,
  toolCallId?: string,
  toolName = "fixture__write",
  input = "{}",
) {
  const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (toolCallId !== undefined) {
    chunks.push({ type: "tool-call", toolCallId, toolName, input });
  } else {
    chunks.push(
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: text },
      { type: "text-end", id: "text" },
    );
  }
  chunks.push({
    type: "finish",
    finishReason: { unified: toolCallId === undefined ? "stop" : "tool-calls", raw: "fixture" },
    usage: usage(
      estimatePreparedRequest(params, { provider: "mock", model: "summary-fixture" }, 0)
        .rawInputEstimate,
    ),
  });
  return {
    stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
  };
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const collected: SessionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function assertSuccess(events: readonly SessionEvent[]): void {
  assert.deepEqual(
    events.filter((event) => event.type === "error"),
    [],
  );
  assert.ok(events.some((event) => event.type === "message-finish"));
}

function assertPaired(
  messages: readonly ModelMessage[] | LanguageModelV4CallOptions["prompt"],
): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") {
        assert.ok(!pending.has(part.toolCallId));
        pending.add(part.toolCallId);
      } else if (part.type === "tool-result") {
        assert.ok(pending.delete(part.toolCallId), `orphan tool result ${part.toolCallId}`);
      }
    }
  }
  assert.deepEqual([...pending], []);
}

function persistedSession(
  store: ThreadStore,
  id: string,
  options: Omit<AgentSessionOptions, "id" | "initialMessages" | "initialCheckpoint">,
): AgentSession {
  const state = store.loadSessionState(id);
  return new AgentSession({
    ...options,
    id,
    initialMessages: state.messages,
    ...(state.checkpoint === undefined ? {} : { initialCheckpoint: state.checkpoint }),
    onAcceptInput: (inputId, message) => store.acceptTurnInput(id, inputId, message),
    onPersist: (messages, appendOptions) => store.appendMessages(id, messages, appendOptions),
    onReplace: (messages) => store.replaceMessages(id, messages),
    onToolExecution: (record) => store.appendToolExecution(id, record),
    listToolExecutions: (readOptions) => store.listToolExecutions(id, readOptions),
    getToolExecution: (executionId) => store.getToolExecution(id, executionId),
    listTranscriptMessages: (readOptions) => store.listTranscriptMessages(id, readOptions),
    commitCompaction: (input) => store.commitCompaction(id, input),
    readCheckpointTranscript: (readOptions) => store.readCheckpointTranscript(id, readOptions),
  });
}

function writer(path: string, content: string): AgentToolSource {
  const client = new Client({ name: "summary-fixture", version: "1" });
  Object.defineProperty(client, "callTool", {
    value: async () => {
      appendFileSync(path, "effect\n");
      return { content: [{ type: "text", text: content }] };
    },
  });
  return {
    agentName: "fixture",
    client,
    tools: [
      {
        tool: { name: "write", inputSchema: { type: "object", properties: {} } },
        annotations: { destructiveHint: true },
      },
    ],
  };
}

test("image history compacts, retains original media in SQLite and continues after reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-summary-media-"));
  let store = new ThreadStore(directory);
  const id = store.createThread();
  const image = "QUJD".repeat(250_000);
  const history: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect the screenshot" },
        { type: "image", image, mediaType: "image/png" },
      ],
    },
    { role: "assistant", content: "Observed a red button. " + "original detail ".repeat(2000) },
    { role: "user", content: "Continue with the red button" },
  ];
  store.appendMessages(id, history);
  const model = new MockLanguageModelV4({
    doGenerate: async (params) => {
      const prompt = JSON.stringify(params.prompt);
      assert.ok(!prompt.includes(image));
      assert.match(prompt, /Observed a red button/);
      return summaryResult(
        "The screenshot was previously described as showing a red button; continue the task.",
      );
    },
    doStream: async (params) => {
      assert.match(JSON.stringify(params.prompt), /red button/);
      assert.ok(!JSON.stringify(params.prompt).includes(image));
      return response(params, "Continuing with the red button.");
    },
  });
  let session: AgentSession | undefined;
  try {
    const options = {
      model,
      sources: [],
      maxSteps: 4,
      contextWindow: 128_000,
      compaction: settings,
    };
    session = persistedSession(store, id, options);
    const events = await collect(session.compact());
    assert.deepEqual(
      events.filter((event) => event.type === "error"),
      [],
    );
    assert.ok(events.some((event) => event.type === "context-compacted" && event.removed === 2));
    assert.equal(model.doGenerateCalls.length, 1);
    assert.deepEqual(store.getMessages(id), history.slice(2));
    await session.close();
    session = undefined;
    store.close();
    store = new ThreadStore(directory);
    assert.deepEqual(
      store.listTranscriptMessages(id).map((entry) => entry.message),
      history,
    );
    session = persistedSession(store, id, options);
    assertSuccess(await collect(session.send("Proceed")));
    assert.equal(model.doStreamCalls.length, 1);
  } finally {
    await session?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plain summaries survive three SQLite reopen cycles while recent originals and tool effects remain intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-summary-cycles-"));
  let store = new ThreadStore(directory);
  const id = store.createThread();
  const effectPath = join(directory, "effects.txt");
  const oldHistory: ModelMessage[] = [
    { role: "user", content: "historical request" },
    { role: "assistant", content: "historical detail ".repeat(2_000) },
  ];
  store.appendMessages(id, oldHistory);
  let calls = 0;
  let summaries = 0;
  const prompts: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (params) => {
      summaries++;
      if (summaries > 1) {
        assert.match(
          JSON.stringify(params.prompt),
          new RegExp(`task-summary-${summaries - 1}`, "u"),
        );
      }
      assert.ok(!params.tools?.length);
      return summaryResult(
        `task-summary-${summaries}: continue requested work; completed write remains completed.`,
      );
    },
    doStream: async (params) => {
      prompts.push(params);
      assertPaired(params.prompt);
      calls++;
      return response(
        params,
        `progress-${calls} ${"retained original ".repeat(1_500)}`,
        calls === 1 ? "write-once" : undefined,
      );
    },
  });
  let session: AgentSession | undefined;
  try {
    let priorCheckpointId: string | undefined;
    for (let cycle = 1; cycle <= 3; cycle++) {
      session = persistedSession(store, id, {
        model,
        sources: [writer(effectPath, "original-tool-tail" + "x".repeat(6_000))],
        maxSteps: 4,
        contextWindow: 200_000,
        compaction: settings,
        policy: { check: () => ({ action: "allow" }) },
      });
      assert.ok(
        session.getCapabilityManifest().tools.some((tool) => tool.id === "roll__transcript"),
      );
      assert.ok(session.getCapabilityManifest().tools.every((tool) => tool.id !== "roll__context"));
      assertSuccess(await collect(session.send(`current-user-${cycle}`)));
      const before = [...session.getMessages()];
      const currentIndex = before.findIndex(
        (message) => message.role === "user" && message.content === `current-user-${cycle}`,
      );
      assert.ok(currentIndex >= 0);
      const recent = before.slice(currentIndex);
      const events = await collect(session.compact());
      const committed = events.find(
        (event) => event.type === "context-compacted" && event.removed > 0,
      );
      assert.ok(committed, JSON.stringify(events));
      assert.deepEqual(session.getMessages(), recent);
      assertPaired(session.getMessages());
      const checkpoint = store.getLatestCheckpoint(id);
      assert.ok(checkpoint?.version === 3);
      assert.equal(checkpoint.generation, cycle);
      assert.equal(
        checkpoint.taskSummary,
        `task-summary-${cycle}: continue requested work; completed write remains completed.`,
      );
      assert.equal(checkpoint.previousCheckpointId, priorCheckpointId);
      assert.equal(store.getContextRecovery(id), undefined);
      assert.equal(store.listUncoveredToolExecutions(id).length, 0);
      assert.equal(store.listToolExecutions(id).length, 1);
      assert.equal(readFileSync(effectPath, "utf8"), "effect\n");
      priorCheckpointId = checkpoint.id;
      await session.close();
      session = undefined;
      store.close();
      store = new ThreadStore(directory);
      const persistedRecent: unknown = JSON.parse(JSON.stringify(recent));
      assert.deepEqual(store.loadSessionState(id).messages, persistedRecent);
      assert.equal(store.getLatestCheckpoint(id)?.id, priorCheckpointId);
      assert.equal(store.listToolExecutions(id).length, 1);
    }
    assert.equal(summaries, 3);
    assert.equal(calls, 4);
    assert.ok(
      prompts.slice(2).some((call) => JSON.stringify(call.prompt).includes("task-summary-1")),
    );
    assert.ok(prompts.every((call) => !JSON.stringify(call.tools).includes("roll__context")));
    assert.equal(
      store
        .listTranscriptMessages(id, { limit: 100 })
        .filter(
          (entry) =>
            entry.message.role === "user" &&
            typeof entry.message.content === "string" &&
            entry.message.content.startsWith("current-user-"),
        ).length,
      3,
    );
  } finally {
    await session?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one long tool turn continues through repeated automatic summaries without replaying settled effects", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "roll-summary-turn-"));
  const store = new ThreadStore(directory);
  const id = store.createThread();
  const effectPath = join(directory, "effects.txt");
  let calls = 0;
  let summaries = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      summaryResult(
        `Summary ${++summaries}: the preceding numbered writes completed; continue the remaining writes.`,
      ),
    doStream: async (params) => {
      assertPaired(params.prompt);
      assert.match(JSON.stringify(params.prompt), /current-user-anchor/u);
      calls++;
      return response(params, "finished all effects", calls <= 8 ? `write-${calls}` : undefined);
    },
  });
  const session = persistedSession(store, id, {
    model,
    sources: [writer(effectPath, "large settled tool output ".repeat(700))],
    maxSteps: 12,
    contextWindow: 18_000,
    compaction: { ...settings, threshold: 0.6 },
    policy: { check: () => ({ action: "allow" }) },
  });
  try {
    const events = await collect(
      session.send("current-user-anchor: perform eight separate writes, then finish"),
    );
    assertSuccess(events);
    assert.equal(calls, 9);
    assert.ok(summaries >= 3, `only ${summaries} summary calls`);
    t.diagnostic(`${summaries} automatic summaries, ${calls} provider streams, 8 distinct effects`);
    assert.equal(
      events.filter((event) => event.type === "context-compacted" && event.removed > 0).length,
      summaries,
    );
    assert.equal(readFileSync(effectPath, "utf8"), "effect\n".repeat(8));
    assert.equal(store.listToolExecutions(id).length, 8);
    assert.equal(new Set(store.listToolExecutions(id).map((record) => record.toolCallId)).size, 8);
    assert.equal(store.listUncoveredToolExecutions(id).length, 0);
    assert.equal(store.getContextRecovery(id), undefined);
    assertPaired(session.getMessages());
  } finally {
    await session.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function oldMessages(): ModelMessage[] {
  return Array.from({ length: 20 }, (_, index) => [
    { role: "user" as const, content: `old-${index} ${"x".repeat(900)}` },
    { role: "assistant" as const, content: "previous response" },
  ]).flat();
}

async function rawRequestEstimate(
  messages: readonly ModelMessage[],
  input: string,
): Promise<number> {
  const model = new MockLanguageModelV4({ doStream: async (params) => response(params, "warm") });
  const session = new AgentSession({
    id: "measure-summary-fixture",
    model,
    sources: [],
    maxSteps: 1,
    initialMessages: messages,
  });
  try {
    assertSuccess(await collect(session.send(input)));
    const budget = session.getRequestBudgetState().last;
    assert.ok(budget);
    return budget.rawInputEstimate;
  } finally {
    await session.close();
  }
}

for (const failure of [
  "provider-error",
  "summary-timeout",
  "empty-summary",
  "larger-summary",
] as const) {
  test(`soft target with ${failure} retains originals and continues once without a recovery gate`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "roll-summary-soft-"));
    const store = new ThreadStore(directory);
    const id = store.createThread();
    const original = oldMessages();
    store.appendMessages(id, original);
    const input = "accepted-soft-input";
    const raw = await rawRequestEstimate(original, input);
    const deadline = new AbortController();
    if (failure === "summary-timeout") {
      t.mock.method(AbortSignal, "timeout", (timeoutMs: number) => {
        assert.equal(timeoutMs, 120_000);
        return deadline.signal;
      });
    }
    let drafts = 0;
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        drafts++;
        if (failure === "provider-error") throw new Error("summary provider unavailable");
        if (failure === "summary-timeout") {
          deadline.abort(new DOMException("summary deadline", "TimeoutError"));
          return new Promise<never>(() => {});
        }
        return summaryResult(failure === "empty-summary" ? "" : "L".repeat(24_000));
      },
      doStream: async (params) => {
        calls++;
        assert.match(JSON.stringify(params.prompt), /old-0/u);
        assert.match(JSON.stringify(params.prompt), /accepted-soft-input/u);
        return response(params, "continued with originals");
      },
    });
    const session = persistedSession(store, id, {
      model,
      sources: [],
      maxSteps: 1,
      contextWindow: Math.ceil(raw / 0.8),
      compaction: settings,
    });
    try {
      const events = await collect(session.send(input));
      assertSuccess(events);
      assert.equal(drafts, 1);
      assert.equal(calls, 1);
      const started = events.findIndex((event) => event.type === "compaction-start");
      const settled = events.findIndex((event) => event.type === "context-compacted");
      assert.ok(started >= 0 && settled > started);
      const notice = events.find((event) => event.type === "context-compacted");
      assert.ok(notice?.type === "context-compacted");
      assert.deepEqual(
        notice.failure,
        failure === "summary-timeout"
          ? { reason: "timeout", timeoutMs: 120_000 }
          : failure === "larger-summary"
            ? undefined
            : { reason: "error" },
      );
      assert.ok(
        events.slice(settled + 1).some((event) => event.type === "message-start"),
        "failed maintenance must clear the compacting indicator before normal inference resumes",
      );
      assert.equal(store.getLatestCheckpoint(id), undefined);
      assert.deepEqual(store.getMessages(id).slice(0, -1), [
        ...original,
        { role: "user", content: input },
      ]);
      assert.ok(session.getRequestBudgetState().preparedAttempts <= 3);
      assert.equal(
        events.filter((event) => event.type === "context-compacted" && event.removed > 0).length,
        0,
      );
    } finally {
      await session.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("manual summary deadline reports its configured limit and preserves history", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (timeoutMs: number) => {
    assert.equal(timeoutMs, 23_456);
    return deadline.signal;
  });
  const original = oldMessages();
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      deadline.abort(new DOMException("summary deadline", "TimeoutError"));
      return new Promise<never>(() => {});
    },
  });
  const session = new AgentSession({
    id: "manual-summary-deadline",
    model,
    sources: [],
    maxSteps: 1,
    initialMessages: original,
    compaction: { ...settings, timeoutMs: 23_456 },
  });
  try {
    const events = await collect(session.compact("manual"));
    const notice = events.find((event) => event.type === "context-compacted");
    assert.ok(notice?.type === "context-compacted");
    assert.equal(notice.removed, 0);
    assert.equal(notice.checkpointId, undefined);
    assert.deepEqual(notice.failure, { reason: "timeout", timeoutMs: 23_456 });
    assert.deepEqual(session.getMessages(), original);
    assert.equal(model.doGenerateCalls.length, 1);
  } finally {
    await session.close();
  }
});

test("hard budget after failed summary ends explicitly and preserves accepted input across SQLite restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-summary-hard-"));
  let store = new ThreadStore(directory);
  const id = store.createThread();
  const original = oldMessages();
  store.appendMessages(id, original);
  const input = "accepted-hard-input-must-survive";
  const raw = await rawRequestEstimate(original, input);
  let drafts = 0;
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      drafts++;
      throw new Error("summary unavailable");
    },
    doStream: async (params) => {
      calls++;
      return response(params, "resumed");
    },
  });
  let session = persistedSession(store, id, {
    model,
    sources: [],
    maxSteps: 1,
    contextWindow: Math.floor(raw / 1.1),
    compaction: settings,
  });
  try {
    const events = await collect(session.send(input));
    assert.equal(calls, 0);
    assert.equal(drafts, 1);
    assert.ok(
      events.some(
        (event) =>
          event.type === "error" && /context_request_budget_unrecoverable/u.test(event.message),
      ),
      JSON.stringify(events),
    );
    assert.equal(store.getLatestCheckpoint(id), undefined);
    assert.deepEqual(store.getMessages(id), [...original, { role: "user", content: input }]);
    await session.close();
    store.close();
    store = new ThreadStore(directory);
    assert.deepEqual(store.getMessages(id), [...original, { role: "user", content: input }]);
    session = persistedSession(store, id, {
      model,
      sources: [],
      maxSteps: 1,
      contextWindow: 100_000,
      compaction: settings,
    });
    assertSuccess(await collect(session.send("continue with the accepted input")));
    assert.equal(calls, 1);
    assert.equal(
      store
        .listTranscriptMessages(id, { limit: 100 })
        .filter((entry) => entry.message.content === input).length,
      1,
    );
  } finally {
    await session.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("optional transcript chunk recall recovers a fact omitted from the task summary and uses it in the next answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-summary-recall-"));
  const store = new ThreadStore(directory);
  const id = store.createThread();
  const hiddenFact = "archived-fact-7319-fuchsia";
  store.appendMessages(id, [
    { role: "user", content: `${"x".repeat(12_000)}\nExact historical label: ${hiddenFact}` },
    { role: "assistant", content: "historical label saved" },
    { role: "user", content: "continue the current task" },
  ]);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      summaryResult("Continue the current task; retrieve exact historical details only if needed."),
    doStream: async (params) => {
      calls++;
      const prompt = JSON.stringify(params.prompt);
      assert.doesNotMatch(JSON.stringify(params.tools), /roll__context/u);
      if (calls === 1) {
        assert.doesNotMatch(prompt, new RegExp(hiddenFact, "u"));
        const checkpoint = store.getLatestCheckpoint(id);
        assert.ok(checkpoint);
        return response(
          params,
          "",
          "optional-recall",
          "roll__transcript",
          JSON.stringify({
            checkpointId: checkpoint.id,
            sequence: 0,
            offset: 11_000,
            maxChars: 4_000,
          }),
        );
      }
      assert.match(prompt, new RegExp(hiddenFact, "u"));
      assertPaired(params.prompt);
      return response(params, `Recovered exact historical label: ${hiddenFact}`);
    },
  });
  const session = persistedSession(store, id, {
    model,
    sources: [],
    maxSteps: 3,
    contextWindow: 50_000,
    compaction: settings,
  });
  try {
    const compacted = await collect(session.compact());
    assert.ok(compacted.some((event) => event.type === "context-compacted" && event.removed > 0));
    const events = await collect(session.send("retrieve and report the exact historical label"));
    assertSuccess(events);
    const finish = events.findLast((event) => event.type === "message-finish");
    assert.ok(finish?.type === "message-finish");
    assert.equal(finish.text, `Recovered exact historical label: ${hiddenFact}`);
    assert.equal(calls, 2);
    assert.equal(events.filter((event) => event.type === "confirmation-required").length, 0);
    assert.equal(store.getContextRecovery(id), undefined);
  } finally {
    await session.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
