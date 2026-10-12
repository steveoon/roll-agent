import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, type ModelMessage } from "ai";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { estimatePreparedRequest } from "./request-budget.ts";
import { compactMessages, compactionEvidenceTokenBudget } from "./compactor.ts";
import {
  compactionSemanticStateSchema,
  createEmptyCompactionModelDraft,
  createEmptyCompactionSemanticState,
  replaceCompactionSemanticGoal,
  mergeCompactionSemanticState,
  validateCompactionModelDraft,
} from "./compaction-semantic-state.ts";
import { retainsCompactionFacts } from "./compaction-retention.ts";
import {
  createCompactionCheckpoint,
  createEmptyCompactionToolState,
} from "./compaction-checkpoint.ts";

const usage = (input = 100) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
});
const evidenceSchema = z.object({
  evidence: z.array(z.object({ evidenceId: z.string(), summary: z.string() })),
});
function evidence(params: LanguageModelV4CallOptions) {
  const text = params.prompt
    .flatMap((m) =>
      m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [],
    )
    .join("\n");
  const json = /<harness-evidence>\n([\s\S]+)\n<\/harness-evidence>/.exec(text)?.[1];
  assert.ok(json);
  return evidenceSchema.parse(JSON.parse(json)).evidence;
}
function generation(draft = createEmptyCompactionModelDraft()) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(draft) }],
    usage: usage(),
    warnings: [],
    finishReason: { unified: "stop" as const, raw: "stop" },
  };
}
const settings = {
  enabled: true,
  strategy: "summarize" as const,
  threshold: 0.75,
  keepRecentTurns: 1,
  keepRecentTokens: 1,
};

