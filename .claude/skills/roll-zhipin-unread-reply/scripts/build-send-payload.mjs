#!/usr/bin/env node
/**
 * argv[2]: preparedReplyId
 * argv[3]: hasDualDraft ("1" | "0")
 * argv[4]: noJudge ("1" | "0")
 * stdin: zhipin_judge_prepared_reply roll stdout (when dual draft + judge enabled)
 * stdout: { sendInput, meta }
 */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const preparedReplyId = process.argv[2] ?? "";
const hasDualDraft = process.argv[3] === "1";
const noJudge = process.argv[4] === "1";

if (preparedReplyId.length === 0) {
  process.exit(1);
}

const sendInput = { preparedReplyId };
const meta = {
  hasDualDraft,
  judgeAttempted: false,
  judgeSkipped: false,
  judgeFallback: false,
  chosenOption: undefined,
  recommendedOption: undefined,
  judgeError: undefined,
};

if (hasDualDraft && noJudge) {
  meta.judgeSkipped = true;
  process.stdout.write(JSON.stringify({ sendInput, meta }));
  process.exit(0);
}

if (!hasDualDraft) {
  process.stdout.write(JSON.stringify({ sendInput, meta }));
  process.exit(0);
}

meta.judgeAttempted = true;
const judgeText = await readStdinUtf8();
const judgeJsonText = extractLastJson(judgeText);
if (!judgeJsonText) {
  meta.judgeError = "judge_output_missing";
  process.stdout.write(JSON.stringify({ sendInput, meta }));
  process.exit(0);
}

let judge;
try {
  judge = JSON.parse(judgeJsonText);
} catch {
  meta.judgeError = "judge_output_invalid";
  process.stdout.write(JSON.stringify({ sendInput, meta }));
  process.exit(0);
}

if (judge.variantDecision !== undefined) {
  sendInput.variantDecision = judge.variantDecision;
  meta.chosenOption = judge.variantDecision.chosenOption;
} else if (judge.fallback === true) {
  meta.judgeFallback = true;
  meta.recommendedOption = judge.recommendedOption;
  if (typeof judge.error === "string" && judge.error.length > 0) {
    meta.judgeError = judge.error;
  }
} else if (judge.success === false) {
  meta.judgeError = typeof judge.error === "string" ? judge.error : "judge_failed";
  process.exit(4);
} else if (judge.success === true) {
  meta.judgeError = "judge_missing_variant_decision";
} else {
  meta.judgeError = "judge_unexpected_response";
}

process.stdout.write(JSON.stringify({ sendInput, meta }));
