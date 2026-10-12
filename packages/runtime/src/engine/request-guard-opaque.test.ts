import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";
import { estimatePreparedRequest } from "./request-budget.ts";
import type { SessionEvent } from "../types/events.ts";

for (const opaque of [false, true]) {
  test(`half-window input completes six settled steps without replay, opaque=${opaque}`, async () => {
    let calls = 0;
    let effects = 0;
    const client = new Client({ name: "fixture", version: "1" });
    Object.defineProperty(client, "callTool", {
      value: async () => {
        effects += 1;
        return { content: [{ type: "text", text: "settled" }] };
      },
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
        if (calls <= 6) {
          chunks.push(
            { type: "reasoning-start", id: "r" },
            { type: "reasoning-delta", id: "r", delta: "think" },
            {
              type: "reasoning-end",
              id: "r",
              providerMetadata: {
                openai: { reasoningEncryptedContent: "A".repeat(opaque ? 25000 : 0) },
              },
            },
            { type: "tool-call", toolCallId: `c${calls}`, toolName: "fixture__work", input: "{}" },
          );
        } else {
          chunks.push(
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
          );
        }
        chunks.push({
          type: "finish",
          finishReason: { unified: calls <= 6 ? "tool-calls" : "stop", raw: "fixture" },
          usage: {
            inputTokens: { total: 5000, noCache: 5000, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 10, text: 1, reasoning: 9 },
          },
        });
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const session = new AgentSession({
      id: "half-window",
      model,
      maxSteps: 10,
      contextWindow: 10000,
      sources: [
        {
          agentName: "fixture",
          client,
          tools: [
            {
              tool: { name: "work", inputSchema: { type: "object", properties: {} } },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      ],
      compaction: {
        enabled: true,
        strategy: "truncate",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 1000,
      },
    });
    try {
      const events: SessionEvent[] = [];
      for await (const event of session.send("x".repeat(9000))) events.push(event);
      assert.deepEqual(
        events.filter((e) => e.type === "error"),
        [],
      );
      assert.equal(calls, 7);
      assert.equal(effects, 6);
      assert.equal(events.filter((e) => e.type === "message-finish").at(-1)?.text, "done");
      assert.ok(session.getRequestBudgetState().preparedAttempts <= 14);
    } finally {
      await session.close();
    }
  });
}

test("one send can finish three or more maintenance episodes after new tool progress", async () => {
  let calls = 0;
  let effects = 0;
  const client = new Client({ name: "fixture", version: "1" });
  Object.defineProperty(client, "callTool", {
    value: async () => {
      effects += 1;
      return { content: [{ type: "text", text: "result ".repeat(3600) }] };
    },
  });
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      calls += 1;
      const input = estimatePreparedRequest(
        params,
        { provider: "mock", model: "fixture" },
        0,
      ).rawInputEstimate;
      const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (calls <= 7) {
        chunks.push({
          type: "tool-call",
          toolCallId: `c${calls}`,
          toolName: "fixture__work",
          input: "{}",
        });
      } else {
        chunks.push(
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "done" },
          { type: "text-end", id: "t" },
        );
      }
      chunks.push({
        type: "finish",
        finishReason: { unified: calls <= 7 ? "tool-calls" : "stop", raw: "fixture" },
        usage: {
          inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      });
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
  const session = new AgentSession({
    id: "several-episodes",
    model,
    maxSteps: 8,
    turnTimeoutMs: 60000,
    contextWindow: 14000,
    sources: [
      {
        agentName: "fixture",
        client,
        tools: [
          {
            tool: { name: "work", inputSchema: { type: "object", properties: {} } },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    ],
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1000,
    },
  });
  try {
    const start = Date.now();
    const events: SessionEvent[] = [];
    for await (const event of session.send("complete seven operations")) events.push(event);
    assert.deepEqual(
      events.filter((e) => e.type === "error"),
      [],
    );
    assert.equal(calls, 8);
    assert.equal(effects, 7);
    const episodes = session.getMaintenanceEpisodes();
    assert.ok(episodes.length >= 3, JSON.stringify(episodes));
    assert.equal(new Set(episodes.map((e) => e.owner)).size, 1);
    assert.equal(new Set(episodes.map((e) => e.episodeId)).size, episodes.length);
    for (const episode of episodes) {
      assert.ok(episode.deadline <= start + 60000);
      assert.ok(episode.preparations <= episode.maxPreparations);
      assert.ok(episode.after);
      assert.ok(["ready", "advisory_target_miss"].includes(episode.reason ?? ""));
    }
  } finally {
    await session.close();
  }
});
