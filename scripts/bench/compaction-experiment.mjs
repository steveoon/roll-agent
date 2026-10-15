// Production-path helpers shared by the opt-in experiment and deterministic tests.
import { createHash } from "node:crypto";
import { AgentSession } from "../../packages/runtime/src/engine/agent-session.ts";
import { ThreadStore } from "../../packages/runtime/src/store/thread-store.ts";
import { projectCompactionCheckpointReminder } from "../../packages/runtime/src/engine/compaction-checkpoint.ts";
import {
  estimateMessagesTokens,
  estimateTextTokens,
} from "../../packages/runtime/src/engine/compactor.ts";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function snapshotSpace(store, id) {
  const messages = store.getMessages(id);
  const checkpoint = store.getLatestCheckpoint(id);
  const reminder = checkpoint
    ? projectCompactionCheckpointReminder(
        checkpoint,
        undefined,
        "roll__transcript",
        "roll__context",
      ).text
    : "";
  return {
    activeMessages: messages.length,
    activeHistoryChars: JSON.stringify(messages).length,
    completeReminderChars: reminder.length,
    historyAndReminderEstimate: estimateMessagesTokens(messages) + estimateTextTokens(reminder),
  };
}

/** A real SQLite fork and AgentSession.compact, including production evidence
 * assembly, schema/provenance validation, merge, ledger and transaction commit. */
export async function runProductionCompaction({
  snapshot,
  directory,
  model,
  timeoutMs,
  criticalFacts = [],
  structuredOutputProviderOptions,
  structuredOutputReasoning,
}) {
  const store = new ThreadStore(directory);
  const id = store.forkSnapshot(snapshot);
  const initial = store.getLatestCheckpoint(id);
  const before = snapshotSpace(store, id);
  const priorRows = store.getSemanticLedgerRows(id);
  const result = {
    before,
    errors: [],
    compactions: [],
    semanticRejections: 0,
    committedValidSummaries: 0,
  };
  const session = new AgentSession({
    id,
    model,
    sources: [],
    maxSteps: 1,
    contextWindow: 128000,
    debugEvents: true,
    turnTimeoutMs: 300000,
    initialMessages: store.getMessages(id),
    ...(initial ? { initialCheckpoint: initial } : {}),
    ...(structuredOutputProviderOptions ? { structuredOutputProviderOptions } : {}),
    ...(structuredOutputReasoning ? { structuredOutputReasoning } : {}),
    systemPrompt:
      "Controlled compaction experiment. Preserve grounded coding requirements and execution outcomes.",
    capabilityContext: {
      cwd: "/compaction-experiment",
      profile: "compaction-experiment",
      agentCount: 0,
    },
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 2048,
      maxOutputTokens: 8192,
      timeoutMs,
    },
    contextStore: {
      read: (input) => store.readContext(id, input),
      recovery: () => store.getContextRecovery(id),
      ready: (cp, memo) => store.completeContextRecovery(id, cp, memo),
      rows: () => store.getSemanticLedgerRows(id),
    },
    onReplace: (messages) => store.replaceMessages(id, messages),
    listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
    listToolExecutions: (options) => store.listToolExecutions(id, options),
    getToolExecution: (executionId) => store.getToolExecution(id, executionId),
    commitCompaction: (input) => {
      const cp = store.commitCompaction(id, input);
      if (cp.summary.status === "valid") result.committedValidSummaries++;
      return cp;
    },
  });
  try {
    for await (const event of session.compact()) {
      if (event.type === "error") {
        result.errors.push({ stage: event.stage, message: event.message.slice(0, 300) });
      }
      if (event.type === "context-compacted") result.compactions.push(event);
      if (event.type === "debug" && event.message === "checkpoint validation finished") {
        result.semanticRejections += Number(event.data?.semanticRejections ?? 0);
      }
    }
    result.after = snapshotSpace(store, id);
    result.releasedFraction =
      1 - result.after.historyAndReminderEstimate / result.before.historyAndReminderEstimate;
    const rows = store.getSemanticLedgerRows(id);
    const persisted = JSON.stringify(rows.map((r) => JSON.parse(r.item_json)));
    const active = JSON.stringify(store.getMessages(id));
    result.criticalFacts = criticalFacts.map((fact) => {
      const encoded = JSON.stringify(fact).slice(1, -1);
      const location = persisted.includes(encoded)
        ? "ledger"
        : active.includes(encoded)
          ? "active"
          : "missing";
      return { fact, retained: location !== "missing", location };
    });
    // Even resolved/evicted prior entries must still be present in ledger history.
    const history = store.readSnapshot(id).semanticLedger ?? [];
    result.priorFactsRetained = priorRows.every((old) =>
      history.some(
        (row) =>
          row.item_id === old.item_id &&
          row.generation === old.generation &&
          row.item_json === old.item_json,
      ),
    );
    result.productionQualityPassed =
      result.errors.length === 0 &&
      result.semanticRejections === 0 &&
      result.committedValidSummaries > 0 &&
      result.priorFactsRetained &&
      result.criticalFacts.every((f) => f.retained) &&
      result.releasedFraction > 0;
    return result;
  } finally {
    await session.close();
    store.close();
  }
}

export function decideExperiment(runs, fixtures, pairs = 3) {
  const usable = (run) => run.status === "completed" && run.qualityPassed;
  const comparisons = [];
  for (const fixture of fixtures) {
    for (let pair = 0; pair < pairs; pair++) {
      const selected = (effort) =>
        runs.findLast(
          (r) => r.fixture === fixture.name && r.pair === pair && r.effort === effort && usable(r),
        );
      const low = selected("low");
      const medium = selected("medium");
      if (low && medium && low.requestDigest === medium.requestDigest) {
        comparisons.push({
          fixture: fixture.name,
          pair,
          reduction: 1 - low.elapsedMs / medium.elapsedMs,
        });
      }
    }
  }
  const ratios = comparisons.map((p) => p.reduction).sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  const median = ratios.length
    ? ratios.length % 2
      ? ratios[middle]
      : (ratios[middle - 1] + ratios[middle]) / 2
    : null;
  const complete = comparisons.length === fixtures.length * pairs;
  const failures = (effort) => runs.filter((r) => r.effort === effort && !usable(r)).length;
  const lowQuality = runs
    .filter((r) => r.effort === "low" && r.status === "completed")
    .every((r) => r.qualityPassed);
  return {
    complete,
    comparisons,
    pairedMedianReduction: median,
    changeDefaultToLow:
      complete && lowQuality && failures("low") <= failures("medium") && median >= 0.2,
    reason:
      "Requires every planned pair, identical production request, all low quality checks, no additional failures, >=20% paired median gain.",
  };
}
