#!/usr/bin/env node
// Opt-in live-model coding comparison. Uses the existing configured account/model/effort.
// No mock generation, repository writes, credential output, or configuration changes.
// node --experimental-strip-types --experimental-sqlite scripts/bench/compaction-coding-quality.mjs --run
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "../..");
const { values } = parseArgs({
  options: {
    run: { type: "boolean" },
    output: { type: "string" },
    preflight: { type: "boolean" },
    variant: { type: "string" },
    fixture: { type: "string", default: "baseline" },
  },
});
if (values.variant !== undefined && !["compacted", "uncompressed"].includes(values.variant)) {
  throw new Error("Invalid variant");
}
if (!["baseline", "dispersed"].includes(values.fixture)) throw new Error("Invalid fixture");
if (!values.run && !values.preflight) {
  console.log(
    "Use --preflight to check the existing login, or --run for a live coding comparison.",
  );
  process.exit(0);
}
const { loadConfig } = await import(`${root}/packages/core/src/config/loader.ts`);
const { resolveInteractiveChatLlm } = await import(
  `${root}/packages/core/src/runtime-host/chatgpt-resolution.ts`
);
const report = {
  kind: "live model; seeded long conversation; isolated real code edits and independent assertions; one paired sample, not a general quality guarantee",
  startedAt: new Date().toISOString(),
  status: "pending",
  fixture: values.fixture,
  variants: [],
};
const save = () => {
  if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
};
let llm;
try {
  const { config } = loadConfig();
  llm = await resolveInteractiveChatLlm(config);
  report.provider = llm.provider;
  report.model = llm.modelName;
  report.effort = config.runtime.thinkingLevel;
  report.summaryEffort = config.runtime.compaction.thinkingLevel ?? config.runtime.thinkingLevel;
} catch (error) {
  report.status = "blocked_login";
  report.error = { name: error?.name, code: error?.code, causeCode: error?.cause?.code };
  save();
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}
if (values.preflight) {
  report.status = "login_ready";
  save();
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const { AgentSession } = await import(`${root}/packages/runtime/src/engine/agent-session.ts`);
const { ThreadStore } = await import(`${root}/packages/runtime/src/store/thread-store.ts`);
const require = createRequire(`${root}/packages/runtime/package.json`);
const { wrapLanguageModel } = await import(pathToFileURL(require.resolve("ai")));
const facts = [
  "Implement and export only planRetry({attempt,outcome,retryAfterMs,elapsedMs,budgetMs}) from retry.mjs. Return exactly {retry:boolean,delayMs:number}; do not mutate the input.",
  "attempt must be a nonnegative safe integer. elapsedMs and budgetMs must be finite nonnegative numbers. retryAfterMs, if supplied, must be a finite nonnegative number. Invalid numeric input throws RangeError, even for terminal outcomes.",
  "Allowed outcomes are tool_failed, not_executed, success, policy_denied, outcome_unknown. Every other outcome throws TypeError. Only tool_failed and not_executed can retry; all others return {retry:false,delayMs:0}. Never retry outcome_unknown.",
  "For retryable outcomes use min(100 * 2 ** attempt, 1739) milliseconds, then take max with retryAfterMs (default 0). Retry-After must not be clipped to 1739. Extremely large safe integer attempts must saturate safely.",
  "A retry is admitted only when elapsedMs + delayMs <= budgetMs, including exact equality. Otherwise return {retry:false,delayMs:0}. Do not wait, perform I/O, send requests, or add dependencies.",
];
const history = [];
for (let i = 0; i < 20; i++) {
  const factIndex = values.fixture === "dispersed" ? [0, 3, 7, 11, 14].indexOf(i) : i;
  const fact = facts[factIndex];
  const filler = "Archived discussion with no new requirement.\n".repeat(100);
  history.push({
    role: "user",
    content:
      fact === undefined
        ? "Continue the same retry planner task."
        : values.fixture === "baseline"
          ? fact
          : factIndex % 2 === 0
            ? `${filler}${fact}\n${filler}`
            : `${filler}${fact}`,
  });
  history.push({
    role: "assistant",
    content:
      `Historical inspection ${i}.\n` +
      "The archive includes routine inspection with no additional requirements. ".repeat(
        values.fixture === "dispersed" ? 240 : 260,
      ),
  });
}
const work = mkdtempSync(join(tmpdir(), "roll-live-compaction-coding-"));
report.artifacts = work;
const fixture =
  "export function planRetry({attempt,outcome,retryAfterMs,elapsedMs,budgetMs}) {\n  return {retry:false,delayMs:0};\n}\n";
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
for (const compact of values.variant === "compacted"
  ? [true]
  : values.variant === "uncompressed"
    ? [false]
    : [false, true]) {
  const name = compact ? "compacted" : "uncompressed";
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "retry.mjs"), fixture);
  const store = new ThreadStore(join(dir, "state"));
  const id = store.createThread();
  store.appendMessages(id, history);
  const variant = {
    name,
    summaryCalls: 0,
    modelRequests: 0,
    requestCharacters: [],
    modelFactVisibility: [],
    compactions: [],
    errors: [],
    usage: [],
    summaryRequests: [],
    summaryResults: [],
    debug: [],
  };
  report.variants.push(variant);
  const model = wrapLanguageModel({
    model: llm.model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params, type }) => {
        if (type === "generate") {
          variant.summaryCalls++;
          const prompt = params.prompt
            .flatMap((message) =>
              message.role === "user"
                ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                : [],
            )
            .join("\n");
          variant.summaryRequests.push({
            at: new Date().toISOString(),
            promptChars: JSON.stringify(params.prompt).length,
            sourceChars: prompt.length,
          });
          save();
        } else {
          variant.modelRequests++;
          variant.requestCharacters.push(JSON.stringify(params.prompt).length);
          variant.modelFactVisibility.push(
            facts.map((fact) => JSON.stringify(params.prompt).includes(fact)),
          );
        }
        return params;
      },
      wrapGenerate: async ({ doGenerate }) => {
        const started = Date.now();
        try {
          const result = await doGenerate();
          variant.summaryResults.push({
            elapsedMs: Date.now() - started,
            finishReason: result.finishReason,
            usage: result.usage,
            content: result.content.filter((part) => part.type === "text"),
          });
          return result;
        } catch (error) {
          variant.summaryResults.push({
            elapsedMs: Date.now() - started,
            error: {
              name: error?.name,
              code: error?.code,
              message: String(error?.message)
                .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
                .slice(0, 300),
            },
          });
          throw error;
        } finally {
          save();
        }
      },
    },
  });
  const session = new AgentSession({
    id,
    model,
    sources: [],
    maxSteps: 18,
    debugEvents: true,
    turnTimeoutMs: 300000,
    contextWindow: 128000,
    providerOptions: llm.providerOptions,
    structuredOutputProviderOptions: llm.structuredOutputProviderOptions,
    initialMessages: store.getMessages(id),
    fileTools: { workdir: dir },
    capabilityContext: { profile: "coding-evaluation", cwd: dir, agentCount: 0 },
    systemPrompt: `Work only inside ${dir}. This is an isolated coding evaluation. Read retry.mjs and complete the previously specified retry planner. Do not read the benchmark script or other directories.`,
    compaction: {
      enabled: compact,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 2,
      keepRecentTokens: 2048,
      timeoutMs: 120000,
      maxOutputTokens: 8192,
    },
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
    for await (const event of session.send(
      "Continue the same task. Implement retry.mjs according to all previously agreed requirements, verify the file, then report completion.",
    )) {
      if (event.type === "debug" && event.stage === "compaction") {
        variant.debug.push({ at: new Date().toISOString(), ...event });
        save();
      }
      if (event.type === "confirmation-required") session.approve(event.approvalId);
      if (event.type === "context-compacted") {
        variant.compactions.push({ removed: event.removed, kept: event.kept });
      }
      if (event.type === "error") {
        variant.errors.push({
          stage: event.stage,
          message: event.message.replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]").slice(0, 600),
        });
      }
      if (event.type === "step-finish" && event.usage) variant.usage.push(event.usage);
    }
    variant.finalBudget = session.getRequestBudgetState().last;
    const checkpoint = store.getLatestCheckpoint(id);
    variant.checkpointFactVisibility = facts.map((fact) =>
      JSON.stringify(checkpoint ?? {}).includes(fact),
    );
    variant.codeChanged = readFileSync(join(dir, "retry.mjs"), "utf8") !== fixture;
    try {
      const mod = await import(pathToFileURL(join(dir, "retry.mjs")));
      variant.checks = grade(mod.planRetry);
      variant.passed = variant.checks.filter((x) => x.passed).length;
      variant.total = variant.checks.length;
      variant.publicExports = Object.keys(mod);
    } catch (error) {
      variant.importError = error?.name;
      variant.passed = 0;
      variant.total = 14;
    }
  } finally {
    await session.close();
    store.close();
    save();
  }
  console.log(
    JSON.stringify({
      name,
      passed: variant.passed,
      total: variant.total,
      summaryCalls: variant.summaryCalls,
      errors: variant.errors,
    }),
  );
}
report.status =
  report.variants.length === (values.variant ? 1 : 2) &&
  report.variants.every(
    (v) =>
      v.errors.length === 0 &&
      v.passed === v.total &&
      v.codeChanged &&
      v.publicExports.length === 1 &&
      v.publicExports[0] === "planRetry",
  ) &&
  report.variants.every((v) => v.name !== "compacted" || v.compactions.some((x) => x.removed > 0))
    ? values.variant
      ? "single_sample_passed"
      : "paired_sample_passed"
    : "incomplete_or_failed";
save();
console.log(JSON.stringify({ status: report.status, artifacts: work }));
process.exitCode = report.status.endsWith("sample_passed") ? 0 : 1;
