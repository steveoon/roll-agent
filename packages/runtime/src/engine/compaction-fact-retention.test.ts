import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompactionSemanticEvidenceRegistry,
  buildCompactionSemanticModelContext,
  createEmptyCompactionModelDraft,
  validateCompactionModelDraft,
} from "./compaction-semantic-state.ts";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, type ModelMessage } from "ai";
import { AgentSession } from "./agent-session.ts";
import { ThreadStore } from "../store/thread-store.ts";

test("whole-source evidence retains middle and tail facts with exact quotes and explicit review", () => {
  const facts = ["Timeout must be 1739ms.", "Never repeat an operation with unknown outcome."];
  const source = [
    "Source header",
    "noise ".repeat(4000),
    facts[0],
    "noise ".repeat(4000),
    facts[1],
  ].join("\n");
  const registry = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: [{ sequence: 0, role: "assistant", summary: source }],
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const entry = registry[0]!;
  const context = buildCompactionSemanticModelContext(registry, undefined, 100_000);
  for (const fact of facts) assert.ok(context.prompt.includes(fact));
  const draft = {
    ...createEmptyCompactionModelDraft(),
    decisions: facts.map((fact) => ({
      priorItemId: null,
      text: fact,
      sourceEvidenceIds: [entry.evidenceId],
      sourceQuotes: [fact],
    })),
  };
  const partial = validateCompactionModelDraft({
    draft,
    evidenceRegistry: registry,
    presentedEvidenceIds: context.includedEvidenceIds,
  });
  assert.deepEqual(
    partial.state.decisions.map((item) => item.text),
    facts,
  );
  assert.deepEqual(partial.coveredEvidenceIds, [], "quoting a fact is not a whole-source review");
  const complete = validateCompactionModelDraft({
    draft: {
      ...draft,
      evidenceReviews: [
        {
          evidenceId: entry.evidenceId,
          disposition: "reviewed",
          reason: "All material facts retained",
        },
      ],
    },
    evidenceRegistry: registry,
    presentedEvidenceIds: context.includedEvidenceIds,
  });
  assert.deepEqual(complete.coveredEvidenceIds, [entry.evidenceId]);
});

test("long uncertain or omitted sources are retained, never covered by a clipped fallback", () => {
  const registry = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: [{ sequence: 0, role: "user", summary: "important ".repeat(2000) }],
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const id = registry[0]!.evidenceId;
  for (const disposition of ["uncertain", "irrelevant", "reviewed"] as const) {
    const result = validateCompactionModelDraft({
      evidenceRegistry: registry,
      presentedEvidenceIds: [id],
      draft: {
        ...createEmptyCompactionModelDraft(),
        evidenceReviews: [{ evidenceId: id, disposition, reason: "fixture" }],
      },
    });
    assert.deepEqual(result.coveredEvidenceIds, []);
  }
  assert.throws(
    () => buildCompactionSemanticModelContext(registry, undefined, 1024),
    /evidence_unpresentable/,
  );
  const omitted = validateCompactionModelDraft({
    evidenceRegistry: registry,
    presentedEvidenceIds: [],
    draft: {
      ...createEmptyCompactionModelDraft(),
      evidenceReviews: [{ evidenceId: id, disposition: "irrelevant", reason: "unseen" }],
    },
  });
  assert.deepEqual(omitted.coveredEvidenceIds, []);
});

test("full-source quotation cannot drop a negation or invent text", () => {
  const registry = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: [
      {
        sequence: 0,
        role: "user",
        summary: "noise ".repeat(200) + "\nDo not publish the package.\n",
      },
    ],
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const id = registry[0]!.evidenceId;
  for (const quote of ["publish the package.", "Publish now."]) {
    const result = validateCompactionModelDraft({
      evidenceRegistry: registry,
      presentedEvidenceIds: [id],
      draft: {
        ...createEmptyCompactionModelDraft(),
        constraints: [
          { priorItemId: null, text: quote, sourceEvidenceIds: [id], sourceQuotes: [quote] },
        ],
      },
    });
    assert.equal(result.state.constraints.length, 0);
    assert.deepEqual(result.coveredEvidenceIds, []);
    assert.ok(result.rejections.some((item) => item.reason === "unsupported_source_quote"));
  }
});

