import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractLastJson } from "./roll-json-extract.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));

function runHelper(name, input, args = []) {
  return spawnSync("node", [path.join(dir, name), ...args], {
    input,
    encoding: "utf8",
  });
}

assert.equal(extractLastJson('noise {"a":1} tail {"b":2}'), '{"b":2}');

const unread = runHelper(
  "find-unread-ref.mjs",
  'stderr\n{"snapshot":{"refs":[{"name":"未读","ref":"@e32"}]}}\n',
);
assert.equal(unread.status, 0, unread.stderr);
assert.equal(unread.stdout.trim(), "@e32");

const unreadFallback = runHelper(
  "find-unread-ref.mjs",
  'broken {"name":"未读tab","ref":"@e99"} more garbage',
);
assert.equal(unreadFallback.status, 0, unreadFallback.stderr);
assert.equal(unreadFallback.stdout.trim(), "@e99");

const read = runHelper(
  "parse-read-candidate.mjs",
  JSON.stringify({
    candidates: [{ conversationId: "c1", name: "Li", preview: "hi" }],
    page: { url: "https://example.com", title: "t" },
  }),
);
assert.equal(read.status, 0);
assert.deepEqual(JSON.parse(read.stdout), {
  conversationId: "c1",
  name: "Li",
  preview: "hi",
  pageUrl: "https://example.com",
  pageTitle: "t",
});

const expired = runHelper("detect-expired-banner.mjs", "banner 沟通职位已到期 here");
assert.equal(expired.stdout.trim(), "expired");

const captcha = runHelper(
  "parse-page-meta.mjs",
  JSON.stringify({ page: { url: "https://x/verify.html", title: "安全验证" } }),
);
assert.equal(JSON.parse(captcha.stdout).captcha, true);

const multiInstanceNoSelection = runHelper(
  "validate-browser-selection.mjs",
  JSON.stringify({
    defaultInstanceId: null,
    instances: [{ id: "boss-a" }, { id: "boss-b" }],
  }),
);
assert.equal(multiInstanceNoSelection.status, 1);
assert.match(multiInstanceNoSelection.stderr, /pass --browser-instance/);

const explicitSelection = spawnSync("node", [path.join(dir, "validate-browser-selection.mjs")], {
  input: JSON.stringify({
    defaultInstanceId: null,
    instances: [{ id: "boss-a" }, { id: "boss-b" }],
  }),
  encoding: "utf8",
  env: { ...process.env, ROLL_BROWSER_INSTANCE: "boss-b" },
});
assert.equal(explicitSelection.status, 0, explicitSelection.stderr);

const previewDual = runHelper(
  "parse-generate-preview.mjs",
  JSON.stringify({
    success: true,
    preparedReplyId: "prep_1",
    replyVariantSelection: { options: [{ option: "option_1" }, { option: "option_2" }] },
  }),
);
assert.equal(previewDual.status, 0);
assert.deepEqual(JSON.parse(previewDual.stdout), {
  preparedReplyId: "prep_1",
  hasDualDraft: true,
});

const previewSingleOption = runHelper(
  "parse-generate-preview.mjs",
  JSON.stringify({
    success: true,
    preparedReplyId: "prep_2",
    replyVariantSelection: { options: [{ option: "option_1" }] },
  }),
);
assert.equal(previewSingleOption.status, 0);
assert.deepEqual(JSON.parse(previewSingleOption.stdout), {
  preparedReplyId: "prep_2",
  hasDualDraft: false,
});

const applyBundle = runHelper(
  "apply-send-bundle.mjs",
  JSON.stringify({
    sendInput: { preparedReplyId: "prep_3" },
    meta: { hasDualDraft: true },
  }),
  ["/tmp/roll-zhipin-sp-test.json"],
);
assert.equal(applyBundle.status, 0);

