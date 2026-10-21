import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";
import { estimatePreparedRequest } from "./request-budget.ts";
import { ThreadStore } from "../store/thread-store.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import type { SessionEvent } from "../types/events.ts";

for (const maxSteps of [2, 4]) {
  test(`two settled tools recover under full guard with maxSteps=${maxSteps}, no write replay`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-guard-continuation-"));
    let store = new ThreadStore(dir);
    const id = store.createThread();
    let calls = 0;
    let writes = 0;
    let reads = 0;
    const client = new Client({ name: "fixture", version: "1" });
    Object.defineProperty(client, "callTool", {
      value: async ({ name }: { name: string }) => {
        if (name === "write") {
          writes += 1;
          writeFileSync(join(dir, "effect"), "once");
        } else reads += 1;
        return { content: [{ type: "text", text: "R".repeat(name === "write" ? 27000 : 13000) }] };
      },
    });
    const source: AgentToolSource = {
      agentName: "fixture",
      client,
      tools: ["write", "read"].map((name) => ({
        tool: { name, inputSchema: { type: "object", properties: {} } },
        annotations: { readOnlyHint: name === "read" },
      })),
    };
    const model = new MockLanguageModelV4({
      doStream: async (params) => {
        calls += 1;
        const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
        if (calls <= 2) {
          chunks.push({
            type: "tool-call",
            toolCallId: `c${calls}`,
            toolName: calls === 1 ? "fixture__write" : "fixture__read",
            input: "{}",
          });
        } else {
          chunks.push(
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "finished" },
            { type: "text-end", id: "t" },
          );
        }
        chunks.push({
          type: "finish",
          finishReason: { unified: calls <= 2 ? "tool-calls" : "stop", raw: "fixture" },
          usage: {
            inputTokens: {
              total: estimatePreparedRequest(params, { provider: "mock", model: "fixture" }, 0)
                .rawInputEstimate,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const session = new AgentSession({
      id,
      model,
      sources: [source],
      maxSteps,
      contextWindow: 12000,
      policy: { check: () => ({ action: "allow" }) },
      compaction: {
        enabled: true,
        strategy: "truncate",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 1000,
      },
      onAcceptInput: (inputId, message) => store.acceptTurnInput(id, inputId, message),
      onPersist: (messages, options) => store.appendMessages(id, messages, options),
      onReplace: (messages) => store.replaceMessages(id, messages),
      onToolExecution: (record) => store.appendToolExecution(id, record),
      listToolExecutions: (options) => store.listToolExecutions(id, options),
      getToolExecution: (executionId) => store.getToolExecution(id, executionId),
      listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
      commitCompaction: (input) => store.commitCompaction(id, input),
    });
    // Separate fixture targets finalized guard; predictive stop is covered in unmodified Session suites.
    Object.defineProperty(session, "stopOnContextPressure", { value: () => () => false });
    try {
      const events: SessionEvent[] = [];
      for await (const event of session.send("write once, read, finish")) events.push(event);
      assert.equal(writes, 1);
      assert.equal(reads, 1);
      assert.equal(readFileSync(join(dir, "effect"), "utf8"), "once");
      assert.equal(store.listToolExecutions(id).length, 2);
      assert.equal(store.listUncoveredToolExecutions(id).length, 0);
      const finish = events
        .filter(
          (event): event is Extract<SessionEvent, { type: "message-finish" }> =>
            event.type === "message-finish",
        )
        .at(-1);
      assert.ok(finish);
      const measuredInput = events.reduce(
        (sum, event) => sum + (event.type === "step-finish" ? (event.usage?.inputTokens ?? 0) : 0),
        0,
      );
      assert.equal(finish.totalUsage?.inputTokens, measuredInput);
      assert.equal(finish.totalUsage?.outputTokens, calls);
      assert.deepEqual(finish.totalUsage, finish.sessionUsage);
      if (maxSteps === 2) {
        assert.equal(calls, 2);
        assert.equal(finish.stoppedAtStepLimit, true);
      } else {
        assert.equal(calls, 3);
        assert.equal(finish.text, "finished");
        assert.equal(session.getRequestBudgetState().comparison?.spaceImproved, true);
        assert.ok(session.getRequestBudgetState().preparedAttempts <= 8);
      }
      assert.equal(
        events.some((event) => event.type === "error"),
        false,
      );
      const executionIds = store.listToolExecutions(id).map((record) => record.id);
      await session.close();
      store.close();
      store = new ThreadStore(dir);
      assert.deepEqual(
        store.listToolExecutions(id).map((record) => record.id),
        executionIds,
      );
      assert.equal(store.listUncoveredToolExecutions(id).length, 0);
      assert.equal(readFileSync(join(dir, "effect"), "utf8"), "once");
      assert.equal(writes, 1);
    } finally {
      await session.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
