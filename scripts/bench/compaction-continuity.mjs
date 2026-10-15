#!/usr/bin/env node
// Opt-in real-provider acceptance of repeated compaction. Histories are controlled fixtures.
// Product code/configuration is never changed; generated code lives in a temporary directory.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  diagnosticError,
  diagnosticText,
  summaryEvidenceDiagnostics,
} from "./compaction-diagnostics.mjs";
const { values } = parseArgs({
  options: {
    run: { type: "boolean" },
    output: { type: "string" },
    resume: { type: "string" },
    "source-root": { type: "string" },
    scenario: { type: "string", default: "continuity" },
  },
});
if (!values.run) {
  console.log("Use --run --output <path> [--scenario continuity|advisory|tool-history|recovery]");
  process.exit(0);
}
assert.ok(["continuity", "advisory", "tool-history", "recovery"].includes(values.scenario));
const root = resolve(values["source-root"] ?? resolve(import.meta.dirname, "../.."));
const { loadConfig } = await import(`${root}/packages/core/src/config/loader.ts`);
const { resolveInteractiveChatLlm } = await import(
  `${root}/packages/core/src/runtime-host/chatgpt-resolution.ts`
);
const { AgentSession } = await import(`${root}/packages/runtime/src/engine/agent-session.ts`);
const { ThreadStore } = await import(`${root}/packages/runtime/src/store/thread-store.ts`);
const {
  createEmptyCompactionSemanticState,
  replaceCompactionSemanticGoal,
  compactionSemanticStateSchema,
  listSemanticArchiveItems,
} = await import(`${root}/packages/runtime/src/engine/compaction-semantic-state.ts`);
const { createEmptyCompactionToolState, projectCompactionCheckpointReminder } = await import(
  `${root}/packages/runtime/src/engine/compaction-checkpoint.ts`
);
const require = createRequire(`${root}/packages/runtime/package.json`);
const { wrapLanguageModel } = await import(pathToFileURL(require.resolve("ai")));
const work = values.resume
  ? resolve(values.resume)
  : mkdtempSync(join(tmpdir(), "roll-continuity-live-"));