const formatSent = runHelper(
  "format-candidate-result.mjs",
  JSON.stringify({
    bundle: {
      meta: {
        hasDualDraft: true,
        feedbackExpected: true,
      },
    },
    send: {
      ok: true,
      chosenOption: "option_2",
      decisionSource: "judge",
      decisionReason: "更简洁且回答了排班问题",
      feedbackExpected: true,
      feedbackStatus: "accepted",
    },
  }),
  ["sent", "ts1", "Alice", "cid1", "prep_4", "1"],
);
assert.equal(formatSent.status, 0);
const sentLine = JSON.parse(formatSent.stdout);
assert.equal(sentLine.ok, true);
assert.equal(sentLine.chosenOption, "option_2");
assert.equal(sentLine.feedbackStatus, "accepted");
assert.equal(sentLine.feedbackClosed, true);
assert.equal(sentLine.feedbackQueued, false);
assert.equal(sentLine.feedbackGap, false);
assert.equal(sentLine.learningSkipped, false);
assert.equal(sentLine.decisionSource, "judge");
assert.equal(sentLine.decisionReason, "更简洁且回答了排班问题");
assert.equal(sentLine.exchangedWechat, true);

const sendPayload = runHelper("build-send-payload.mjs", "", ["prep_1", "1", "0"]);
assert.equal(sendPayload.status, 0);
const bundle = JSON.parse(sendPayload.stdout);
assert.deepEqual(bundle.sendInput, { preparedReplyId: "prep_1" });
assert.equal(bundle.meta.chosenOption, null);
assert.equal(bundle.meta.decisionSource, null);
assert.equal(bundle.meta.feedbackExpected, true);

const sendPayloadNoJudge = runHelper("build-send-payload.mjs", "", ["prep_2", "1", "1"]);
assert.equal(sendPayloadNoJudge.status, 0);
assert.deepEqual(JSON.parse(sendPayloadNoJudge.stdout).sendInput, {
  preparedReplyId: "prep_2",
  skipVariantJudge: true,
});
assert.equal(JSON.parse(sendPayloadNoJudge.stdout).meta.judgeSkipped, true);
assert.equal(JSON.parse(sendPayloadNoJudge.stdout).meta.decisionSource, "explicit_no_judge");

const sendResult = runHelper(
  "parse-send-result.mjs",
  JSON.stringify({
    success: true,
    chosenOption: "option_2",
    decisionSource: "judge",
    decisionReason: "更简洁且回答了排班问题",
    judgeModel: "mcp-sampling",
    feedbackExpected: true,
    feedbackStatus: "accepted",
  }),
);
assert.equal(sendResult.status, 0);
assert.deepEqual(JSON.parse(sendResult.stdout), {
  ok: true,
  feedbackStatus: "accepted",
  chosenOption: "option_2",
  decisionSource: "judge",
  decisionReason: "更简洁且回答了排班问题",
  judgeModel: "mcp-sampling",
  feedbackExpected: true,
});

const missingSelection = spawnSync("node", [path.join(dir, "validate-browser-selection.mjs")], {
  input: JSON.stringify({
    defaultInstanceId: null,
    instances: [{ id: "boss-a" }, { id: "boss-b" }],
  }),
  encoding: "utf8",
  env: { ...process.env, ROLL_BROWSER_INSTANCE: "boss-x" },
});
assert.equal(missingSelection.status, 1);
assert.match(missingSelection.stderr, /not declared/);

const failedStatusShape = runHelper(
  "validate-browser-selection.mjs",
  JSON.stringify({ ok: false, error: "browserInstance is unknown" }),
);
assert.equal(failedStatusShape.status, 1);
assert.match(failedStatusShape.stderr, /instances array/);