for (const mode of ["complete", "partial", "invalid"] as const) {
  test(`production Tool middle/tail facts survive compaction and SQLite reopening: ${mode}`, async () => {
    const facts = [
      "Timeout must remain exactly 1739ms.",
      "Never replay an outcome_unknown operation.",
    ];
    const result = `Header\n${"noise ".repeat(2000)}\n${facts[0]}\n${"noise ".repeat(2000)}\n${facts[1]}`;
    const dir = mkdtempSync(join(tmpdir(), "roll-retention-tool-"));
    let store = new ThreadStore(dir);
    const id = store.createThread();
    const messages: ModelMessage[] = [
      { role: "user", content: "Implement the retry planner and retain inspection findings." },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "old", toolName: "fixture__inspect", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "old",
            toolName: "fixture__inspect",
            output: { type: "text", value: result },
          },
        ],
      },
      { role: "assistant", content: "Inspection finished." },
      { role: "user", content: "Continue the same task." },
    ];
    store.appendMessages(id, messages);
    let request = "";
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (params) => {
        const text = params.prompt
          .flatMap((message) =>
            message.role === "user"
              ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
              : [],
          )
          .join("\n");
        const serialized = /<harness-evidence>\n([\s\S]+)\n<\/harness-evidence>/.exec(text)?.[1];
        assert.ok(serialized);
        const evidence = z
          .object({ evidence: z.array(z.object({ evidenceId: z.string(), summary: z.string() })) })
          .parse(JSON.parse(serialized)).evidence;
        const source = evidence.find((entry) => entry.summary.includes(facts[1]!));
        assert.ok(source, "the full Tool result must actually reach the summarizer");
        const draft = {
          ...createEmptyCompactionModelDraft(),
          decisions: facts.map((fact) => ({
            priorItemId: null,
            text: fact,
            sourceEvidenceIds: [source.evidenceId],
            sourceQuotes: [fact],
          })),
          evidenceReviews:
            mode === "complete"
              ? [
                  {
                    evidenceId: source.evidenceId,
                    disposition: "reviewed",
                    reason: "All material facts retained",
                  },
                ]
              : [],
        };
        return {
          content: [{ type: "text", text: mode === "invalid" ? "{}" : JSON.stringify(draft) }],
          usage,
          warnings: [],
          finishReason: { unified: "stop", raw: "stop" },
        };
      },
      doStream: async (params) => {
        request = JSON.stringify(params.prompt);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const session = new AgentSession({
      id,
      model,
      sources: [],
      maxSteps: 1,
      contextWindow: 128000,
      initialMessages: messages,
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 1,
      },
      listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
      commitCompaction: (input) => store.commitCompaction(id, input),
    });
    try {
      const events = [];
      for await (const event of session.compact("manual")) events.push(event);
      assert.deepEqual(
        events.filter((event) => event.type === "error"),
        [],
      );
      assert.equal(
        events.some((event) => event.type === "context-compacted" && event.removed > 0),
        mode === "complete",
      );
      for await (const event of session.send("Continue.")) assert.notEqual(event.type, "error");
      for (const fact of facts) assert.ok(request.includes(fact));
      if (mode !== "complete") {
        assert.ok(JSON.stringify(session.getMessages()).includes(result.split("\n")[1]!));
      }
      await session.close();
      store.close();
      store = new ThreadStore(dir);
      for (const fact of facts) {
        assert.ok(JSON.stringify(store.listTranscriptMessages(id)).includes(fact));
      }
    } finally {
      await session.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