const report = {
  startedAt: new Date().toISOString(),
  scenario: values.scenario,
  sourceRoot: root,
  implementationHashes: Object.fromEntries(
    [
      "packages/runtime/src/engine/agent-session.ts",
      "packages/runtime/src/engine/compaction-semantic-state.ts",
      "packages/runtime/src/store/thread-store.ts",
      "packages/runtime/src/tool-bridge/context-tool.ts",
    ].map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
    ]),
  ),
  artifacts: work,
  status: "running",
  kind: "real provider and real code edits; seeded controlled long history and legacy checkpoint; independent host assertions",
  rounds: [],
};
const save = () => {
  if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
};
const { config } = loadConfig();
let llm;
try {
  llm = await resolveInteractiveChatLlm(config);
} catch (error) {
  report.status = "blocked_login";
  report.error = diagnosticError(error);
  save();
  process.exit(2);
}
report.provider = llm.provider;
report.model = llm.modelName;
report.effort = config.runtime.thinkingLevel;
report.summaryEffort = config.runtime.compaction.thinkingLevel ?? config.runtime.thinkingLevel;
report.testSettings = {
  window: 128000,
  threshold: 0.75,
  keepRecentTurns: values.scenario === "advisory" ? 100 : 2,
  keepRecentTokens: 2048,
  summaryTimeoutMs: config.runtime.compaction.timeoutMs,
  maxOutputTokens: 8192,
};
const facts = [
  "Implement and export only planRetry({attempt,outcome,retryAfterMs,elapsedMs,budgetMs}) from retry.mjs. Return exactly {retry:boolean,delayMs:number}; do not mutate the input.",
  "attempt must be a nonnegative safe integer. elapsedMs and budgetMs must be finite nonnegative numbers. retryAfterMs, if supplied, must be a finite nonnegative number. Invalid numeric input throws RangeError, even for terminal outcomes.",
  "Allowed outcomes are tool_failed, not_executed, success, policy_denied, outcome_unknown. Every other outcome throws TypeError. Only tool_failed and not_executed can retry; all others return {retry:false,delayMs:0}. Never retry outcome_unknown.",
  "For retryable outcomes use min(100 * 2 ** attempt, 1739) milliseconds, then take max with retryAfterMs (default 0). Retry-After must not be clipped to 1739. Extremely large safe integer attempts must saturate safely.",
  "A retry is admitted only when elapsedMs + delayMs <= budgetMs, including exact equality. Otherwise return {retry:false,delayMs:0}. Do not wait, perform I/O, send requests, or add dependencies.",
];
function grade(fn) {
  const cases = [];
  const check = (name, run) => {
    try {
      run();
      cases.push({ name, passed: true });
    } catch (error) {
      cases.push({ name, passed: false, error: error?.name });
    }
  };
  const input = (extra = {}) => ({
    attempt: 0,
    outcome: "tool_failed",
    elapsedMs: 0,
    budgetMs: 10000,
    ...extra,
  });
  check("base backoff", () => assert.deepEqual(fn(input()), { retry: true, delayMs: 100 }));
  check("exponential", () =>
    assert.deepEqual(fn(input({ attempt: 3 })), { retry: true, delayMs: 800 }),
  );
  check("exact cap 1739", () =>
    assert.deepEqual(fn(input({ attempt: 6 })), { retry: true, delayMs: 1739 }),
  );
  check("safe integer saturation", () =>
    assert.deepEqual(fn(input({ attempt: Number.MAX_SAFE_INTEGER })), {
      retry: true,
      delayMs: 1739,
    }),
  );
  check("retry-after above cap", () =>
    assert.deepEqual(fn(input({ attempt: 6, retryAfterMs: 2101 })), { retry: true, delayMs: 2101 }),
  );
  check("budget equality", () =>
    assert.deepEqual(fn(input({ elapsedMs: 29, budgetMs: 129 })), { retry: true, delayMs: 100 }),
  );
  check("budget rejection", () =>
    assert.deepEqual(fn(input({ elapsedMs: 30, budgetMs: 129 })), { retry: false, delayMs: 0 }),
  );
  for (const outcome of ["success", "policy_denied", "outcome_unknown"]) {
    check(`no replay ${outcome}`, () =>
      assert.deepEqual(fn(input({ outcome })), { retry: false, delayMs: 0 }),
    );
  }
  check("not-executed retry", () =>
    assert.deepEqual(fn(input({ outcome: "not_executed" })), { retry: true, delayMs: 100 }),
  );
  check("numeric validation", () => {
    for (const extra of [
      { attempt: -1 },
      { attempt: 0.5 },
      { attempt: Infinity },
      { budgetMs: NaN },
      { elapsedMs: -1 },
      { retryAfterMs: -1 },
      { retryAfterMs: Infinity },
      { outcome: "success", attempt: -1 },
    ]) {
      assert.throws(() => fn(input(extra)), RangeError);
    }
  });
  check("unknown outcome", () => assert.throws(() => fn(input({ outcome: "mystery" })), TypeError));
  check("input immutability", () => {
    const data = Object.freeze(input());
    assert.deepEqual(fn(data), { retry: true, delayMs: 100 });
  });
  return cases;
}
facts.push(
  "In phase two implement only export planBatch(entries,{elapsedMs,budgetMs}) in dispatcher.mjs, importing planRetry from retry.mjs. Each entry has id,attempt,outcome and optional retryAfterMs. Return an array of exactly {id,delayMs} for entries admitted by planRetry, preserving input order. Use the same elapsedMs and budgetMs for each entry; do not accumulate delays across entries.",
  "Batch duplicate IDs use first occurrence wins, even when that first entry is terminal or over budget. Later duplicate entries must be ignored. Do not mutate the entries, entry objects, or options. Never schedule success, policy_denied, or outcome_unknown; propagate planRetry validation errors from the first occurrence. No I/O, timers, external requests, or new dependencies.",
);
function longHistory(round, includeFacts) {
  const result = [];
  for (let i = 0; i < 20; i++) {
    const index = [0, 3, 6, 9, 12, 15, 17].indexOf(i);
    const fact =
      includeFacts && index >= 0 ? facts[index] : "Continue the same project; no new requirements.";
    if (values.scenario !== "tool-history" || (includeFacts && index >= 0)) {
      result.push({ role: "user", content: fact });
    }
    let archive = `Archived inspection ${round}.${i}; no new decision or requirement.\n`;
    for (let j = 0; j < 235; j++) {
      archive +=
        values.scenario === "advisory" && j % 2 === 0
          ? `Build trace ${createHash("sha256").update(`${round}:${i}:${j}`).digest("hex").slice(0, 48)} OK.\n`
          : "The archive includes routine inspection with no additional requirements. ";
    }
    result.push({ role: "assistant", content: archive });
  }
  return result;
}
const retryFixture = "export function planRetry(input) { return {retry:false,delayMs:0}; }\n";
if (!values.resume) writeFileSync(join(work, "retry.mjs"), retryFixture);
if (!values.resume) {
  writeFileSync(
    join(work, "dispatcher.mjs"),
    "export function planBatch(entries,options) { return []; }\n",
  );
}
let store = new ThreadStore(join(work, "state"));
const id = values.resume ? store.listThreads()[0].id : store.createThread();
report.threadId = id;
const history = longHistory(1, true);
const hiddenFact =
  'In phase three, add export planTaggedBatch(entries,options) to dispatcher.mjs. It must use planBatch and add exactly recoveryTag: "archived-7319-fuchsia" to each admitted item. Preserve all earlier behavior. The tag is an exact case-sensitive interoperability requirement; do not guess it.';