const openChatDir = mkdtempSync(path.join(tmpdir(), "roll-open-chat-test-"));
try {
  const initialPath = path.join(openChatDir, "initial.out");
  const reloadPath = path.join(openChatDir, "reload.out");
  const retryPath = path.join(openChatDir, "retry.out");
  writeFileSync(initialPath, 'roll log\n{"success":false,"error":"右侧会话未同步"}', "utf8");
  writeFileSync(reloadPath, '{"success":true,"usedReload":true}', "utf8");
  writeFileSync(
    retryPath,
    '{"success":false,"error":{"message":"消息列表未加载，请稍后重试"}}',
    "utf8",
  );
  const openChatFailure = spawnSync(
    "node",
    [
      path.join(dir, "format-open-chat-failure.mjs"),
      "ts-open",
      "候选人 A",
      "cid-open",
      initialPath,
      reloadPath,
      retryPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(openChatFailure.status, 0, openChatFailure.stderr);
  assert.deepEqual(JSON.parse(openChatFailure.stdout), {
    ts: "ts-open",
    name: "候选人 A",
    conversationId: "cid-open",
    ok: false,
    stage: "open_chat",
    recoveryAttempted: true,
    recoveryAction: "zhipin_open_chat_page(forceReload=true)",
    initialError: "右侧会话未同步",
    retryError: "消息列表未加载，请稍后重试",
  });

  writeFileSync(initialPath, '{"ok":true}', "utf8");
  writeFileSync(retryPath, '{"success":true}', "utf8");
  const validationRejectedSuccess = spawnSync(
    "node",
    [
      path.join(dir, "format-open-chat-failure.mjs"),
      "ts-validation",
      "候选人 B",
      "cid-validation",
      initialPath,
      reloadPath,
      retryPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(validationRejectedSuccess.status, 0, validationRejectedSuccess.stderr);
  const validationRejectedRow = JSON.parse(validationRejectedSuccess.stdout);
  assert.equal(
    validationRejectedRow.initialError,
    "zhipin_open_chat output was rejected by validate-open-chat",
  );
  assert.equal(
    validationRejectedRow.retryError,
    "zhipin_open_chat output was rejected by validate-open-chat",
  );
} finally {
  rmSync(openChatDir, { recursive: true, force: true });
}

const recoveryContracts = [
  {
    script: "reply-unread-safely.sh",
    conversationAnchor: 'expectedConversationId\\":\\"$cid',
    invalidateCall: "invalidate_unread_filter_after_reload",
    ensureCall: "ensure_unread_list_ready",
    retryCall: 'open_out=$(roll_json_file zhipin_open_chat "$WORK_DIR/c.json")',
    ensureBeforeRead: "ensure_unread_list_ready\n    local next\n    next=$(fetch_next_unread)",
    backToList: "back_to_list() {\n  ensure_unread_list_ready\n}",
    steadyStateGuard:
      "ensure_unread_list_ready() {\n  # Preserve the steady-state page-drift guard even when the unread filter is already active.\n  ensure_chat_list",
    rawOutputWriter: 'write_text "$initial_open_path" "$open_out"',
  },
  {
    script: "reply-unread-safely.ps1",
    conversationAnchor: "expectedConversationId = $Cid",
    invalidateCall: "Invalidate-UnreadFilterAfterReload",
    ensureCall: "Ensure-UnreadListReady",
    retryCall: '$openOut = Invoke-RollJsonFile "zhipin_open_chat" $cFile',
    ensureBeforeRead: "Ensure-UnreadListReady\n    $next = Get-NextUnread",
    backToList: "function Back-ToList {\n  Ensure-UnreadListReady\n}",
    steadyStateGuard:
      "function Ensure-UnreadListReady {\n  # Preserve the steady-state page-drift guard even when the unread filter is already active.\n  Ensure-ChatList",
    rawOutputWriter: "Write-TextFile $initialOpenPath $openOut",
  },
];

for (const contract of recoveryContracts) {
  const source = readFileSync(path.join(dir, contract.script), "utf8");
  const reloadIndex = source.indexOf("forceReload");
  const invalidateIndex = source.indexOf(contract.invalidateCall, reloadIndex);
  const retryIndex = source.indexOf(contract.retryCall, invalidateIndex);

  assert.ok(reloadIndex >= 0, `${contract.script}: missing force reload input`);
  assert.ok(
    source.includes(contract.conversationAnchor),
    `${contract.script}: force reload is not anchored to the current conversation`,
  );
  assert.ok(invalidateIndex > reloadIndex, `${contract.script}: unread state is not invalidated`);
  assert.ok(retryIndex > invalidateIndex, `${contract.script}: invalidation must precede retry`);
  assert.ok(
    !source.slice(invalidateIndex, retryIndex).includes(contract.ensureCall),
    `${contract.script}: current candidate retry must happen before unread filter restoration`,
  );
  assert.ok(
    source.includes(contract.ensureBeforeRead),
    `${contract.script}: unread filter is not restored before the next read`,
  );
  assert.ok(
    source.includes(contract.backToList),
    `${contract.script}: back-to-list does not restore unread state`,
  );
  assert.ok(
    source.includes(contract.steadyStateGuard),
    `${contract.script}: steady-state page-drift guard is missing`,
  );
  assert.ok(
    source.includes(contract.rawOutputWriter),
    `${contract.script}: raw roll output is not written as text`,
  );
  assert.match(source, /format-open-chat-failure\.mjs/);
}

console.log("roll-helpers.test.mjs: ok");
