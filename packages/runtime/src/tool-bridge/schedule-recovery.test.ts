import assert from "node:assert/strict";
import test from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "../engine/agent-session.ts";
import { SCHEDULE_CREATE_TOOL_ID } from "./schedule-tool.ts";

const legacy = {
  name: "probe",
  prompt: "noop",
  every: "1d",
  calendar: { frequency: "daily", time: "14:20" },
  rounds: 2,
};
const valid = {
  name: "probe",
  prompt: "noop",
  recurrence: { kind: "interval", every: "1m" },
  startAt: null,
  cwd: null,
  rounds: 2,
  maxRun: null,
};

function fixture(
  inputs: readonly unknown[],
  domainError = "config_error",
  contextPressure = false,
) {
  let calls = 0;
  let captures = 0;
  const session = new AgentSession({
    id: "schedule-recovery",
    sources: [],
    maxSteps: 8,
    ...(contextPressure
      ? {
          contextWindow: 200,
          compaction: {
            enabled: true,
            strategy: "truncate" as const,
            threshold: 0.75,
            keepRecentTurns: 1,
            keepRecentTokens: 1,
          },
        }
      : {}),
    model: new MockLanguageModelV4({
      doStream: async () => {
        const input = inputs[calls];
        calls += 1;
        const chunks: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: [] },
          ...(input === undefined
            ? [
                { type: "text-start", id: "answer" } as const,
                { type: "text-delta", id: "answer", delta: "已读取错误，请修正配置。" } as const,
                { type: "text-end", id: "answer" } as const,
              ]
            : [
                {
                  type: "tool-call",
                  toolCallId: `call-${String(calls)}`,
                  toolName: SCHEDULE_CREATE_TOOL_ID,
                  input: JSON.stringify(input),
                } as const,
              ]),
          {
            type: "finish",
            usage: {
              inputTokens: {
                total: contextPressure ? 180 : 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            finishReason: { unified: input === undefined ? "stop" : "tool-calls", raw: "fixture" },
          },
        ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    }),
    schedules: {
      sessionCwd: process.cwd(),
      port: {
        captureCreate: () => {
          captures += 1;
          return { ok: false, code: domainError, message: "fixture failure" };
        },
        create: () => {
          throw new Error("must not write a ledger");
        },
        list: () => {
          throw new Error("must not read a ledger");
        },
      },
    },
  });
  return {
    session,
    get calls() {
      return calls;
    },
    get captures() {
      return captures;
    },
    send: async () => {
      let output = "";
      for await (const event of session.send("今天 14:20，每隔 1 分钟，两轮结束")) {
        if (event.type === "text-delta") output += event.delta;
        assert.notEqual(event.type, "confirmation-required");
      }
      return output;
    },
  };
}

test("identical invalid create calls stop before a third attempt, with a visible reason, and reset next turn", async () => {
  const reordered = Object.fromEntries(Object.entries(legacy).reverse());
  const f = fixture([legacy, reordered, legacy, reordered]);
  try {
    assert.match(await f.send(), /已停止本轮自动重试/u);
    assert.equal(f.calls, 2);
    assert.equal(f.captures, 0);
    assert.match(await f.send(), /已停止本轮自动重试/u);
    assert.equal(f.calls, 4);
    assert.equal(f.captures, 0);
  } finally {
    await f.session.close();
  }
});

test("changed input can repair a schema error; unrelated operational failures are not blocked", async () => {
  const f = fixture([legacy, valid, valid]);
  try {
    assert.doesNotMatch(await f.send(), /已停止本轮自动重试/u);
    assert.equal(f.calls, 4);
    // Coordinator captures at batch preflight and execution; these are not writes.
    assert.equal(f.captures, 4);
  } finally {
    await f.session.close();
  }
});

test("repeated domain-invalid schedule input is also bounded", async () => {
  const f = fixture([valid, valid, valid], "schedule_trigger_invalid");
  try {
    assert.match(await f.send(), /已停止本轮自动重试/u);
    assert.equal(f.calls, 2);
    assert.equal(f.captures, 4);
  } finally {
    await f.session.close();
  }
});

test("context-pressure continuation cannot restart a stopped invalid schedule loop", async () => {
  const f = fixture([legacy, legacy, legacy, legacy], "config_error", true);
  try {
    assert.match(await f.send(), /已停止本轮自动重试/u);
    assert.equal(f.calls, 2);
    assert.equal(f.captures, 0);
  } finally {
    await f.session.close();
  }
});
