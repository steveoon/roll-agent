#!/usr/bin/env node
/** PATH-shim trace for the real Bash batch entrypoint (one candidate, no browser). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(dir, "reply-unread-safely.sh");
const powershellScriptPath = path.join(dir, "reply-unread-safely.ps1");
const testDir = mkdtempSync(path.join(tmpdir(), "roll-zhipin-bash-e2e-"));
const shimDir = path.join(testDir, "bin");
const staleShimDir = path.join(testDir, "stale-bin");

const makeShim = spawnSync("mkdir", ["-p", shimDir], { encoding: "utf8" });
assert.equal(makeShim.status, 0, makeShim.stderr);
const makeStaleShim = spawnSync("mkdir", ["-p", staleShimDir], { encoding: "utf8" });
assert.equal(makeStaleShim.status, 0, makeStaleShim.stderr);

const rollShimPath = path.join(shimDir, "roll");
writeFileSync(
  rollShimPath,
  String.raw`#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "agent" && "$2" == "health" ]]; then
  echo '[{"agentName":"browser-use-agent","healthy":true}]'
  exit 0
fi

if [[ "$1" != "run" ]]; then
  echo '{"success":false,"error":"unexpected roll command"}'
  exit 0
fi

tool="$3"
input='{}'
if [[ "$4" == "--input-file" && -f "$5" ]]; then
  input="$(cat "$5")"
fi
printf '%s\t%s\n' "$tool" "$input" >>"$ROLL_SHIM_TRACE"

case "$tool" in
  browser_status)
    if [[ "$ROLL_SHIM_FAIL_STATUS" == "1" ]]; then
      printf '%s\n' 'fixture browser_status failed' >&2
      exit 23
    fi
    printf '{\n  "instances": [\n    {"id":"boss-a"}\n'
    printf '%s\n' 'fixture-agent stderr between JSON chunks' >&2
    sleep 0.05
    printf '  ],\n  "defaultInstanceId": "boss-a"\n}\n'
    ;;
  zhipin_open_chat_page)
    echo '{"success":true,"chatReady":true}'
    ;;
  zhipin_read_messages)
    if [[ "$ROLL_SHIM_RESTRICTED" == "read" ]]; then
      echo '{"ok":false,"error":"tool 返回 isError=true","result":{"code":"zhipin_access_restricted","message":"BOSS 风控页已出现（ip_block）。","details":{"kind":"ip_block","url":"https://www.zhipin.com/web/passport/zp/403.html?code=31","title":"访问受限"}}}'
    else
      echo '{"candidates":[{"conversationId":"cid-e2e","name":"Alice","preview":"请问排班时间？"}],"page":{"url":"https://www.zhipin.com/web/chat/index","title":"BOSS直聘"}}'
    fi
    ;;
  zhipin_open_chat)
    if [[ "$ROLL_SHIM_RESTRICTED" == "open" ]]; then
      echo '{"ok":false,"error":"tool 返回 isError=true","result":{"code":"zhipin_access_restricted","message":"BOSS 风控页已出现（ip_block）。","details":{"kind":"ip_block","url":"https://www.zhipin.com/web/passport/zp/403.html?code=31","title":"访问受限"}}}'
    else
      echo '{"success":true,"conversationId":"cid-e2e"}'
    fi
    ;;
  browser_snapshot)
    echo '{"page":{"url":"https://www.zhipin.com/web/chat/index","title":"BOSS直聘"},"snapshot":{"text":"正常会话"}}'
    ;;
  zhipin_get_candidate_info)
    echo '{"candidateInfo":{"age":"30岁","experience":"5年"},"preferredBrand":"测试品牌","chatMessages":[]}'
    ;;
  zhipin_generate_reply_preview)
    if [[ "$ROLL_SHIM_PREVIEW_FAILURE" == "1" ]]; then
      echo '{"success":false,"error":"AI 响应超时：回复生成超过服务端截止时间 (50000ms)","errorKind":"timeout","requestId":"req-e2e-timeout","elapsedMs":50031,"clientTimeoutMs":60000,"lastStartedPhase":"turn_planning","activePhase":"turn_planning","phaseLatencies":{"tenant_context":7,"binding_check":4},"signedEnvelope":"must-not-leak"}'
    else
      echo '{"success":true,"preparedReplyId":"prep-e2e","replyVariantSelection":{"options":[{"option":"option_1","suggestedReply":"A"},{"option":"option_2","suggestedReply":"B"}]}}'
    fi
    ;;
  zhipin_send_prepared_reply)
    if [[ "$ROLL_SHIM_NO_JUDGE" == "1" ]]; then
      echo '{"success":true,"sentMessage":"A","chosenOption":"option_1","decisionSource":"explicit_no_judge","decisionReason":"operator_requested_no_judge","feedbackExpected":false,"feedbackStatus":"accepted"}'
    else
      echo '{"success":true,"sentMessage":"B","chosenOption":"option_2","decisionSource":"judge","decisionReason":"B 更直接回答排班问题","judgeModel":"mcp-sampling","feedbackExpected":true,"feedbackStatus":"accepted"}'
    fi
    ;;
  *)
    echo '{"success":false,"error":"unexpected tool"}'
    ;;
esac
`,
  "utf8",
);
chmodSync(rollShimPath, 0o755);

const staleRollPath = path.join(staleShimDir, "roll");
writeFileSync(staleRollPath, "#!/bin/sh\necho 'stale roll must not run' >&2\nexit 99\n", "utf8");
chmodSync(staleRollPath, 0o755);

function runScenario(name, noJudge, previewFailure = false, useCurrentCli = false) {
  const tracePath = path.join(testDir, `${name}.trace`);
  const resultsPath = path.join(testDir, `${name}.jsonl`);
  const args = [
    scriptPath,
    "--limit",
    "1",
    "--no-unread-filter",
    "--no-exchange-wechat",
    "--results-file",
    resultsPath,
  ];
  if (noJudge) {
    args.push("--no-judge");
  }

  const result = spawnSync("bash", args, {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${useCurrentCli ? staleShimDir : shimDir}:${process.env.PATH ?? ""}`,
      ...(useCurrentCli ? { ROLL_CURRENT_CLI: rollShimPath } : {}),
      ROLL_SHIM_TRACE: tracePath,
      ROLL_SHIM_NO_JUDGE: noJudge ? "1" : "0",
      ROLL_SHIM_PREVIEW_FAILURE: previewFailure ? "1" : "0",
      ROLL_SHIM_FAIL_STATUS: "0",
      ROLL_SHIM_RESTRICTED: "0",
    },
  });
  assert.equal(result.status, 0, `${name} failed:\n${result.stderr}\n${result.stdout}`);

  const calls = readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("\t");
      return {
        tool: line.slice(0, separator),
        input: JSON.parse(line.slice(separator + 1)),
      };
    });
  const tools = calls.map((call) => call.tool);
  assert.equal(tools.includes("zhipin_judge_prepared_reply"), false);
  const resultRow = JSON.parse(readFileSync(resultsPath, "utf8").trim());
  if (previewFailure) {
    assert.equal(tools.includes("zhipin_send_prepared_reply"), false);
    return { sendInput: null, resultRow };
  }

  assert.ok(
    tools.indexOf("zhipin_generate_reply_preview") < tools.indexOf("zhipin_send_prepared_reply"),
  );
  const sendCall = calls.find((call) => call.tool === "zhipin_send_prepared_reply");
  assert.ok(sendCall);
  return { sendInput: sendCall.input, resultRow };
}

try {
  const powershellSource = readFileSync(powershellScriptPath, "utf8");
  assert.doesNotMatch(powershellSource, /zhipin_judge_prepared_reply/);
  assert.match(powershellSource, /BuildSendPayload/);
  assert.match(powershellSource, /FormatPreviewFailure/);

  const currentCli = runScenario("current-cli", false, false, true);
  assert.deepEqual(currentCli.sendInput, { preparedReplyId: "prep-e2e" });

  const normal = runScenario("normal", false);
  assert.deepEqual(normal.sendInput, { preparedReplyId: "prep-e2e" });
  assert.equal(normal.resultRow.decisionSource, "judge");
  assert.equal(normal.resultRow.feedbackClosed, true);
  assert.equal(normal.resultRow.feedbackGap, false);
  assert.equal(normal.resultRow.learningSkipped, false);

  const noJudge = runScenario("no-judge", true);
  assert.deepEqual(noJudge.sendInput, {
    preparedReplyId: "prep-e2e",
    skipVariantJudge: true,
  });
  assert.equal(noJudge.resultRow.decisionSource, "explicit_no_judge");
  assert.equal(noJudge.resultRow.feedbackGap, false);
  assert.equal(noJudge.resultRow.feedbackClosed, true);
  assert.equal(noJudge.resultRow.learningSkipped, true);

  const previewFailure = runScenario("preview-failure", false, true);
  assert.deepEqual(previewFailure.resultRow, {
    ts: previewFailure.resultRow.ts,
    name: "Alice",
    conversationId: "cid-e2e",
    ok: false,
    stage: "preview",
    error: "AI 响应超时：回复生成超过服务端截止时间 (50000ms)",
    errorKind: "timeout",
    requestId: "req-e2e-timeout",
    elapsedMs: 50_031,
    clientTimeoutMs: 60_000,
    lastStartedPhase: "turn_planning",
    activePhase: "turn_planning",
    phaseLatencies: { tenant_context: 7, binding_check: 4 },
  });

  const statusFailureTracePath = path.join(testDir, "status-failure.trace");
  const statusFailureResultsPath = path.join(testDir, "status-failure.jsonl");
  const statusFailure = spawnSync(
    "bash",
    [
      scriptPath,
      "--limit",
      "1",
      "--no-unread-filter",
      "--no-exchange-wechat",
      "--results-file",
      statusFailureResultsPath,
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        ROLL_SHIM_TRACE: statusFailureTracePath,
        ROLL_SHIM_FAIL_STATUS: "1",
        ROLL_SHIM_RESTRICTED: "0",
      },
    },
  );
  assert.notEqual(statusFailure.status, 0);
  assert.match(statusFailure.stderr, /fixture browser_status failed/);
  const statusFailureTools = readFileSync(statusFailureTracePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf("\t")));
  assert.equal(statusFailureTools.includes("zhipin_open_chat_page"), false);

  function runRestricted(name, restricted) {
    const tracePath = path.join(testDir, `${name}.trace`);
    const resultsPath = path.join(testDir, `${name}.jsonl`);
    return {
      tracePath,
      resultsPath,
      result: spawnSync(
        "bash",
        [
          scriptPath,
          "--limit",
          "1",
          "--no-unread-filter",
          "--no-exchange-wechat",
          "--results-file",
          resultsPath,
        ],
        {
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            PATH: `${shimDir}:${process.env.PATH ?? ""}`,
            ROLL_SHIM_TRACE: tracePath,
            ROLL_SHIM_FAIL_STATUS: "0",
            ROLL_SHIM_RESTRICTED: restricted,
          },
        },
      ),
    };
  }

  const restrictedRead = runRestricted("restricted-read", "read");
  assert.equal(restrictedRead.result.status, 2, restrictedRead.result.stderr);
  assert.match(restrictedRead.result.stderr, /STOP: access_restricted \(read_messages\)/);
  assert.match(restrictedRead.result.stderr, /do not reload or retry/);
  const restrictedReadTools = readFileSync(restrictedRead.tracePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf("\t")));
  assert.equal(restrictedReadTools.includes("zhipin_open_chat"), false);
  const restrictedReadRow = JSON.parse(readFileSync(restrictedRead.resultsPath, "utf8").trim());
  assert.equal(restrictedReadRow.reason, "access_restricted");
  assert.equal(restrictedReadRow.stage, "read_messages");

  const restrictedOpen = runRestricted("restricted-open", "open");
  assert.equal(restrictedOpen.result.status, 2, restrictedOpen.result.stderr);
  assert.match(restrictedOpen.result.stderr, /STOP: access_restricted \(open_chat\)/);
  const restrictedOpenCalls = readFileSync(restrictedOpen.tracePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      return {
        tool: line.slice(0, separator),
        input: JSON.parse(line.slice(separator + 1)),
      };
    });
  assert.equal(
    restrictedOpenCalls.some((call) => call.input.forceReload === true),
    false,
  );
  assert.equal(restrictedOpenCalls.filter((call) => call.tool === "zhipin_open_chat").length, 1);
  const restrictedOpenRow = JSON.parse(readFileSync(restrictedOpen.resultsPath, "utf8").trim());
  assert.equal(restrictedOpenRow.reason, "access_restricted");
  assert.equal(restrictedOpenRow.stage, "open_chat");

  console.log("reply-unread-safely.e2e.test.mjs: ok");
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
