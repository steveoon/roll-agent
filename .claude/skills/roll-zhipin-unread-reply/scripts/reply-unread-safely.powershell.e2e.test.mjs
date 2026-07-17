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

test(
  "PowerShell preview failure preserves safe diagnostics and never sends",
  { skip: process.platform !== "win32" },
  () => {
    const testDir = mkdtempSync(path.join(tmpdir(), "roll-zhipin-powershell-e2e-"));
    const shimDir = path.join(testDir, "bin");
    mkdirSync(shimDir);

    const tracePath = path.join(testDir, "roll.trace.jsonl");
    const resultsPath = path.join(testDir, "results.jsonl");
    const shimScriptPath = path.join(shimDir, "roll-shim.mjs");
    const shimCommandPath = path.join(shimDir, "roll.cmd");

    writeFileSync(shimCommandPath, '@echo off\r\nnode "%~dp0roll-shim.mjs" %*\r\n', "utf8");
    writeFileSync(
      shimScriptPath,
      String.raw`import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "agent" && args[1] === "health") {
  console.log('[{"agentName":"browser-use-agent","healthy":true}]');
  process.exit(0);
}
if (args[0] !== "run") {
  console.log('{"success":false,"error":"unexpected roll command"}');
  process.exit(0);
}

const tool = args[2];
const inputFileIndex = args.indexOf("--input-file");
let input = {};
if (inputFileIndex >= 0 && args[inputFileIndex + 1]) {
  input = JSON.parse(readFileSync(args[inputFileIndex + 1], "utf8"));
}
appendFileSync(process.env.ROLL_SHIM_TRACE, JSON.stringify({ tool, input }) + "\n");

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
console.log(JSON.stringify(responses[tool] ?? { success: false, error: "unexpected tool" }));
`,
      "utf8",
    );

    try {
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
          "-NoUnreadFilter",
          "-NoExchangeWechat",
          "-ResultsFile",
          resultsPath,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
            ROLL_SHIM_TRACE: tracePath,
          },
        },
      );
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

      const calls = readFileSync(tracePath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      const tools = calls.map((call) => call.tool);
      assert.equal(tools.includes("zhipin_generate_reply_preview"), true);
      assert.equal(tools.includes("zhipin_send_prepared_reply"), false);

      const row = JSON.parse(readFileSync(resultsPath, "utf8").trim());
      assert.deepEqual(row, {
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
      });
      assert.doesNotMatch(readFileSync(resultsPath, "utf8"), /signedEnvelope|must-not-leak|https:/);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);
