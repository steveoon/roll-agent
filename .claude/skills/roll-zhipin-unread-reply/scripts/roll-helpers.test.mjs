import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    sendInput: { preparedReplyId: "prep_3", variantDecision: { chosenOption: "option_1", reason: "ok" } },
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
        judgeAttempted: true,
        chosenOption: "option_2",
      },
    },
    send: { ok: true, feedbackStatus: "accepted" },
  }),
  ["sent", "ts1", "Alice", "cid1", "prep_4", "1"],
);
assert.equal(formatSent.status, 0);
const sentLine = JSON.parse(formatSent.stdout);
assert.equal(sentLine.ok, true);
assert.equal(sentLine.chosenOption, "option_2");
assert.equal(sentLine.feedbackStatus, "accepted");
assert.equal(sentLine.exchangedWechat, true);

const sendPayload = runHelper(
  "build-send-payload.mjs",
  JSON.stringify({
    success: true,
    variantDecision: {
      chosenOption: "option_2",
      reason: "更简洁且回答了排班问题",
      confirmedFindingCodes: [],
    },
  }),
  ["prep_1", "1", "0"],
);
assert.equal(sendPayload.status, 0);
const bundle = JSON.parse(sendPayload.stdout);
assert.deepEqual(bundle.sendInput, {
  preparedReplyId: "prep_1",
  variantDecision: {
    chosenOption: "option_2",
    reason: "更简洁且回答了排班问题",
    confirmedFindingCodes: [],
  },
});
assert.equal(bundle.meta.chosenOption, "option_2");

const sendPayloadNoJudge = runHelper("build-send-payload.mjs", "", ["prep_2", "1", "1"]);
assert.equal(sendPayloadNoJudge.status, 0);
assert.deepEqual(JSON.parse(sendPayloadNoJudge.stdout).sendInput, { preparedReplyId: "prep_2" });
assert.equal(JSON.parse(sendPayloadNoJudge.stdout).meta.judgeSkipped, true);

const sendResult = runHelper(
  "parse-send-result.mjs",
  JSON.stringify({ success: true, feedbackStatus: "accepted" }),
);
assert.equal(sendResult.status, 0);
assert.deepEqual(JSON.parse(sendResult.stdout), { ok: true, feedbackStatus: "accepted" });

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

console.log("roll-helpers.test.mjs: ok");