for (const count of [40, 128]) {
  test(`legacy checkpoint with ${count} completed facts can compact repeatedly without dropping new facts`, async () => {
    const base = replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
      verbatimRequest: "Keep limit 1739 exact.",
      sourceSequence: 0,
    });
    const state = compactionSemanticStateSchema.parse({
      ...base,
      completedWork: Array.from({ length: count }, (_, i) => {
        const text = `Historical completion ${i}: ${"x".repeat(128)}`;
        return {
          id: `semantic_completed_work_${i.toString(16).padStart(24, "0")}`,
          text,
          sourceQuotes: [text],
          provenance: base.goal!.provenance,
        };
      }),
    });
    const checkpoint = createCompactionCheckpoint({
      generation: 1,
      semanticState: state,
      draft: {
        goal: { verbatimRequest: "Keep limit 1739 exact.", sourceSequence: 0, status: "active" },
        constraints: [],
        resources: [],
        runningWork: [],
        toolState: createEmptyCompactionToolState(),
        summary: { status: "skipped" },
        context: { cwd: "/fixture", stableRuleIds: [], skills: [], explicitSkillNames: [] },
      },
      transcript: {
        messages: { fromSequenceExclusive: -1, throughSequence: -1 },
        toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
        completeness: "complete",
      },
    });
    const messages: ModelMessage[] = Array.from({ length: 20 }, (_, i) => [
      { role: "user" as const, content: `Keep limit ${1739 + i} exact.` },
      { role: "assistant" as const, content: "Routine inspection.\n".repeat(400) },
    ]).flat();
    let observed = "";
    const model = new MockLanguageModelV4({
      doGenerate: async (params) => {
        const entries = evidence(params);
        return generation({
          ...createEmptyCompactionModelDraft(),
          constraints: entries
            .filter((e) => / user: Keep limit/.test(e.summary))
            .map((e) => ({
              priorItemId: null,
              text: "limit",
              sourceEvidenceIds: [e.evidenceId],
              sourceQuotes: [e.summary],
            })),
          evidenceReviews: entries.map((e) => ({
            evidenceId: e.evidenceId,
            disposition: / assistant:/.test(e.summary)
              ? ("irrelevant" as const)
              : ("reviewed" as const),
            reason: "Reviewed",
          })),
        });
      },
      doStream: async (params) => {
        observed = JSON.stringify(params.prompt);
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "finish", usage: usage(), finishReason: { unified: "stop", raw: "stop" } },
            ],
          }),
        };
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "roll-review-legacy-checkpoint-"));
    let store = new ThreadStore(dir);
    const id = store.createThread();
    store.appendMessages(id, messages);
    const saved = store.commitCompaction(id, {
      messages,
      expectedActiveMessages: messages,
      expectedLatestCheckpointId: undefined,
      draft: {
        ...(checkpoint.goal === undefined ? {} : { goal: checkpoint.goal }),
        constraints: checkpoint.constraints,
        resources: checkpoint.resources,
        runningWork: checkpoint.runningWork,
        toolState: checkpoint.toolState,
        context: checkpoint.context,
        summary: checkpoint.summary,
      },
      semanticState: state,
      semanticEvidenceWatermarks: {
        messagesThroughSequence: -1,
        toolExecutionsThroughSequence: -1,
      },
      evidenceWatermarks: {
        transcriptMessagesThroughSequence: messages.length - 1,
        toolExecutionsThroughSequence: -1,
      },
    });
    const session = new AgentSession({
      id,
      sources: [],
      maxSteps: 1,
      model,
      debugEvents: true,
      initialCheckpoint: saved,
      initialMessages: messages,
      contextWindow: 128000,
      compaction: settings,
      listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
      commitCompaction: (input) => store.commitCompaction(id, input),
      onAcceptInput: (inputId, message) => store.acceptTurnInput(id, inputId, message),
      onPersist: (entries, options) => store.appendMessages(id, entries, options),
    });
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        const events = [];
        for await (const e of session.compact()) events.push(e);
        assert.ok(
          events.some((e) => e.type === "context-compacted" && e.removed > 0),
          JSON.stringify(events),
        );
      }
      for await (const e of session.send("Continue the same project.")) {
        assert.notEqual(e.type, "error");
      }
      assert.ok(observed.includes("Keep limit 1739 exact."));
      assert.ok(observed.includes("Keep limit 1758 exact."));
      assert.ok(observed.includes("omittedCounts"), "historical omissions stay explicit");
      await session.close();
      store.close();
      store = new ThreadStore(dir);
      const archived = store.getCheckpoint(id, saved.id);
      assert.ok(archived?.version === 2);
      assert.equal(archived.semanticState.completedWork.length, count);
      assert.ok(store.getLatestCheckpoint(id)!.generation > saved.generation);
      assert.ok(
        JSON.stringify(store.listTranscriptMessages(id, { limit: 100 })).includes(
          "Keep limit 1739 exact.",
        ),
      );
    } finally {
      await session.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("small-window summary reserves room for evidence instead of reserving the whole window for output", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (params) => {
      calls += 1;
      assert.ok(params.maxOutputTokens !== undefined && params.maxOutputTokens <= 2048);
      return generation();
    },
  });
  assert.ok(
    (await compactionEvidenceTokenBudget({ model, contextWindow: 8192, maxOutputTokens: 8192 }))! >
      0,
  );
  await compactMessages({
    model,
    contextWindow: 8192,
    maxOutputTokens: 8192,
    messages: [
      { role: "user", content: "Old request" },
      { role: "assistant", content: "Old reply" },
      { role: "user", content: "Continue" },
    ],
    strategy: "summarize",
    keepRecentTurns: 1,
    keepRecentTokens: 1,
  });
  assert.equal(calls, 1);
});

