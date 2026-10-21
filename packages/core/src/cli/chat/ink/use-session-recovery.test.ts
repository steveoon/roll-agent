import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render, cleanup } from "ink-testing-library";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "@roll-agent/runtime";
import { useSession } from "./use-session.ts";

afterEach(() => cleanup());

test("useSession flushes buffered deltas before recovery and never resurrects the discarded draft", async () => {
  const offline = new Error("typed-offline");
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r" },
        {
          type: "reasoning-delta",
          id: "r",
          delta: calls === 1 ? "discarded-reasoning" : "final-reasoning",
        },
        { type: "reasoning-end", id: "r" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: calls === 1 ? "discarded-text" : "final-answer" },
        { type: "text-end", id: "t" },
        ...(calls === 1
          ? [{ type: "error" as const, error: offline }]
          : [
              {
                type: "finish" as const,
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
                finishReason: { unified: "stop" as const, raw: "stop" },
              },
            ]),
      ];
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
  const session = new AgentSession({
    id: "buffer-recovery",
    model,
    sources: [],
    maxSteps: 4,
    modelRecovery: { isRecoverable: (error) => error === offline, prepare: async () => {} },
  });
  let current: ReturnType<typeof useSession> | undefined;
  function Harness() {
    current = useSession(session, { model: "fixture", contextWindow: undefined });
    return null;
  }
  const view = render(h(Harness));
  try {
    assert.ok(current);
    current.submit("one-user");
    for (let n = 0; n < 100 && !current.state.live.recovering; n++) await delay(10);
    assert.equal(current.state.phase, "busy");
    assert.equal(current.state.live.recovering, true);
    assert.doesNotMatch(JSON.stringify(current.state.history), /discarded/);
    const isIdle = () => current?.state.phase === "idle";
    for (let n = 0; n < 200 && !isIdle(); n++) await delay(10);
    assert.equal(current.state.phase, "idle");
    assert.doesNotMatch(JSON.stringify(current.state.history), /discarded/);
    assert.equal(current.state.history.filter((item) => item.kind === "user").length, 1);
    assert.equal(current.state.history.filter((item) => item.kind === "error").length, 0);
    assert.match(JSON.stringify(current.state.history), /final-answer/);
  } finally {
    view.unmount();
    await session.close();
  }
});
