#!/usr/bin/env node
// Opt-in real-provider acceptance. All generated files and SQLite state are isolated in tmp.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { diagnosticError } from "./compaction-diagnostics.mjs";
const { values } = parseArgs({
  options: {
    run: { type: "boolean" },
    preflight: { type: "boolean" },
    output: { type: "string" },
    config: { type: "string" },
  },
});
if (!values.run && !values.preflight) {
  console.log(
    "Use --preflight or --run [--config path] [--output path]. Runs three plain-summary / SQLite-reopen / coding cycles.",
  );
  process.exit(0);
}
const root = resolve(import.meta.dirname, "../..");
const { loadConfig } = await import(`${root}/packages/core/src/config/loader.ts`);
const { resolveInteractiveChatLlm } = await import(
  `${root}/packages/core/src/runtime-host/chatgpt-resolution.ts`
);
const { AgentSession } = await import(`${root}/packages/runtime/src/engine/agent-session.ts`);
const { ThreadStore } = await import(`${root}/packages/runtime/src/store/thread-store.ts`);
const require = createRequire(`${root}/packages/runtime/package.json`);
const { wrapLanguageModel } = await import(pathToFileURL(require.resolve("ai")));
const report = {
  startedAt: new Date().toISOString(),
  status: "running",
  summaryTimeoutMs: 120000,
  rounds: [],
};
const save = () => {
  if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
};
let llm;
try {
  const { config } = loadConfig(values.config ? { configPath: resolve(values.config) } : {});
  llm = await resolveInteractiveChatLlm(config);
  report.provider = llm.provider;
  report.model = llm.modelName;
  report.effort = config.runtime.thinkingLevel;
} catch (error) {
  report.status = "blocked_provider";
  report.error = diagnosticError(error);
  save();
  console.log(JSON.stringify(report));
  process.exit(2);
}
if (values.preflight) {
  report.status = "provider_ready";
  save();
  console.log(JSON.stringify(report));
  process.exit(0);
}
const facts = [
  "Implement and export only planRetry({attempt,outcome,retryAfterMs,elapsedMs,budgetMs}) from retry.mjs. Return exactly {retry:boolean,delayMs:number}; do not mutate the input.",
  "attempt must be a nonnegative safe integer. elapsedMs and budgetMs must be finite nonnegative numbers. retryAfterMs, if supplied, must be a finite nonnegative number. Invalid numeric input throws RangeError, even for terminal outcomes.",
  "Allowed outcomes are tool_failed, not_executed, success, policy_denied, outcome_unknown. Every other outcome throws TypeError. Only tool_failed and not_executed can retry; all others return {retry:false,delayMs:0}. Never retry outcome_unknown.",
  "For retryable outcomes use min(100 * 2 ** attempt, 1739) milliseconds, then take max with retryAfterMs (default 0). Retry-After must not be clipped to 1739. Extremely large safe integer attempts must saturate safely.",
  "A retry is admitted only when elapsedMs + delayMs <= budgetMs, including exact equality. Otherwise return {retry:false,delayMs:0}. Do not wait, perform I/O, send requests, or add dependencies.",
];
facts.push(
  "In phase two implement only export planBatch(entries,{elapsedMs,budgetMs}) in dispatcher.mjs, importing planRetry from retry.mjs. Each entry has id,attempt,outcome and optional retryAfterMs. Return an array of exactly {id,delayMs} for entries admitted by planRetry, preserving input order. Use the same elapsedMs and budgetMs for each entry; do not accumulate delays across entries.",
  "Batch duplicate IDs use first occurrence wins, even when that first entry is terminal or over budget. Later duplicate entries must be ignored. Do not mutate the entries, entry objects, or options. Never schedule success, policy_denied, or outcome_unknown; propagate planRetry validation errors from the first occurrence. No I/O, timers, external requests, or new dependencies.",
);
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
const work = mkdtempSync(join(tmpdir(), "roll-summary-continuity-"));
report.artifacts = work;
writeFileSync(
  join(work, "retry.mjs"),
  "export function planRetry(input) { return {retry:false,delayMs:0}; }\n",
);
writeFileSync(
  join(work, "dispatcher.mjs"),
  "export function planBatch(entries,options) { return []; }\n",
);
let store = new ThreadStore(join(work, "state"));
const id = store.createThread();
const marker = "archived-7319-fuchsia";
store.appendMessages(id, [
  {
    role: "user",
    content:
      "This historical catalog is available for later lookup; it adds no current task requirements.",
  },
  { role: "assistant", content: "catalog entry\n".repeat(3000) + `roll-marker=${marker}\n` },
  ...facts.flatMap((fact) => [
    { role: "user", content: fact },
    { role: "assistant", content: "Acknowledged." },
  ]),
]);
function addHistory(cycle) {
  store.appendMessages(
    id,
    Array.from({ length: 12 }, (_, i) => [
      {
        role: "user",
        content: `Continue the same project, inspection ${cycle}.${i}; no new requirement.`,
      },
      {
        role: "assistant",
        content: "Routine inspection found no new decision or requirement. ".repeat(170),
      },
    ]).flat(),
  );
}
const prompts = [
  "Implement phase one only in retry.mjs according to the previous specification. Read the file, edit it, read back and verify boundary cases; leave phase two for later.",
  "Implement phase two in dispatcher.mjs according to the previous specification, preserving phase one. Inspect both files, edit, read back and verify boundaries.",
  "Add export planTaggedBatch(entries,options) to dispatcher.mjs. Use planBatch and add exactly recoveryTag to each admitted item. Recover its exact value from roll-marker in the historical catalog at transcript message sequence 1 through roll__transcript; do not guess it. Preserve phase one and two; read back the code.",
];
let current;
const model = wrapLanguageModel({
  model: llm.model,
  middleware: {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const sample = {
        startedAt: new Date().toISOString(),
        inputChars: JSON.stringify(params.prompt).length,
      };
      current.summaries.push(sample);
      save();
      const started = Date.now();
      try {
        const result = await doGenerate();
        sample.usage = result.usage;
        sample.finishReason = result.finishReason;
        return result;
      } catch (error) {
        sample.error = diagnosticError(error);
        throw error;
      } finally {
        sample.elapsedMs = Date.now() - started;
        save();
      }
    },
    wrapStream: async ({ doStream }) => {
      current.providerRequests++;
      save();
      return doStream();
    },
  },
});
function createSession() {
  const checkpoint = store.getLatestCheckpoint(id);
  return new AgentSession({
    id,
    model,
    sources: [],
    maxSteps: 20,
    contextWindow: 128000,
    turnTimeoutMs: 300000,
    debugEvents: true,
    providerOptions: llm.providerOptions,
    structuredOutputProviderOptions: llm.structuredOutputProviderOptions,
    structuredOutputReasoning: llm.structuredOutputReasoning,
    initialMessages: store.getMessages(id),
    ...(checkpoint ? { initialCheckpoint: checkpoint } : {}),
    policy: {
      check: ({ input }) => {
        const paths = [input.file_path, input.path].filter((value) => typeof value === "string");
        return paths.every(
          (path) => resolve(work, path) === work || resolve(work, path).startsWith(work + "/"),
        )
          ? { action: "allow" }
          : {
              action: "deny",
              reason: "Acceptance tools are restricted to the generated temporary workspace.",
            };
      },
    },
    fileTools: { workdir: work },
    capabilityContext: { profile: "summary-acceptance", cwd: work, agentCount: 0 },
    systemPrompt: `Work only inside ${work}. This is an isolated coding task. Use the historical specification and original transcript when needed. Do not read benchmark scripts or other directories.`,
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 2,
      keepRecentTokens: 2048,
      timeoutMs: 120000,
      maxOutputTokens: 8192,
    },
    onAcceptInput: (inputId, message) => store.acceptTurnInput(id, inputId, message),
    onPersist: (messages, options) => store.appendMessages(id, messages, options),
    onToolExecution: (record) => store.appendToolExecution(id, record),
    listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
    listToolExecutions: (options) => store.listToolExecutions(id, options),
    getToolExecution: (executionId) => store.getToolExecution(id, executionId),
    recoverUncoveredToolExecutions: () => [],
    readCheckpointTranscript: (options) => store.readCheckpointTranscript(id, options),
    commitCompaction: (input) => store.commitCompaction(id, input),
  });
}
async function drain(session, events) {
  for await (const event of events) {
    if (event.type === "confirmation-required") session.approve(event.approvalId);
    if (event.type === "context-compacted") current.compactions.push(event);
    if (event.type === "error") current.errors.push(diagnosticError(event.message));
    if (event.type === "debug" && event.stage === "compaction") current.debug.push(event);
    save();
  }
}
try {
  for (let cycle = 1; cycle <= 3; cycle++) {
    current = { cycle, summaries: [], providerRequests: 0, errors: [], compactions: [], debug: [] };
    report.rounds.push(current);
    addHistory(cycle);
    current.transcriptBefore = store.listTranscriptMessages(id, { limit: 500 }).length;
    let session = createSession();
    try {
      await drain(session, session.compact("manual"));
    } finally {
      await session.close();
    }
    current.checkpointGeneration = store.getLatestCheckpoint(id)?.generation;
    current.summaryIncludesMarker =
      store.getLatestCheckpoint(id)?.taskSummary?.includes(marker) ?? false;
    assert.ok(
      current.compactions.some((event) => event.removed > 0),
      "manual summary must commit",
    );
    assert.equal(current.summaries.length, 1, "one summary attempt per cycle");
    assert.equal(store.listTranscriptMessages(id, { limit: 500 }).length, current.transcriptBefore);
    store.close();
    store = new ThreadStore(join(work, "state"));
    session = createSession();
    try {
      await drain(session, session.send(prompts[cycle - 1]));
      current.finalBudget = session.getRequestBudgetState().last;
    } finally {
      await session.close();
    }
    const retry = await import(pathToFileURL(join(work, "retry.mjs")) + `?cycle=${cycle}`);
    current.checks = grade(retry.planRetry);
    if (cycle >= 2) {
      const batch = await import(pathToFileURL(join(work, "dispatcher.mjs")) + `?cycle=${cycle}`);
      current.checks.push(...batchGrade(batch.planBatch));
      if (cycle === 3) {
        assert.deepEqual(
          batch.planTaggedBatch([{ id: "tail", attempt: 0, outcome: "tool_failed" }], {
            elapsedMs: 0,
            budgetMs: 5000,
          }),
          [{ id: "tail", delayMs: 100, recoveryTag: marker }],
        );
        current.hiddenFactPassed = true;
        current.transcriptReads = store
          .listToolExecutions(id, { limit: 500 })
          .filter((entry) => entry.toolName === "transcript").length;
        assert.ok(current.transcriptReads > 0, "model must actually recall original transcript");
      }
    }
    current.passed = current.errors.length === 0 && current.checks.every((check) => check.passed);
    console.log(
      JSON.stringify({
        cycle,
        summaries: current.summaries.length,
        passed: current.checks.filter((check) => check.passed).length,
        total: current.checks.length,
        errors: current.errors,
      }),
    );
    save();
    if (!current.passed) break;
  }
  report.status =
    report.rounds.length === 3 && report.rounds.every((round) => round.passed)
      ? "three_cycles_passed"
      : "failed";
} catch (error) {
  report.status = "failed";
  report.error = diagnosticError(error);
} finally {
  store.close();
  llm.connection?.dispose();
  save();
}
console.log(JSON.stringify({ status: report.status, artifacts: work, error: report.error }));
process.exitCode = report.status === "three_cycles_passed" ? 0 : 1;
