import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession } from "./agent-session.ts";
import type { SessionEvent } from "../types/events.ts";

for (const refresh of ["schema", "system", "provider"] as const) {
  test(`ordinary ${refresh} refresh invalidates incompatible residual, counts actual new prepared shape`, async () => {
    let calls = 0;
    let instructions = {
      path: "/fixture/AGENTS.md",
      content: "old",
      truncated: false,
      totalChars: 3,
    };
    const model = new MockLanguageModelV4({
      doStream: async (params) => {
        calls += 1;
        if (calls === 2 && refresh === "schema") {
          assert.ok(params.tools?.some((tool) => tool.name === "fresh__inspect"));
        }
        if (calls === 2 && refresh === "system") {
          assert.match(JSON.stringify(params.prompt), /new instruction/);
        }
        if (calls === 2 && refresh === "provider") {
          assert.deepEqual(params.providerOptions, { mock: { fixture: "changed" } });
        }
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
                  inputTokens: {
                    total: calls === 1 ? 9000 : 100,
                    noCache: 100,
                    cacheRead: calls === 1 ? 8900 : 0,
                    cacheWrite: 0,
                  },
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
    const session = new AgentSession({
      id: `refresh-${refresh}`,
      model,
      sources: [],
      maxSteps: 2,
      contextWindow: 10000,
      workspaceInstructions: { current: () => instructions },
      compaction: {
        enabled: false,
        strategy: "truncate",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 32,
      },
    });
    const collect = async (text: string) => {
      const events: SessionEvent[] = [];
      for await (const event of session.send(text)) events.push(event);
      return events;
    };
    try {
      await collect("first");
      const shape = session.getRequestBudgetState().last!.shapeFingerprint;
      if (refresh === "schema") {
        session.applyAgentRefresh({
          source: {
            agentName: "fresh",
            client: new Client({ name: "fixture", version: "1" }),
            tools: [
              {
                tool: {
                  name: "inspect",
                  description: "new schema",
                  inputSchema: { type: "object", properties: { description: { type: "string" } } },
                },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
      }
      if (refresh === "system") {
        instructions = { ...instructions, content: "new instruction", totalChars: 15 };
      }
      if (refresh === "provider") session.setProviderOptions({ mock: { fixture: "changed" } });
      const events = await collect("second small goal");
      assert.equal(calls, 2);
      assert.ok(events.some((event) => event.type === "message-finish"));
      assert.notEqual(session.getRequestBudgetState().last!.shapeFingerprint, shape);
      assert.equal(session.getRequestBudgetState().last!.calibrationResidual, 0);
    } finally {
      await session.close();
    }
  });
}
