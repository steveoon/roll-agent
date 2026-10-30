import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AgentSession, type AgentSessionOptions } from "./agent-session.ts";
import type { ModelTurnRecovery } from "./model-recovery.ts";
import type { SessionEvent } from "../types/events.ts";

const offline = new Error("typed-offline-fixture");
const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const recovery: ModelTurnRecovery = {
  isRecoverable: (error) => error === offline,
  prepare: async () => {},
};
const text = (value: string): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: value },
  { type: "text-end", id: "t" },
  { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
];
const call: LanguageModelV4StreamPart = {
  type: "tool-call",
  toolCallId: "c1",
  toolName: "fixture__write",
  input: '{"q":"once"}',
};
const tool = (): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  call,
  { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
];
const failure = (): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "error", error: offline },
];
function setup(steps: LanguageModelV4StreamPart[][], options: Partial<AgentSessionOptions> = {}) {
  let effects = 0;
  let index = 0;
  const persisted: ModelMessage[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: steps[index++] ?? failure(),
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
  const session = new AgentSession({
    id: "network-recovery",
    model,
    modelRecovery: recovery,
    maxSteps: 6,
    policy: { check: () => ({ action: "allow" }) },
    sources: [
      {
        agentName: "fixture",
        client: {
          callTool: async () => {
            effects += 1;
            return { content: [{ type: "text", text: "result-once session_id=42" }] };
          },
        } as unknown as Client,
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
    onPersist: (messages) => persisted.push(...messages),
    ...options,
  });
  return { session, model, persisted, effects: () => effects };
}
async function collect(session: AgentSession, clock?: TestContext) {
  if (clock) {
    clock.mock.timers.enable({ apis: ["setTimeout"] });
    // Keep the budget's named node:timers/promises import in sync with the mock.
    syncBuiltinESMExports();
    clock.after(() => {
      clock.mock.timers.reset();
      syncBuiltinESMExports();
    });
  }
  const events: SessionEvent[] = [];
  for await (const event of session.send("complete this task")) {
    events.push(event);
    if (clock && event.type === "model-recovery") {
      // Exercise the real five-attempt schedule without sleeping for 31 seconds.
      // model-recovery.test.ts checks both sides of every individual deadline.
      clock.mock.timers.tick(1_000 * 2 ** (event.attempt - 1));
    }
  }
  return events;
}

test("network recovery preserves completed tools and one accepted input in the same turn", async () => {
  const terminalErrors: unknown[] = [];
  const fixture = setup([tool(), failure(), text("done")], {
    modelRecovery: { ...recovery, onTurnEnd: (error) => terminalErrors.push(error) },
  });
  const events = await collect(fixture.session);
  assert.equal(fixture.model.doStreamCalls.length, 3);
  assert.equal(fixture.effects(), 1);
  assert.equal(fixture.persisted.filter((m) => m.role === "user").length, 1);
  assert.match(JSON.stringify(fixture.model.doStreamCalls[2]?.prompt), /result-once session_id=42/);
  assert.equal(
    events.some((e) => e.type === "error"),
    false,
  );
  assert.equal(events.filter((e) => e.type === "model-recovery").length, 1);
  assert.equal(events.at(-1)?.type, "message-finish");
  assert.deepEqual(terminalErrors, [undefined]);
  await fixture.session.close();
});

test("network recovery accumulates turn usage across segments and resets it for the next input", async () => {
  const measured = (parts: LanguageModelV4StreamPart[], input: number, output: number) =>
    parts.map(
      (part): LanguageModelV4StreamPart =>
        part.type !== "finish"
          ? part
          : {
              ...part,
              usage: {
                inputTokens: { total: input, noCache: input - 3, cacheRead: 2, cacheWrite: 1 },
                outputTokens: { total: output, text: output - 1, reasoning: 1 },
              },
            },
    );
  const fixture = setup([
    measured(tool(), 20, 10),
    failure(),
    measured(tool(), 30, 12),
    failure(),
    measured(text("done"), 40, 14),
    text("next turn"),
  ]);
  try {
    const events = await collect(fixture.session);
    const finish = events.find((event) => event.type === "message-finish");
    assert.ok(finish);
    assert.deepEqual(finish.totalUsage, {
      inputTokens: 90,
      outputTokens: 36,
      totalTokens: 126,
      cachedInputTokens: 6,
      cacheWriteTokens: 3,
      reasoningTokens: 3,
    });
    assert.deepEqual(finish.sessionUsage, finish.totalUsage);
    assert.equal(finish.contextInputTokens, 40);
    assert.equal(fixture.effects(), 2);
    assert.equal(events.filter((event) => event.type === "model-recovery").length, 2);
    const next = (await collect(fixture.session)).find((event) => event.type === "message-finish");
    assert.ok(next);
    assert.equal(next.totalUsage?.inputTokens, 2);
    assert.equal(next.totalUsage?.outputTokens, 1);
    assert.equal(next.totalUsage?.totalTokens, 3);
    assert.equal(next.sessionUsage?.totalTokens, 129);
    assert.equal(next.contextInputTokens, 2);
  } finally {
    await fixture.session.close();
  }
});

test("network recovery discards partial model output but preserves the original prompt", async () => {
  const fixture = setup([
    [...text("unfinished draft").slice(0, -1), { type: "error", error: offline }],
    text("final answer"),
  ]);
  const events = await collect(fixture.session);
  assert.equal(fixture.model.doStreamCalls.length, 2);
  assert.doesNotMatch(JSON.stringify(fixture.persisted), /unfinished draft/);
  assert.doesNotMatch(JSON.stringify(fixture.model.doStreamCalls[1]?.prompt), /unfinished draft/);
  assert.equal(events.at(-1)?.type, "message-finish");
  await fixture.session.close();
});

test("network recovery retires an unexecuted call and reapproves regenerated calls", async () => {
  const fixture = setup(
    [
      [{ type: "stream-start", warnings: [] }, call, { type: "error", error: offline }],
      tool(),
      text("done"),
    ],
    { policy: { check: () => ({ action: "confirm" }) } },
  );
  let approvals = 0;
  const events: SessionEvent[] = [];
  for await (const event of fixture.session.send("task")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      approvals += 1;
      fixture.session.approve(event.approvalId);
    }
  }
  assert.equal(approvals, 2);
  assert.equal(fixture.effects(), 1);
  assert.equal(events.at(-1)?.type, "message-finish");
  const records = fixture.session.getToolExecutions();
  assert.equal(records[0]?.outcome.kind, "cancelled");
  assert.match(JSON.stringify(records[0]?.outcome), /not_executed/);
  assert.equal(records[1]?.outcome.kind, "success");
  const results = events.filter((event) => event.type === "tool-result");
  assert.deepEqual(
    results.map((event) => ({ executionId: event.executionId, outcome: event.outcome })),
    records.map((record) => ({ executionId: record.id, outcome: record.outcome })),
  );
  assert.equal(results[0]?.isError, true);
  assert.ok(
    events.findIndex((event) => event === results[0]) <
      events.findIndex((event) => event.type === "model-recovery"),
  );
  await fixture.session.close();
});

test("network recovery respects cancellation in backoff without another request", async () => {
  const fixture = setup([failure(), text("must not run")]);
  const events: SessionEvent[] = [];
  for await (const event of fixture.session.send("complete this task")) {
    events.push(event);
    if (event.type === "model-recovery") fixture.session.cancel();
  }
  assert.equal(fixture.model.doStreamCalls.length, 1);
  assert.equal(events.at(-1)?.type, "turn-cancelled");
  assert.equal(fixture.session.canSwitchModel(), true);
  await fixture.session.close();
});

test("network recovery exhausts exactly five retries without SDK retry multiplication", async (t) => {
  const fixture = setup([failure()]);
  try {
    const events = await collect(fixture.session, t);
    assert.equal(fixture.model.doStreamCalls.length, 6);
    assert.deepEqual(
      events.filter((event) => event.type === "model-recovery").map((event) => event.attempt),
      [1, 2, 3, 4, 5],
    );
    assert.equal(events.filter((event) => event.type === "error").length, 1);
    assert.equal(fixture.persisted.filter((m) => m.role === "user").length, 1);
  } finally {
    await fixture.session.close();
  }
});

test("the fifth recovery can finish the original turn without replaying completed tools", async (t) => {
  const fixture = setup([
    tool(),
    ...Array.from({ length: 5 }, () => failure()),
    text("done on the fifth recovery"),
  ]);
  try {
    const events = await collect(fixture.session, t);
    assert.equal(fixture.model.doStreamCalls.length, 7);
    assert.equal(fixture.effects(), 1);
    assert.equal(fixture.session.getToolExecutions().length, 1);
    assert.equal(fixture.persisted.filter((message) => message.role === "user").length, 1);
    assert.deepEqual(
      events.filter((event) => event.type === "model-recovery").map((event) => event.attempt),
      [1, 2, 3, 4, 5],
    );
    assert.equal(events.filter((event) => event.type === "error").length, 0);
    assert.equal(events.at(-1)?.type, "message-finish");
    assert.match(
      JSON.stringify(fixture.model.doStreamCalls[6]?.prompt),
      /result-once session_id=42/,
    );
    assert.match(JSON.stringify(fixture.persisted), /done on the fifth recovery/);
  } finally {
    await fixture.session.close();
  }
});

test("network recovery keeps the original max-step budget across a recovered segment", async () => {
  const fixture = setup([tool(), failure(), tool(), text("must not run")], { maxSteps: 2 });
  const events = await collect(fixture.session);
  assert.equal(fixture.model.doStreamCalls.length, 3);
  assert.equal(fixture.effects(), 2);
  const finish = events.find((event) => event.type === "message-finish");
  assert.ok(finish?.stoppedAtStepLimit);
  assert.equal(finish.totalUsage?.inputTokens, 4);
  assert.equal(finish.totalUsage?.outputTokens, 2);
  assert.equal(finish.contextInputTokens, 2);
  assert.deepEqual(finish.totalUsage, finish.sessionUsage);
  await fixture.session.close();
});

test("network recovery respects the original deadline during backoff", async () => {
  const fixture = setup([failure(), text("must not run")], { turnTimeoutMs: 100 });
  const events = await collect(fixture.session);
  assert.equal(fixture.model.doStreamCalls.length, 1);
  assert.ok(events.some((event) => event.type === "turn-cancelled" && event.reason === "timeout"));
  await fixture.session.close();
});

test("network recovery never retries after completed-tool persistence fails", async () => {
  const fixture = setup([tool(), failure(), text("must not run")], {
    onToolExecution: () => {
      throw offline;
    },
  });
  const events = await collect(fixture.session);
  assert.equal(fixture.effects(), 1);
  assert.equal(events.filter((event) => event.type === "model-recovery").length, 0);
  assert.ok(events.some((event) => event.type === "error"));
  await fixture.session.close();
});

test("network recovery does not retry when message persistence fails before reconnection", async () => {
  const terminalErrors: unknown[] = [];
  const fixture = setup([tool(), failure(), text("must not run")], {
    modelRecovery: { ...recovery, onTurnEnd: (error) => terminalErrors.push(error) },
    onPersist: (messages) => {
      if (messages.some((message) => message.role === "tool")) throw new Error("disk failure");
    },
  });
  const events = await collect(fixture.session);
  assert.equal(fixture.effects(), 1);
  assert.equal(fixture.model.doStreamCalls.length, 2);
  assert.equal(events.filter((event) => event.type === "model-recovery").length, 0);
  assert.ok(events.some((event) => event.type === "error" && /disk failure/.test(event.message)));
  assert.deepEqual(terminalErrors, [offline]);
  await fixture.session.close();
});

test("network recovery rechecks approval and user refusal cannot resurrect a tool", async () => {
  const fixture = setup([failure(), tool(), text("must not run")], {
    policy: { check: () => ({ action: "confirm" }) },
  });
  let approvals = 0;
  for await (const event of fixture.session.send("task")) {
    if (event.type === "confirmation-required") {
      approvals += 1;
      fixture.session.reject(event.approvalId, "no");
    }
  }
  assert.equal(approvals, 1);
  assert.equal(fixture.effects(), 0);
  assert.equal(fixture.model.doStreamCalls.length, 2);
  await fixture.session.close();
});

test("network recovery cannot bypass a refusal made before the model stream fails", async () => {
  const fixture = setup(
    [
      [{ type: "stream-start", warnings: [] }, call, { type: "error", error: offline }],
      tool(),
      text("must not run"),
    ],
    { policy: { check: () => ({ action: "confirm" }) } },
  );
  const events: SessionEvent[] = [];
  for await (const event of fixture.session.send("task")) {
    events.push(event);
    if (event.type === "confirmation-required") fixture.session.reject(event.approvalId, "no");
  }
  assert.equal(fixture.model.doStreamCalls.length, 1);
  assert.equal(fixture.effects(), 0);
  assert.equal(events.filter((event) => event.type === "model-recovery").length, 0);
  await fixture.session.close();
});

test("network recovery never claims uncovered executed results are settled transcript", async () => {
  const terminalErrors: unknown[] = [];
  const fixture = setup([[...tool(), { type: "error", error: offline }], text("must not run")], {
    modelRecovery: { ...recovery, onTurnEnd: (error) => terminalErrors.push(error) },
  });
  const events = await collect(fixture.session);
  assert.equal(fixture.model.doStreamCalls.length, 1);
  assert.equal(events.filter((event) => event.type === "model-recovery").length, 0);
  assert.equal(events.at(-1)?.type, "error");
  assert.deepEqual(terminalErrors, [offline]);
  await fixture.session.close();
});

test("network recovery is cleared on provider switch", async () => {
  const fixture = setup([failure(), text("must not run")]);
  fixture.session.switchModel({ model: fixture.model });
  const events = await collect(fixture.session);
  assert.equal(fixture.model.doStreamCalls.length, 1);
  assert.equal(events.filter((event) => event.type === "model-recovery").length, 0);
  await fixture.session.close();
});

test("an error chunk followed by a success finish never admits the failed batch", async () => {
  const fixture = setup([
    [
      { type: "stream-start", warnings: [] },
      call,
      { type: "error", error: offline },
      { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
    ],
    text("done"),
  ]);
  try {
    const events = await collect(fixture.session);
    assert.equal(fixture.effects(), 0);
    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(events.at(-1)?.type, "message-finish");
    assert.match(JSON.stringify(fixture.session.getToolExecutions()), /not_executed/);
  } finally {
    await fixture.session.close();
  }
});

test("provider error completion cannot admit a partial tool batch", { timeout: 2000 }, async () => {
  const fixture = setup([
    [
      { type: "stream-start", warnings: [] },
      call,
      { type: "finish", usage, finishReason: { unified: "error", raw: "error" } },
    ],
  ]);
  try {
    const events = await collect(fixture.session);
    assert.equal(fixture.effects(), 0);
    assert.equal(fixture.model.doStreamCalls.length, 1);
    assert.equal(events.at(-1)?.type, "error");
    const cancelled = events.find((event) => event.type === "tool-result");
    assert.ok(cancelled);
    assert.equal(cancelled.executionId, fixture.session.getToolExecutions()[0]?.id);
    assert.deepEqual(cancelled.outcome, {
      kind: "cancelled",
      reason: "runtime",
      executionState: "not_executed",
    });
  } finally {
    await fixture.session.close();
  }
});

test("network recovery leaves generic provider errors terminal", async () => {
  const fixture = setup([
    [{ type: "error", error: new Error("login required") }],
    text("must not run"),
  ]);
  const events = await collect(fixture.session);
  assert.equal(fixture.model.doStreamCalls.length, 1);
  assert.equal(events.at(-1)?.type, "error");
  await fixture.session.close();
});