if (!values.resume && values.scenario === "recovery") {
  store.appendMessages(id, [{ role: "user", content: hiddenFact }]);
}
if (!values.resume) store.appendMessages(id, history);
const base = replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
  verbatimRequest: facts[0],
  sourceSequence: values.scenario === "recovery" ? 1 : 0,
});
const legacy = compactionSemanticStateSchema.parse({
  ...base,
  prunedItemCounts: {
    ...base.prunedItemCounts,
    constraint: values.scenario === "recovery" ? 1 : 0,
  },
  completedWork: Array.from({ length: 40 }, (_, i) => {
    const text =
      `Historical completed audit ${i}: ` +
      "Archived verification, no pending action or current implementation requirement. ".repeat(2);
    return {
      id: `semantic_completed_work_${i.toString(16).padStart(24, "0")}`,
      text,
      sourceQuotes: [text],
      provenance: base.goal.provenance,
    };
  }),
});
const initial = values.resume
  ? store.getLatestCheckpoint(id)
  : store.commitCompaction(id, {
      messages: history,
      expectedActiveMessages: store.getMessages(id),
      expectedLatestCheckpointId: undefined,
      draft: {
        goal: {
          verbatimRequest: facts[0],
          sourceSequence: values.scenario === "recovery" ? 1 : 0,
          status: "active",
        },
        constraints: [],
        resources: [],
        runningWork: [],
        toolState: createEmptyCompactionToolState(),
        context: { cwd: work, stableRuleIds: [], skills: [], explicitSkillNames: [] },
        summary: { status: "skipped" },
      },
      semanticState: legacy,
      ...(values.scenario === "recovery"
        ? {
            semanticArchiveItems: [
              ...listSemanticArchiveItems(legacy),
              {
                category: "constraint",
                item: {
                  id: "semantic_constraint_000000000000000000007319",
                  text: hiddenFact,
                  sourceQuotes: [hiddenFact],
                  provenance: [{ ...base.goal.provenance[0], messageSequence: 0 }],
                },
              },
            ],
            contextRecovery: { unextracted: false },
          }
        : {}),
      semanticEvidenceWatermarks: {
        messagesThroughSequence: values.scenario === "recovery" ? 0 : -1,
        toolExecutionsThroughSequence: -1,
      },
      evidenceWatermarks: {
        transcriptMessagesThroughSequence:
          history.length - 1 + (values.scenario === "recovery" ? 1 : 0),
        toolExecutionsThroughSequence: -1,
      },
    });
