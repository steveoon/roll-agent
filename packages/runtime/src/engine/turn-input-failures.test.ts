import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { SkillLibrary } from "@roll-agent/core/skills/library";
import { AgentSession } from "./agent-session.ts";
import type { SessionEvent } from "../types/events.ts";

async function drain(session: AgentSession, input: string) {
  const events: SessionEvent[] = [];
  for await (const event of session.send(input)) events.push(event);
  return events;
}
function textModel(onCall: () => void) {
  return new MockLanguageModelV4({
    doStream: async () => {
      onCall();
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

test("failed acceptance does not claim durable input or infer, and session remains reusable", async () => {
  let calls = 0;
  let failing = true;
  const persisted: ModelMessage[] = [];
  const session = new AgentSession({
    id: "acceptance-failure",
    model: textModel(() => {
      calls += 1;
    }),
    sources: [],
    maxSteps: 1,
    onPersist: (messages) => {
      if (failing) throw new Error("acceptance disk failed");
      persisted.push(...messages);
    },
  });
  try {
    const events = await drain(session, "not accepted");
    assert.ok(
      events.some((event) => event.type === "error" && /输入持久化失败/.test(event.message)),
    );
    assert.deepEqual(session.getMessages(), []);
    assert.equal(calls, 0);
    failing = false;
    await drain(session, "accepted");
    assert.equal(calls, 1);
    assert.equal(persisted.filter((message) => message.role === "user").length, 1);
  } finally {
    await session.close();
  }
});

for (const pressure of ["soft", "hard"] as const) {
  test(`real pre-turn summary failure retains accepted input under ${pressure} request pressure`, async () => {
    let inferenceCalls = 0;
    let summaryCalls = 0;
    let replacements = 0;
    const persisted: ModelMessage[] = [];
    const original: ModelMessage[] = [
      { role: "user", content: "older" },
      { role: "assistant", content: "x".repeat(2000) },
    ];
    const inference = textModel(() => {
      inferenceCalls += 1;
    });
    const session = new AgentSession({
      id: `precompact-provider-failure-${pressure}`,
      sources: [],
      maxSteps: 1,
      model: new MockLanguageModelV4({
        doStream: (options) => inference.doStream(options),
        doGenerate: async () => {
          summaryCalls += 1;
          throw new Error("ECONNRESET");
        },
      }),
      initialMessages: original,
      contextWindow: 20_000,
      // This overhead affects only the task request; the complete summary source still fits.
      ...(pressure === "hard" ? { systemPrompt: "mandatory system context ".repeat(4000) } : {}),
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.01,
        keepRecentTurns: 1,
        keepRecentTokens: 1,
      },
      onPersist: (messages) => persisted.push(...messages),
      onReplace: () => {
        replacements += 1;
      },
    });
    try {
      const events = await drain(session, "new accepted input");
      assert.equal(summaryCalls, 1, "one failed summary attempt per unchanged request");
      assert.equal(replacements, 0, "summary failure must not replace the original context");
      assert.deepEqual(session.getMessages().slice(0, original.length), original);
      assert.deepEqual(
        persisted.filter((message) => message.role === "user"),
        [{ role: "user", content: "new accepted input" }],
      );
      if (pressure === "soft") {
        assert.equal(inferenceCalls, 1);
        assert.equal(
          events.some((event) => event.type === "error"),
          false,
        );
        assert.equal(events.at(-1)?.type, "message-finish");
      } else {
        assert.equal(inferenceCalls, 0);
        assert.ok(
          events.some(
            (event) =>
              event.type === "error" && /context_request_budget_unrecoverable/u.test(event.message),
          ),
        );
        assert.deepEqual(persisted, [{ role: "user", content: "new accepted input" }]);
        assert.equal(session.getMessages().at(-1)?.content, "new accepted input");
      }
    } finally {
      await session.close();
    }
  });
}

for (const termination of ["cancel", "timeout"] as const) {
  test(`${termination} during synchronous Skill loading retains input and never starts inference`, async () => {
    let calls = 0;
    let metadataWrites = 0;
    const persisted: ModelMessage[] = [];
    const summary = { name: "demo", description: "fixture", source: "project" as const };
    const library: SkillLibrary = {
      list: () => [summary],
      load: () => {
        if (termination === "cancel") session.cancel();
        else {
          const end = Date.now() + 30;
          while (Date.now() < end) {
            /* emulate slow synchronous read */
          }
        }
        return { summary, content: "PRIVATE_SKILL_BODY", referencePaths: [] };
      },
      loadReference: () => undefined,
    };
    const session = new AgentSession({
      id: `skill-${termination}`,
      model: textModel(() => {
        calls += 1;
      }),
      sources: [],
      maxSteps: 1,
      skillLibrary: library,
      ...(termination === "timeout" ? { turnTimeoutMs: 10 } : {}),
      onPersist: (messages) => persisted.push(...messages),
      onRecordInputSkillCheckpoint: () => {
        metadataWrites += 1;
      },
    });
    try {
      const events = await drain(session, "/demo saved request");
      assert.equal(calls, 0);
      assert.equal(metadataWrites, 0);
      assert.equal(
        persisted.filter(
          (message) => message.role === "user" && message.content === "/demo saved request",
        ).length,
        1,
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === "turn-cancelled" &&
            event.reason === (termination === "cancel" ? "user" : "timeout"),
        ),
      );
      assert.doesNotMatch(JSON.stringify(persisted), /PRIVATE_SKILL_BODY/);
      await drain(session, "next goal");
      assert.equal(calls, 1);
    } finally {
      await session.close();
    }
  });
}
