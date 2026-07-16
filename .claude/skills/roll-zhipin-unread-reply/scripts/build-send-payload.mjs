#!/usr/bin/env node
/**
 * argv[2]: preparedReplyId
 * argv[3]: hasDualDraft ("1" | "0")
 * argv[4]: noJudge ("1" | "0")
 * stdout: { sendInput, meta }
 */
const preparedReplyId = process.argv[2] ?? "";
const hasDualDraft = process.argv[3] === "1";
const noJudge = process.argv[4] === "1";

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

if (preparedReplyId.length === 0) {
  fail(1, "prepared_reply_id_missing");
}

const sendInput = { preparedReplyId };
const meta = {
  hasDualDraft,
  judgeAttempted: false,
  judgeSkipped: false,
  judgeFallback: false,
  chosenOption: null,
  recommendedOption: null,
  judgeError: null,
  decisionSource: null,
  decisionReason: null,
  judgeModel: null,
  fallbackReason: null,
  feedbackExpected: hasDualDraft && !noJudge,
};

if (hasDualDraft && noJudge) {
  sendInput.skipVariantJudge = true;
  meta.judgeSkipped = true;
  meta.decisionSource = "explicit_no_judge";
  meta.fallbackReason = "operator_requested_no_judge";
  process.stdout.write(JSON.stringify({ sendInput, meta }));
  process.exit(0);
}

if (!hasDualDraft) {
  process.stdout.write(JSON.stringify({ sendInput, meta }));
  process.exit(0);
}

// The send tool owns the default dual-draft Judge. Omitting both decision fields is intentional.
process.stdout.write(JSON.stringify({ sendInput, meta }));