report.initialCheckpoint = {
  id: initial.id,
  generation: initial.generation,
  completedFacts: 40,
  historyMessages: history.length,
  historyChars: JSON.stringify(history).length,
};
save();
function batchGrade(fn) {
  const cases = [];
  const check = (name, run) => {
    try {
      run();
      cases.push({ name, passed: true });
    } catch (error) {
      cases.push({ name, passed: false, error: error?.name });
    }
  };
  const e = (id, extra = {}) => ({ id, attempt: 0, outcome: "tool_failed", ...extra });
  const options = { elapsedMs: 0, budgetMs: 5000 };
  check("empty batch", () => assert.deepEqual(fn([], options), []));
  check("ordered distinct items", () =>
    assert.deepEqual(fn([e("b"), e("a", { attempt: 2 })], options), [
      { id: "b", delayMs: 100 },
      { id: "a", delayMs: 400 },
    ]),
  );
  check("duplicate first wins", () =>
    assert.deepEqual(fn([e("x"), e("x", { attempt: 2 })], options), [{ id: "x", delayMs: 100 }]),
  );
  check("terminal first reserves id", () =>
    assert.deepEqual(fn([e("x", { outcome: "success" }), e("x")], options), []),
  );
  check("over-budget first reserves id", () =>
    assert.deepEqual(fn([e("x", { retryAfterMs: 6000 }), e("x")], options), []),
  );
  check("independent budgets", () =>
    assert.deepEqual(fn([e("x"), e("y")], { elapsedMs: 29, budgetMs: 129 }), [
      { id: "x", delayMs: 100 },
      { id: "y", delayMs: 100 },
    ]),
  );
  check("unknown outcome never replayed", () =>
    assert.deepEqual(
      fn([e("x", { outcome: "outcome_unknown" }), e("y", { outcome: "policy_denied" })], options),
      [],
    ),
  );
  check("batch cap and retry-after", () =>
    assert.deepEqual(fn([e("x", { attempt: 20 }), e("y", { retryAfterMs: 2101 })], options), [
      { id: "x", delayMs: 1739 },
      { id: "y", delayMs: 2101 },
    ]),
  );
  check("validation propagated", () =>
    assert.throws(() => fn([e("x", { attempt: -1 })], options), RangeError),
  );
  check("batch immutable", () => {
    const input = Object.freeze([Object.freeze(e("x"))]);
    assert.deepEqual(fn(input, Object.freeze(options)), [{ id: "x", delayMs: 100 }]);
  });
  return cases;
}
let reusedSession;
let activeRound;
async function executeRound(name, prompt, manual = false, reuse = false) {
  const round = {
    name,
    startedAt: new Date().toISOString(),
    summaries: [],
    requests: [],
    events: [],
    errors: [],
    toolCalls: [],
    debug: [],
  };
  const beforeActiveChars = JSON.stringify(store.getMessages(id)).length;
  report.rounds.push(round);
  activeRound = round;
  const model = wrapLanguageModel({
    model: llm.model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params, type }) => {
        if (type === "stream") {
          const text = JSON.stringify(params.prompt);
          activeRound.requests.push({
            at: new Date().toISOString(),
            chars: text.length,
            facts: facts.map((f) => text.includes(f)),
            omissionsVisible: text.includes("omittedCounts"),
          });
          save();
        }
        return params;
      },
      wrapStream: async ({ doStream, params }) => {
        const request = activeRound.requests.at(-1);
        const start = Date.now();
        try {
          const out = await doStream();
          return {
            ...out,
            stream: out.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  if (part.type === "finish") request.usage = part.usage;
                  if (part.type === "error") {
                    request.providerError = {
                      ...diagnosticError(part.error),
                      signalAborted: params.abortSignal?.aborted,
                    };
                  }
                  request.elapsedMs = Date.now() - start;
                  save();
                  controller.enqueue(part);
                },
              }),
            ),
          };
        } catch (error) {
          request.providerError = {
            ...diagnosticError(error),
            signalAborted: params.abortSignal?.aborted,
          };
          save();
          throw error;
        }
      },
      wrapGenerate: async ({ doGenerate, params }) => {
        const summary = {
          startedAt: new Date().toISOString(),
          inputChars: JSON.stringify(params.prompt).length,
        };
        activeRound.summaries.push(summary);
        const requestPath = join(
          work,
          `${activeRound.name}-summary-${activeRound.summaries.length}-prompt.json`,
        );
        writeFileSync(requestPath, JSON.stringify(params.prompt, null, 2));
        summary.requestPath = requestPath;
        summary.snapshotPath = join(
          work,
          `${activeRound.name}-summary-${activeRound.summaries.length}-snapshot.json`,
        );
        const snapshot = store.readSnapshot(id);
        writeFileSync(summary.snapshotPath, JSON.stringify(snapshot));
        try {
          summary.evidence = summaryEvidenceDiagnostics(params.prompt, snapshot);
        } catch (error) {
          summary.diagnosticError = diagnosticError(error);
        }

        save();
        const start = Date.now();
        try {
          const out = await doGenerate();
          summary.usage = out.usage;
          summary.finishReason = out.finishReason;
          summary.output = out.content.filter((p) => p.type === "text");
          return out;
        } catch (error) {
          summary.error = { ...diagnosticError(error), signalAborted: params.abortSignal?.aborted };
          throw error;
        } finally {
          summary.elapsedMs = Date.now() - start;
          save();
        }
      },
    },
  });
  const session =
    reusedSession ??
    new AgentSession({
      id,
      model,
      sources: [],
      maxSteps: 24,
      debugEvents: true,
      turnTimeoutMs: 300000,
      contextWindow: 128000,
      providerOptions: llm.providerOptions,
      structuredOutputProviderOptions: llm.structuredOutputProviderOptions,
      initialMessages: store.getMessages(id),
      initialCheckpoint: store.getLatestCheckpoint(id),
      fileTools: { workdir: work },
      capabilityContext: { profile: "compaction-live-acceptance", cwd: work, agentCount: 0 },
      systemPrompt: `Work only inside ${work}. This isolated project has two previously specified modules. Use tools to read, edit, and verify real files. Do not read the benchmark script, state database, or directories outside this project. Phase one is retry.mjs; phase two is dispatcher.mjs. Do only the requested phase.`,
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.75,
        keepRecentTurns: report.testSettings.keepRecentTurns,
        keepRecentTokens: 2048,
        timeoutMs: report.testSettings.summaryTimeoutMs,
        maxOutputTokens: 8192,
      },
      contextStore: {
        read: (input) => store.readContext(id, input),
        recovery: () => store.getContextRecovery(id),
        ready: (checkpointId, memo) => store.completeContextRecovery(id, checkpointId, memo),
        rows: () => store.getSemanticLedgerRows(id),
      },
      onReplace: (messages) => store.replaceMessages(id, messages),
      onAcceptInput: (inputId, input) => store.acceptTurnInput(id, inputId, input),
      onPersist: (messages, options) => store.appendMessages(id, messages, options),
      onToolExecution: (record) => store.appendToolExecution(id, record),
      listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
      listToolExecutions: (options) => store.listToolExecutions(id, options),
      getToolExecution: (executionId) => store.getToolExecution(id, executionId),
      readCheckpointTranscript: (options) => store.readCheckpointTranscript(id, options),
      commitCompaction: (input) => store.commitCompaction(id, input),
    });
  try {
    for await (const event of manual ? session.compact() : session.send(prompt)) {
      if (event.type === "confirmation-required") session.approve(event.approvalId);
      if (event.type === "debug" && ["compaction", "context-budget"].includes(event.stage)) {
        round.debug.push({ at: new Date().toISOString(), ...event });
      }
      if (event.type === "context-compacted") {
        round.events.push({ at: new Date().toISOString(), ...event });
      }
      if (event.type === "tool-call" || event.type === "tool-result") {
        round.toolCalls.push({ at: new Date().toISOString(), ...event });
      }
      if (event.type === "error") {
        round.errors.push({
          stage: event.stage,
          message: diagnosticText(event.message),
        });
      }
      save();
    }
    round.activeHistorySpace = {
      beforeChars: beforeActiveChars,
      afterChars: JSON.stringify(store.getMessages(id)).length,
      releasedFraction: 1 - JSON.stringify(store.getMessages(id)).length / beforeActiveChars,
    };
    round.episodes = session.getMaintenanceEpisodes();
    round.finalBudget = session.getRequestBudgetState().last;
    const cp = store.getLatestCheckpoint(id);
    const reminder = projectCompactionCheckpointReminder(
      cp,
      undefined,
      "roll__transcript",
      "roll__context",
    ).semanticProjection;
    round.checkpoint = {
      id: cp.id,
      generation: cp.generation,
      semanticEvidence: cp.semanticEvidence,
      transcript: cp.transcript,
      summaryStatus: cp.summary.status,
      facts: facts.map((f) => JSON.stringify(cp).includes(f)),
      reminderFacts: facts.map((f) => JSON.stringify(reminder).includes(f)),
      omittedCounts: reminder.omittedCounts,
    };
    if (!manual) {
      const retry = await import(pathToFileURL(join(work, "retry.mjs")) + `?round=${name}`);
      round.retryChecks = grade(retry.planRetry);
      round.retryExports = Object.keys(retry);
      round.retryCodeChanged = readFileSync(join(work, "retry.mjs"), "utf8") !== retryFixture;
      if (!name.startsWith("phase-one")) {
        const dispatcher = await import(
          pathToFileURL(join(work, "dispatcher.mjs")) + `?round=${name}`
        );
        round.batchChecks = batchGrade(dispatcher.planBatch);
        round.batchExports = Object.keys(dispatcher);
      }
    }
  } catch (error) {
    round.harnessError = diagnosticError(error);
    throw error;
  } finally {
    round.finishedAt = new Date().toISOString();
    if (reuse) reusedSession = session;
    else {
      await session.close();
      reusedSession = undefined;
    }
    save();
  }
  console.log(
    JSON.stringify({
      round: name,
      compactions: round.events.map((e) => ({ removed: e.removed, kept: e.kept })),
      episodes: round.episodes?.length,
      summaries: round.summaries.length,
      requests: round.requests.length,
      tools: round.toolCalls.length,
      checks: [...(round.retryChecks ?? []), ...(round.batchChecks ?? [])].filter((c) => c.passed)
        .length,
      errors: round.errors,
    }),
  );
}
try {
  if (values.resume) {
    report.resumedArtifact = work;
    for (let cycle = 1; cycle <= 3; cycle++) {
      store.close();
      store = new ThreadStore(join(work, "state"));
      const noise = longHistory(10 + cycle, false);
      store.appendMessages(id, noise);
      const before = JSON.stringify(store.getMessages(id)).length;
      await executeRound(`recovery-cycle-${cycle}-compact`, undefined, true, true);
      const after = JSON.stringify(store.getMessages(id)).length;
      report.rounds.at(-1).activeHistorySpace = {
        beforeChars: before,
        afterChars: after,
        releasedFraction: 1 - after / before,
      };
      const prompt =
        "Continue the previously specified project. Inspect both files and complete any unfinished phase-one and phase-two work against their archived requirements. Then implement and verify phase three from its archived specification, preserving the required earlier behavior. Recover the exact interoperability requirement through context readback; do not guess. Read back both files and verify boundary cases.";
      await executeRound(`recovery-cycle-${cycle}-code`, prompt);
      if (
        report.rounds.at(-1).errors.some((e) => /网络连接中断|server_is_overloaded/.test(e.message))
      ) {
        await executeRound(`recovery-cycle-${cycle}-network-retry`, prompt);
      }
      if (report.rounds.at(-1).errors.length) break;
    }
    const tagged = await import(pathToFileURL(join(work, "dispatcher.mjs")) + "?hidden-resume");
    try {
      assert.deepEqual(
        tagged.planTaggedBatch([{ id: "hidden", attempt: 0, outcome: "tool_failed" }], {
          elapsedMs: 0,
          budgetMs: 5000,
        }),
        [{ id: "hidden", delayMs: 100, recoveryTag: "archived-7319-fuchsia" }],
      );
      report.hiddenFactPassed = true;
    } catch (error) {
      report.hiddenFactPassed = false;
      report.hiddenFactError = error.name;
    }
  } else {
    await executeRound(
      "phase-one",
      "Continue the same project. Implement phase one only according to all previously agreed requirements. Read retry.mjs, edit it, read back the complete file, then verify its edge cases. Do not implement phase two yet.",
      false,
      values.scenario === "recovery",
    );
    const phaseOne = report.rounds.at(-1);
    if (values.scenario === "recovery") {
      await executeRound("same-session-compaction", undefined, true, false);
    }
    if (phaseOne.errors.some((e) => /网络连接中断|server_is_overloaded/.test(e.message))) {
      await executeRound(
        "phase-one-recovery",
        "Resume the interrupted phase-one implementation. Follow the original requirements already in this conversation, inspect the real file, implement it, then read back and verify the result. Phase two remains deferred.",
      );
    }
    if (values.scenario !== "advisory" && report.rounds.at(-1).errors.length === 0) {
      store.close();
      store = new ThreadStore(join(work, "state"));
      const extraHistory = longHistory(2, false);
      store.appendMessages(id, extraHistory);
      report.appendedHistory = {
        messages: extraHistory.length,
        chars: JSON.stringify(extraHistory).length,
      };
      await executeRound(
        "phase-two",
        "Continue the same project. Now implement phase two according to the previously agreed requirements, retaining phase one's behavior. Inspect both files, edit dispatcher.mjs, read back both files, then verify the boundary cases.",
      );
      await executeRound("manual-followup", undefined, true, values.scenario === "recovery");
      if (values.scenario === "recovery") {
        await executeRound(
          "phase-three-hidden-fact",
          "Implement phase three using its archived specification. Recover the exact interoperability requirement from omitted context; do not guess. Preserve phase one and two. Read back the resulting code and verify it.",
        );
        const tagged = await import(pathToFileURL(join(work, "dispatcher.mjs")) + "?hidden");
        try {
          assert.deepEqual(
            tagged.planTaggedBatch([{ id: "hidden", attempt: 0, outcome: "tool_failed" }], {
              elapsedMs: 0,
              budgetMs: 5000,
            }),
            [{ id: "hidden", delayMs: 100, recoveryTag: "archived-7319-fuchsia" }],
          );
          report.hiddenFactPassed = true;
        } catch (error) {
          report.hiddenFactPassed = false;
          report.hiddenFactError = error.name;
        }
      }
      if (values.scenario === "recovery") {
        await executeRound("third-continuous-compaction", undefined, true, true);
      }
      await executeRound(
        "post-compaction-verification",
        "Continue the same project. Read both completed files and check them against the original requirements. Correct any discrepancy and report your verification. Do not restate or guess missing requirements; use available context or transcript readback if needed.",
      );
    }
  }
  store.close();
  store = new ThreadStore(join(work, "state"));
  report.reopened = {
    archivedCompletedFacts: store.getCheckpoint(id, initial.id)?.semanticState.completedWork.length,
    latestGeneration: store.getLatestCheckpoint(id)?.generation,
    originalFacts: facts.map((f) =>
      JSON.stringify(store.listTranscriptMessages(id, { limit: 500 })).includes(f),
    ),
  };
  report.sourceHashes = Object.fromEntries(
    ["retry.mjs", "dispatcher.mjs"].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(work, file)))
        .digest("hex"),
    ]),
  );
  report.acceptance = {
    progressingCompactions: report.rounds.flatMap((r) => r.events).filter((e) => e.removed > 0)
      .length,
    actualHiddenFactRead: report.rounds
      .flatMap((r) => r.toolCalls)
      .some(
        (e) =>
          e.type === "tool-result" &&
          e.toolName === "context" &&
          e.output?.receipt &&
          JSON.stringify(e.output).includes("archived-7319-fuchsia"),
      ),
    finalCodeCorrect:
      report.rounds
        .filter((r) => r.retryChecks)
        .at(-1)
        ?.retryChecks.every((c) => c.passed) &&
      report.rounds
        .filter((r) => r.batchChecks)
        .at(-1)
        ?.batchChecks.every((c) => c.passed),
  };
  report.status =
    (values.scenario !== "recovery" ||
      (report.hiddenFactPassed === true &&
        report.acceptance.actualHiddenFactRead &&
        report.acceptance.progressingCompactions >= 3)) &&
    report.rounds.every(
      (r) =>
        r.errors.length === 0 &&
        !r.harnessError &&
        [...(r.retryChecks ?? []), ...(r.batchChecks ?? [])].every((c) => c.passed),
    )
      ? "behavior_passed"
      : "incomplete_or_failed";
} catch (error) {
  report.status = "incomplete_or_failed";
  report.error = diagnosticError(error);
} finally {
  await reusedSession?.close();
  store.close();
  report.finishedAt = new Date().toISOString();
  save();
}
console.log(JSON.stringify({ status: report.status, artifacts: work }));
process.exitCode = report.status === "behavior_passed" ? 0 : 1;