for (const growth of ["small", "material", "unsafe"] as const) {
  test(`advisory miss backs off across tool steps, with material growth=${growth}`, async () => {
    let summaries = 0;
    let calls = 0;
    let tools = 0;
    const client = new Client({ name: "fixture", version: "1" });
    Object.defineProperty(client, "callTool", {
      value: async () => {
        tools += 1;
        return {
          content: [
            {
              type: "text",
              text:
                tools === 2 && growth !== "small"
                  ? "G".repeat(growth === "unsafe" ? 120000 : 30000)
                  : "done",
            },
          ],
        };
      },
    });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        summaries += 1;
        return { ...generation(), content: [{ type: "text", text: "{}" }] };
      },
      doStream: async (params) => {
        calls += 1;
        const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
        if (calls <= 4) {
          chunks.push({
            type: "tool-call",
            toolCallId: `call-${calls}`,
            toolName: "fixture__read",
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
          usage: usage(
            estimatePreparedRequest(params, { provider: "mock", model: "fixture" }, 0)
              .rawInputEstimate,
          ),
          finishReason: { unified: calls <= 4 ? "tool-calls" : "stop", raw: "fixture" },
        });
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const session = new AgentSession({
      id: `advisory-${growth}`,
      model,
      maxSteps: 6,
      contextWindow: 128000,
      policy: { check: () => ({ action: "allow" }) },
      compaction: settings,
      initialMessages: Array.from({ length: 12 }, () => [
        { role: "user" as const, content: "Continue task." },
        { role: "assistant" as const, content: "inspection ".repeat(2700) },
      ]).flat(),
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
    try {
      const events = [];
      for await (const e of session.send("Read four times then finish.")) events.push(e);
      if (growth === "unsafe") {
        assert.equal(calls, 2, "advisory backoff never bypasses the hard dispatch ceiling");
        assert.equal(tools, 2);
        assert.ok(
          events.some(
            (e) => e.type === "error" && /context_request_budget_unrecoverable/.test(e.message),
          ),
        );
        assert.ok(summaries <= 2);
        return;
      }
      assert.deepEqual(
        events.filter((e) => e.type === "error"),
        [],
      );
      assert.equal(calls, 5);
      assert.equal(tools, 4);
      const episodes = session.getMaintenanceEpisodes();
      assert.equal(episodes.length, growth === "material" ? 2 : 1);
      assert.equal(summaries, growth === "material" ? 2 : 1);
      assert.ok(
        session.getRequestBudgetState().preparedAttempts <= (growth === "material" ? 11 : 8),
      );
    } finally {
      await session.close();
    }
  });
}

test("retention permits bounded old completions but rejects missing new or active facts", () => {
  const base = replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
    verbatimRequest: "Keep all active constraints.",
    sourceSequence: 0,
  });
  const item = (i: number) => {
    const text = `Completed item ${i}: ${"x".repeat(128)}`;
    return {
      id: `semantic_completed_work_${i.toString(16).padStart(24, "0")}`,
      text,
      sourceQuotes: [text],
      provenance: base.goal!.provenance,
    };
  };
  const previous = compactionSemanticStateSchema.parse({
    ...base,
    completedWork: Array.from({ length: 128 }, (_, i) => item(i)),
  });
  const validated = validateCompactionModelDraft({
    draft: createEmptyCompactionModelDraft(),
    evidenceRegistry: [],
  });
  const candidate = compactionSemanticStateSchema.parse({
    ...createEmptyCompactionSemanticState(),
    completedWork: [item(128)],
  });
  const merged = mergeCompactionSemanticState(
    previous,
    { ...validated, state: candidate },
    { startsNewGoalScope: false },
  );
  assert.equal(merged.prunedItemCounts.completed_work, 1);
  assert.ok(merged.completedWork.some((i) => i.text === item(128).text));
  assert.equal(retainsCompactionFacts(previous, candidate, merged), true);
  assert.equal(
    previous.completedWork.length,
    128,
    "previous checkpoint remains intact for archived recovery",
  );
  assert.equal(
    retainsCompactionFacts(previous, candidate, previous),
    false,
    "new fact must reach next reminder",
  );
  const denseCandidate = compactionSemanticStateSchema.parse({
    ...candidate,
    completedWork: Array.from({ length: 128 }, (_, i) => item(i + 128)),
  });
  const denseMerged = mergeCompactionSemanticState(
    previous,
    { ...validated, state: denseCandidate },
    { startsNewGoalScope: false },
  );
  assert.equal(
    retainsCompactionFacts(previous, denseCandidate, denseMerged),
    false,
    "new fact overload cannot retire source",
  );
  const activePruned = compactionSemanticStateSchema.parse({
    ...merged,
    prunedItemCounts: { ...merged.prunedItemCounts, constraint: 1 },
  });
  assert.equal(
    retainsCompactionFacts(previous, candidate, activePruned),
    false,
    "active facts cannot use completion eviction exception",
  );
});
