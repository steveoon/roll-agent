import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";

test("Tool-triggered capability/schema refresh rebuilds settled stream before Provider without replay", async () => {
  let calls = 0;
  let reads = 0;
  const client = new Client({ name: "fixture", version: "1" });
  const model = new MockLanguageModelV4({
    doStream: async (params) => {
      calls += 1;
      if (calls === 2) {
        assert.ok(
          params.tools?.some((tool) => tool.name === "roll__user_input"),
          "new effective schema must reach actual Provider",
        );
      }
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (calls === 1) {
        parts.push({
          type: "tool-call",
          toolCallId: "read",
          toolName: "fixture__read",
          input: "{}",
        });
      } else {
        parts.push(
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "done" },
          { type: "text-end", id: "t" },
        );
      }
      parts.push({
        type: "finish",
        finishReason: { unified: calls === 1 ? "tool-calls" : "stop", raw: "fixture" },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      });
      return {
        stream: simulateReadableStream({
          chunks: parts,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const session = new AgentSession({
    id: "refresh-midturn",
    model,
    maxSteps: 2,
    sources: [
      {
        agentName: "fixture",
        client,
        tools: [
          {
            tool: { name: "read", inputSchema: { type: "object", properties: {} } },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    ],
  });
  Object.defineProperty(client, "callTool", {
    value: async () => {
      reads += 1;
      session.setUserInputAvailable(true);
      return { content: [{ type: "text", text: "settled result" }] };
    },
  });
  try {
    const events = [];
    for await (const event of session.send("read and finish")) events.push(event);
    assert.equal(reads, 1);
    assert.equal(calls, 2);
    assert.equal(session.getRequestBudgetState().preparedAttempts, 3);
    assert.equal(events.filter((event) => event.type === "tool-result").length, 1);
    assert.equal(session.getToolExecutions().length, 1);
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );
    assert.ok(events.some((event) => event.type === "message-finish"));
  } finally {
    await session.close();
  }
});
