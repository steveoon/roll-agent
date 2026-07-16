#!/usr/bin/env node
/**
 * argv[2]: mode ("sent" | "send_failed")
 * argv[3]: ts
 * argv[4]: name
 * argv[5]: conversationId
 * argv[6]: preparedReplyId
 * argv[7]: exchangedWechat ("0" | "1", sent mode only)
 * stdin: JSON { bundle, send }
 */
import { readStdinUtf8 } from "./roll-json-extract.mjs";

const mode = process.argv[2] ?? "";
const ts = process.argv[3] ?? "";
const name = process.argv[4] ?? "";
const conversationId = process.argv[5] ?? "";
const preparedReplyId = process.argv[6] ?? "";
const exchangedWechat = process.argv[7] === "1";

if (mode !== "sent" && mode !== "send_failed") {
  process.exit(1);
}

const text = await readStdinUtf8();
let input;
try {
  input = JSON.parse(text);
} catch {
  process.exit(2);
}

const bundle = input.bundle ?? {};
const send = input.send ?? {};
const meta = bundle.meta ?? {};
const hasDualDraft = meta.hasDualDraft === true;
const chosenOption = typeof send.chosenOption === "string" ? send.chosenOption : meta.chosenOption;
const decisionSource =
  typeof send.decisionSource === "string" ? send.decisionSource : meta.decisionSource;
const decisionReason =
  typeof send.decisionReason === "string" ? send.decisionReason : meta.decisionReason;
const judgeModel = typeof send.judgeModel === "string" ? send.judgeModel : meta.judgeModel;
const feedbackExpected =
  typeof send.feedbackExpected === "boolean"
    ? send.feedbackExpected
    : meta.feedbackExpected === true;
const judgeAttempted =
  decisionSource === "judge" ||
  decisionSource === "service_recommended_fallback" ||
  meta.judgeAttempted === true;
const judgeSkipped = decisionSource === "explicit_no_judge" || meta.judgeSkipped === true;
const judgeFallback =
  decisionSource === "service_recommended_fallback" || meta.judgeFallback === true;
const recommendedOption = judgeFallback || judgeSkipped ? chosenOption : meta.recommendedOption;
const fallbackReason =
  judgeFallback || judgeSkipped ? (decisionReason ?? meta.fallbackReason) : meta.fallbackReason;
const feedbackStatus =
  typeof send.feedbackStatus === "string" ? send.feedbackStatus : hasDualDraft ? "missing" : null;
const feedbackClosed = feedbackStatus === "accepted" || feedbackStatus === "duplicate";
const feedbackQueued = feedbackStatus === "queued";
const feedbackGap = mode === "sent" && hasDualDraft && !feedbackClosed && !feedbackQueued;
const learningSkipped = mode === "sent" && hasDualDraft && !feedbackExpected;

const base = {
  ts,
  name,
  conversationId,
  preparedReplyId,
  hasDualDraft,
  judgeAttempted,
  judgeSkipped,
  judgeFallback,
  chosenOption,
  recommendedOption,
  judgeError: meta.judgeError,
  decisionSource,
  decisionReason,
  judgeModel,
  fallbackReason,
  feedbackExpected,
  feedbackStatus,
  feedbackClosed,
  feedbackQueued,
  feedbackGap,
  learningSkipped,
};

if (mode === "sent") {
  process.stdout.write(
    JSON.stringify({
      ...base,
      ok: true,
      exchangedWechat,
      feedbackError: send.feedbackError,
    }),
  );
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    ...base,
    ok: false,
    stage: "send",
  }),
);
