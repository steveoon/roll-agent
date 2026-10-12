import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { AgentSession } from "./agent-session.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";
import { createEmptyCompactionModelDraft } from "./compaction-semantic-state.ts";
import type { SessionEvent } from "../types/events.ts";

const presentedSchema = z.object({
  evidence: z.array(z.object({ evidenceId: z.string(), kind: z.string() })),
});

test("coverage-only passes fairly advance both durable lanes without replacing protected active history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-coverage-only-"));
  let store = new ThreadStore(dir);
  const id = store.createThread();
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: "user" as const,
    content: `message ${index}`,
  }));
  store.appendMessages(id, messages);
  const recordIds = Array.from({ length: 40 }, (_, index) => {
    const record = createToolExecutionRecord({
      toolCallId: `done-${index}`,
      agentName: "fixture",
      toolName: "read",
      input: {},
      result: successfulToolResult(`result ${index}`),
    });
    store.appendToolExecution(id, record);
    return record.id;
  });
  let drafts = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (params) => {
      drafts += 1;
      const serialized = params.prompt
        .flatMap((message) =>
          message.role === "user"
            ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            : [],
        )
        .join("\n");
      const json = /<harness-evidence>\n([\s\S]+)\n<\/harness-evidence>/.exec(serialized)?.[1];
      assert.ok(json);
      const presented = presentedSchema.parse(JSON.parse(json)).evidence;
      assert.ok(presented.length <= 32);
      assert.ok([...json].length <= 48000);
      assert.ok(presented.some((entry) => entry.kind === "message"));
      assert.ok(presented.some((entry) => entry.kind === "tool_execution"));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...createEmptyCompactionModelDraft(),
              evidenceReviews: presented.map((entry) => ({
                evidenceId: entry.evidenceId,
                disposition: "irrelevant",
                reason: "bounded review fixture",
              })),
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 100, text: 100, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const session = new AgentSession({
    id,
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: store.getMessages(id),
    listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
    listToolExecutions: (options) => store.listToolExecutions(id, options),
    getToolExecution: (executionId) => store.getToolExecution(id, executionId),
    commitCompaction: (input) => store.commitCompaction(id, input),
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 100,
      keepRecentTokens: 100000,
    },
  });
  try {
    let previousMessage = -1;
    let previousTool = -1;
    for (let pass = 0; pass < 3; pass += 1) {
      const events: SessionEvent[] = [];
      for await (const event of session.compact("manual")) events.push(event);
      assert.deepEqual(
        events.filter((event) => event.type === "error"),
        [],
      );
      const checkpoint = store.getLatestCheckpoint(id);
      assert.ok(checkpoint?.version === 2);
      assert.ok(checkpoint.semanticEvidence.messagesThroughSequence > previousMessage);
      assert.ok(checkpoint.semanticEvidence.toolExecutionsThroughSequence > previousTool);
      previousMessage = checkpoint.semanticEvidence.messagesThroughSequence;
      previousTool = checkpoint.semanticEvidence.toolExecutionsThroughSequence;
      assert.equal(checkpoint.generation, pass + 1);
      assert.deepEqual(store.getMessages(id), messages);
      assert.equal(events.find((event) => event.type === "context-compacted")?.removed, 0);
      if (pass === 0) {
        assert.ok(previousMessage < 39, "captured range is not validated coverage");
        assert.ok(previousTool < 39);
      }
    }
    assert.equal(previousMessage, 39);
    assert.equal(previousTool, 39);
    assert.equal(drafts, 3);
    await session.close();
    store.close();
    store = new ThreadStore(dir);
    const restored = store.getLatestCheckpoint(id);
    assert.ok(restored?.version === 2);
    assert.deepEqual(restored.semanticEvidence, {
      messagesThroughSequence: 39,
      toolExecutionsThroughSequence: 39,
    });
    assert.deepEqual(store.getMessages(id), messages);
    assert.deepEqual(
      store.listToolExecutions(id, { limit: 100 }).map((entry) => entry.id),
      recordIds,
    );
  } finally {
    await session.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
