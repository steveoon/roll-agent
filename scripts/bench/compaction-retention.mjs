#!/usr/bin/env node
// Offline structural evaluation through the production SDK preparation and SQLite paths.
// Models are deterministic mocks: this measures request size and fact visibility, not
// natural-language reasoning, real provider token counts, latency, or coding-task success.
// Run: node --experimental-strip-types --experimental-sqlite scripts/bench/compaction-retention.mjs --output /tmp/compaction-retention.json
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "../..");
const { values: options } = parseArgs({
  options: { output: { type: "string" }, "baseline-semantic": { type: "string" } },
});
const require = createRequire(`${root}/packages/runtime/package.json`);
const { MockLanguageModelV4 } = await import(pathToFileURL(require.resolve("ai/test")));
const { simulateReadableStream } = await import(pathToFileURL(require.resolve("ai")));
const { AgentSession } = await import(`${root}/packages/runtime/src/engine/agent-session.ts`);
const { ThreadStore } = await import(`${root}/packages/runtime/src/store/thread-store.ts`);
const { estimatePreparedRequest } = await import(
  `${root}/packages/runtime/src/engine/request-budget.ts`
);
const { createToolExecutionRecord } = await import(
  `${root}/packages/runtime/src/tool-bridge/tool-execution-record.ts`
);
const { successfulToolResult } = await import(
  `${root}/packages/runtime/src/tool-bridge/normalize-result.ts`
);
const semantic = await import(`${root}/packages/runtime/src/engine/compaction-semantic-state.ts`);
const usage = (input) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
});
const modelText = (p) =>
  p.prompt
    .flatMap((m) =>
      m.role === "system"
        ? [m.content]
        : m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])),
    )
    .join("\n");
