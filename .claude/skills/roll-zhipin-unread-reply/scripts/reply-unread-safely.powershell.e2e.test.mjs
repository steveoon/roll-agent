#!/usr/bin/env node
/** Windows PATH-shim trace for the real PowerShell batch preview-failure path. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(dir, "reply-unread-safely.ps1");

/**
 * Windows env keys are case-insensitive; spreading process.env and then setting only
 * `PATH` can leave the original `Path` entry winning for child resolution.
 */
function envWithPrependedPath(baseEnv, shimDir) {
  const env = { ...baseEnv };
  const current = env.Path ?? env.PATH ?? "";
  delete env.Path;
  delete env.PATH;
  env.Path = `${shimDir}${path.delimiter}${current}`;
  return env;
}

test(
  "PowerShell preview failure preserves safe diagnostics and never sends",
  { skip: process.platform !== "win32" },
  () => {
    const testDir = mkdtempSync(path.join(tmpdir(), "roll-zhipin-powershell-e2e-"));
    const shimDir = path.join(testDir, "bin");
    const staleShimDir = path.join(testDir, "stale-bin");
    mkdirSync(shimDir);
    mkdirSync(staleShimDir);

    const tracePath = path.join(testDir, "roll.trace.jsonl");
    const resultsPath = path.join(testDir, "results.jsonl");
    const shimScriptPath = path.join(shimDir, "roll-shim.mjs");
    const shimCommandPath = path.join(shimDir, "roll.cmd");

    // Prefer an absolute node path so the cmd shim does not depend on PATH lookup.
    const nodePath = process.execPath;
    writeFileSync(
      shimCommandPath,
      [
        "@echo off",
        "setlocal",
        `"${nodePath}" "%~dp0roll-shim.mjs" %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
      "utf8",
    );
    writeFileSync(path.join(staleShimDir, "roll.cmd"), "@echo off\r\nexit /b 99\r\n", "utf8");
    writeFileSync(
      shimScriptPath,
      String.raw`import { appendFileSync, readFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const tracePath = process.env.ROLL_SHIM_TRACE;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
function trace(entry) {
  if (!tracePath) return;
  appendFileSync(tracePath, JSON.stringify(entry) + "\n");
}

function writeJsonWithInterleavedStderr(value) {
  const json = JSON.stringify(value, null, 2);
  const splitAt = json.indexOf('"defaultInstanceId"');
  if (splitAt < 0) throw new Error("browser_status fixture is missing defaultInstanceId");
  writeSync(1, json.slice(0, splitAt));
  Atomics.wait(waitBuffer, 0, 0, 25);
  writeSync(2, "fixture-agent stderr between JSON chunks\n");
  Atomics.wait(waitBuffer, 0, 0, 25);
  writeSync(1, json.slice(splitAt) + "\n");
}

if (args[0] === "agent" && args[1] === "health") {
  trace({ kind: "health", args });
  console.log('[{"agentName":"browser-use-agent","healthy":true}]');
  process.exit(0);
}
if (args[0] !== "run") {
  trace({ kind: "other", args });
  console.log('{"success":false,"error":"unexpected roll command"}');
  process.exit(0);
}

const tool = args[2];
const inputFileIndex = args.indexOf("--input-file");
let input = {};
let inputError;
if (inputFileIndex >= 0 && args[inputFileIndex + 1]) {
  try {
    input = JSON.parse(readFileSync(args[inputFileIndex + 1], "utf8"));
  } catch (error) {
    inputError = error instanceof Error ? error.message : String(error);
  }
}
trace({ kind: "run", tool, args, input, inputError });

const responses = {
  browser_status: { instances: [], defaultInstanceId: null },
  zhipin_open_chat_page: { success: true, chatReady: true },
  zhipin_read_messages: {
    candidates: [{ conversationId: "cid-pwsh-e2e", name: "Alice", preview: "schedule?" }],
    page: { url: "https://www.zhipin.com/web/chat/index", title: "BOSS" },
  },
  zhipin_open_chat: { success: true, conversationId: "cid-pwsh-e2e" },
  browser_snapshot: {
    page: { url: "https://www.zhipin.com/web/chat/index", title: "BOSS" },
    snapshot: { text: "normal chat" },
  },
  zhipin_get_candidate_info: {
    candidateInfo: { age: "30", experience: "5 years" },
    preferredBrand: "test-brand",
    chatMessages: [],
  },
  zhipin_generate_reply_preview: {
    success: false,
    error:
      "RFC request deadline exceeded " +
      "(url=https://reply-authority.example/generate-signed-reply, timeoutMs=60000)",
    errorKind: "timeout",
    requestId: "req-pwsh-timeout",
    elapsedMs: 50031,
    clientTimeoutMs: 60000,
    lastStartedPhase: "turn_planning",
    activePhase: "turn_planning",
    phaseLatencies: { tenant_context: 7, binding_check: 4 },
    signedEnvelope: "must-not-leak",
  },
};
const response = responses[tool] ?? { success: false, error: "unexpected tool", tool };
if (tool === "browser_status") {
  if (process.env.ROLL_SHIM_FAIL_STATUS === "1") {
    writeSync(2, "fixture browser_status failed\n");
    process.exit(23);
  }
  writeJsonWithInterleavedStderr(response);
} else {
  console.log(JSON.stringify(response));
}
`,
      "utf8",
    );

    try {
      // Exercise both native PowerShell and bash-parity option spellings through Parse-Args.
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-Limit",
          "1",
          "--no-unread-filter",
          "-NoExchangeWechat",
          "--results-file",
          resultsPath,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...envWithPrependedPath(process.env, staleShimDir),
            ROLL_CURRENT_CLI: shimCommandPath,
            ROLL_SHIM_TRACE: tracePath,
          },
        },
      );

      const traceText = (() => {
        try {
          return readFileSync(tracePath, "utf8");
        } catch {
          return "<missing trace>";
        }
      })();
      const resultsText = (() => {
        try {
          return readFileSync(resultsPath, "utf8");
        } catch {
          return "<missing results>";
        }
      })();
      const debug = [
        `status=${String(result.status)}`,
        `stdout:\n${result.stdout ?? ""}`,
        `stderr:\n${result.stderr ?? ""}`,
        `trace:\n${traceText}`,
        `results:\n${resultsText}`,
      ].join("\n");

      assert.equal(result.status, 0, debug);

      const calls = traceText
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const tools = calls.filter((call) => call.kind === "run").map((call) => call.tool);
      assert.equal(tools.includes("zhipin_generate_reply_preview"), true, debug);
      assert.equal(tools.includes("zhipin_send_prepared_reply"), false, debug);

      const row = JSON.parse(resultsText.trim());
      assert.deepEqual(
        row,
        {
          ts: row.ts,
          name: "Alice",
          conversationId: "cid-pwsh-e2e",
          ok: false,
          stage: "preview",
          error: "RFC request deadline exceeded",
          errorKind: "timeout",
          requestId: "req-pwsh-timeout",
          elapsedMs: 50_031,
          clientTimeoutMs: 60_000,
          lastStartedPhase: "turn_planning",
          activePhase: "turn_planning",
          phaseLatencies: { tenant_context: 7, binding_check: 4 },
        },
        debug,
      );
      assert.doesNotMatch(resultsText, /signedEnvelope|must-not-leak|https:/);

      const statusFailureTracePath = path.join(testDir, "status-failure.trace.jsonl");
      const statusFailureResultsPath = path.join(testDir, "status-failure.results.jsonl");
      const statusFailure = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-Limit",
          "1",
          "--no-unread-filter",
          "-NoExchangeWechat",
          "--results-file",
          statusFailureResultsPath,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...envWithPrependedPath(process.env, staleShimDir),
            ROLL_CURRENT_CLI: shimCommandPath,
            ROLL_SHIM_TRACE: statusFailureTracePath,
            ROLL_SHIM_FAIL_STATUS: "1",
          },
        },
      );
      assert.notEqual(statusFailure.status, 0);
      assert.match(statusFailure.stderr, /fixture browser_status failed/);
      const statusFailureCalls = readFileSync(statusFailureTracePath, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(
        statusFailureCalls.some(
          (call) => call.kind === "run" && call.tool === "zhipin_open_chat_page",
        ),
        false,
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);