const pct = (n) => Math.round(n * 10000) / 100;
const facts = [
  "FACT_EARLY_keep_sqlite_transaction",
  "FACT_MIDDLE_timeout_1739ms",
  "FACT_TAIL_no_replay_on_unknown",
];
const results = [];
for (const [name, turns, chars, toolCount, window] of [
  ["30_turns_messages", 30, 46000, 0, 500000],
  ["40_turns_messages", 40, 35000, 0, 500000],
  ["40_turns_mixed_ledger", 40, 35000, 40, 500000],
  ["100_turns_messages", 100, 14000, 0, 500000],
  ["40_turns_at_lower_window", 40, 35000, 0, 350000],
]) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "user",
      content:
        i === 0
          ? "Implement a parser. Do not modify public API. Preserve transaction semantics."
          : `Continue coding phase ${i}.`,
    });
    let content =
      `Inspection phase ${i}.\n` +
      "Routine source-code observation. ".repeat(Math.ceil(chars / 32));
    if (i === 1) content = facts[0] + "\n" + content;
    if (i === 5) content = content.slice(0, 5000) + "\n" + facts[1] + "\n" + content.slice(5000);
    if (i === 13) content += "\n" + facts[2];
    messages.push({ role: "assistant", content });
  }
  const ledger = Array.from({ length: toolCount }, (_, sequence) => ({
    ...createToolExecutionRecord({
      toolCallId: `call-${sequence}`,
      agentName: "fixture",
      toolName: "read",
      input: { path: `fixture-${sequence}.ts` },
      result: successfulToolResult(`inspected source ${sequence}`),
    }),
    sequence,
  }));
  let drafts = 0;
  let request;
  let checkpoint;
  let draftBytes = 0;
  const batches = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (params) => {
      drafts++;
      const text = modelText(params);
      const json = /<harness-evidence>\n([\s\S]+)\n<\/harness-evidence>/.exec(text)?.[1];
      if (!json) throw new Error("missing evidence");
      const context = JSON.parse(json);
      const draft = structuredClone(semantic.createEmptyCompactionModelDraft());
      const cited = new Set();
      for (const entry of context.evidence) {
        if (
          facts.some((f) => entry.summary.includes(f)) ||
          entry.summary.includes("Do not modify public API")
        ) {
          for (const quote of entry.summary
            .split("\n")
            .filter(
              (line) =>
                facts.some((fact) => line.includes(fact)) ||
                line.includes("Do not modify public API"),
            )) {
            draft.decisions.push({
              priorItemId: null,
              text: quote,
              sourceEvidenceIds: [entry.evidenceId],
              sourceQuotes: [quote],
            });
          }
          cited.add(entry.evidenceId);
        }
      }
      draft.evidenceReviews = context.evidence.map((e) => ({
        evidenceId: e.evidenceId,
        disposition: cited.has(e.evidenceId) ? "reviewed" : "irrelevant",
        reason: "Controlled oracle: boilerplate fixture, not a real model quality claim.",
      }));
      const output = JSON.stringify(draft);
      draftBytes += Buffer.byteLength(output);
      batches.push({
        items: context.evidence.length,
        messages: context.evidence.filter((e) => e.kind === "message").length,
        tools: context.evidence.filter((e) => e.kind === "tool_execution").length,
        promptChars: text.length,
        factsVisibleInSummaryInput: facts.map((f) => text.includes(f)),
      });
      return {
        content: [{ type: "text", text: output }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(1000),
        warnings: [],
      };
    },
    doStream: async (params) => {
      request = params;
      const input = estimatePreparedRequest(
        params,
        { provider: "mock", model: "fixture" },
        0,
      ).rawInputEstimate;
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            {
              type: "text-delta",
              id: "t",
              delta: "Fixture continuation reached; not an evaluated task answer.",
            },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(input) },
          ],
        }),
      };
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "roll-quality-store-"));
  let store = new ThreadStore(dir);
  const id = store.createThread();
  store.appendMessages(id, messages);
  for (const entry of ledger) store.appendToolExecution(id, entry);
  const session = new AgentSession({
    id,
    model,
    sources: [],
    maxSteps: 1,
    initialMessages: messages,
    contextWindow: window,
    onAcceptInput: (inputId, input) => store.acceptTurnInput(id, inputId, input),
    onPersist: (items, options) => store.appendMessages(id, items, options),
    listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
    listToolExecutions: (options) => store.listToolExecutions(id, options),
    getToolExecution: (executionId) => store.getToolExecution(id, executionId),
    readCheckpointTranscript: (options) => store.readCheckpointTranscript(id, options),
    commitCompaction: (input) => store.commitCompaction(id, input),
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 4,
      keepRecentTokens: 32000,
      timeoutMs: 120000,
    },
  });
  const started = Date.now();
  const events = [];
  try {
    for await (const e of session.send("Continue the same parser task and finish verification.")) {
      events.push(e);
    }
    checkpoint = store.getLatestCheckpoint(id);
    const episodes = session.getMaintenanceEpisodes();
    const before = episodes[0]?.before?.rawInputEstimate;
    const after = session.getRequestBudgetState().last?.rawInputEstimate;
    const sent = request ? modelText(request) : "";
    const finalBudget = session.getRequestBudgetState().last;
    await session.close();
    store.close();
    store = new ThreadStore(dir);
    const archived = JSON.stringify(store.listTranscriptMessages(id, { limit: 500 }));
    results.push({
      name,
      window,
      turns,
      toolCount,
      before,
      after,
      releasedPct: before ? pct((before - after) / before) : null,
      afterWindowPct: pct(after / window),
      drafts,
      draftBytes,
      batches,
      elapsedMs: Date.now() - started,
      afterComponents: {
        system: finalBudget.systemTokens,
        messages: finalBudget.messageTokens,
        tools: finalBudget.toolTokens,
        options: finalBudget.optionTokens,
      },
      factsRecoverableAfterSQLiteReopen: facts.map((f) => archived.includes(f)),
      factsInFinalRequest: facts.map((f) => sent.includes(f)),
      factsInCheckpoint: facts.map((f) => JSON.stringify(checkpoint ?? {}).includes(f)),
      factsInOriginal: facts.map((f) => JSON.stringify(messages).includes(f)),
      errors: events.filter((e) => e.type === "error").map((e) => e.message),
      compactions: events
        .filter((e) => e.type === "context-compacted")
        .map((e) => ({ removed: e.removed, kept: e.kept })),
      episodes: episodes.map((e) => ({
        reason: e.reason,
        passes: e.passes,
        draftCalls: e.draftCalls,
        coverageProgress: e.coverageProgress,
        aggregateSavedTokens: e.aggregateSavedTokens,
      })),
    });
  } finally {
    await session.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
// Isolated semantic oracle: even a correct concise candidate is replaced by bounded quote text.
const tail = "CRITICAL_FACT_EXACT_BACKOFF_1739";
const full = "Routine preamble. ".repeat(45) + "\n" + tail;
const registry = semantic.buildCompactionSemanticEvidenceRegistry({
  fullSources: true,
  messages: [{ sequence: 0, role: "assistant", summary: full }],
  toolExecutions: [],
  resources: [],
  runningSessions: [],
});
const entry = registry[0];
const context = semantic.buildCompactionSemanticModelContext(registry, undefined, 48000);
const shown = JSON.parse(context.prompt).evidence[0];
const candidate = {
  ...semantic.createEmptyCompactionModelDraft(),
  decisions: [
    {
      priorItemId: null,
      text: tail,
      sourceEvidenceIds: [entry.evidenceId],
      sourceQuotes: [tail],
    },
  ],
  evidenceReviews: [
    { evidenceId: entry.evidenceId, disposition: "reviewed", reason: "All facts extracted" },
  ],
};
const validated = semantic.validateCompactionModelDraft({
  draft: candidate,
  evidenceRegistry: registry,
  presentedEvidenceIds: context.includedEvidenceIds,
});
const semanticProbe = {
  originalContainsFact: full.includes(tail),
  evidenceContainsFact: shown.summary.includes(tail),
  modelCandidateContainsFact: candidate.decisions[0].text.includes(tail),
  acceptedStateContainsFact: JSON.stringify(validated.state).includes(tail),
  covered: validated.coveredEvidenceIds.includes(entry.evidenceId),
  rejections: validated.rejections,
};
let beforeTask3SemanticProbe;
if (options["baseline-semantic"]) {
  const baselineSemantic = await import(pathToFileURL(resolve(options["baseline-semantic"])));
  const baselineRegistry = baselineSemantic.buildCompactionSemanticEvidenceRegistry({
    messages: [{ sequence: 0, role: "assistant", summary: full }],
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const baselineContext = baselineSemantic.buildCompactionSemanticModelContext(
    baselineRegistry,
    undefined,
    48000,
  );
  const baselineShown = JSON.parse(baselineContext.prompt).evidence[0];
  const baselineValidated = baselineSemantic.validateCompactionModelDraft({
    draft: {
      ...baselineSemantic.createEmptyCompactionModelDraft(),
      decisions: [
        {
          priorItemId: null,
          text: tail,
          sourceEvidenceIds: [baselineShown.evidenceId],
          sourceQuotes: [baselineShown.summary],
        },
      ],
    },
    evidenceRegistry: baselineRegistry,
    presentedEvidenceIds: baselineContext.includedEvidenceIds,
  });
  beforeTask3SemanticProbe = {
    acceptedStateContainsFact: JSON.stringify(baselineValidated.state).includes(tail),
    covered: baselineValidated.coveredEvidenceIds.includes(baselineShown.evidenceId),
    rejections: baselineValidated.rejections,
  };
}
for (const result of results) {
  assert.deepEqual(result.errors, [], result.name);
  assert.ok(result.after < result.before, result.name);
  assert.ok(result.drafts > 0, result.name);
  assert.ok(result.factsRecoverableAfterSQLiteReopen.every(Boolean), result.name);
  assert.ok(
    result.factsInFinalRequest.every(Boolean),
    `${result.name}: important facts must reach the next request`,
  );
}
const output = {
  kind: "synthetic production-path structural probe; mock summary/inference, heuristic request budget; NOT real-agent completion-quality evaluation",
  results,
  semanticProbe,
  beforeTask3SemanticProbe,
};
if (options.output) writeFileSync(resolve(options.output), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
