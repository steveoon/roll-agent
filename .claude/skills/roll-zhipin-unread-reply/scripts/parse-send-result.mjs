#!/usr/bin/env node
/** stdin: zhipin_send_prepared_reply roll stdout. stdout: normalized send + decision metadata. */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const FEEDBACK_STATUSES = new Set(["accepted", "duplicate", "queued", "skipped", "failed"]);
const OPTION_IDS = new Set(["option_1", "option_2"]);
const DECISION_SOURCES = new Set([
  "judge",
  "orchestrator",
  "service_recommended_fallback",
  "explicit_no_judge",
]);

const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
if (!jsonText) {
  process.stdout.write(JSON.stringify({ ok: false }));
  process.exit(1);
}
let send;
try {
  send = JSON.parse(jsonText);
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
  process.exit(1);
}
const result = {
  ok: send.success === true,
};
if (send.feedbackStatus !== undefined) {
  if (typeof send.feedbackStatus !== "string" || !FEEDBACK_STATUSES.has(send.feedbackStatus)) {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_feedback_status" }));
    process.exit(2);
  }
  result.feedbackStatus = send.feedbackStatus;
}
if (typeof send.feedbackError === "string") {
  result.feedbackError = send.feedbackError;
}
if (send.chosenOption !== undefined) {
  if (typeof send.chosenOption !== "string" || !OPTION_IDS.has(send.chosenOption)) {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_chosen_option" }));
    process.exit(2);
  }
  result.chosenOption = send.chosenOption;
}
if (send.decisionSource !== undefined) {
  if (typeof send.decisionSource !== "string" || !DECISION_SOURCES.has(send.decisionSource)) {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_decision_source" }));
    process.exit(2);
  }
  result.decisionSource = send.decisionSource;
}
if (send.decisionReason !== undefined) {
  if (typeof send.decisionReason !== "string") {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_decision_reason" }));
    process.exit(2);
  }
  result.decisionReason = send.decisionReason;
}
if (send.judgeModel !== undefined) {
  if (typeof send.judgeModel !== "string") {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_judge_model" }));
    process.exit(2);
  }
  result.judgeModel = send.judgeModel;
}
if (send.feedbackExpected !== undefined) {
  if (typeof send.feedbackExpected !== "boolean") {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_feedback_expected" }));
    process.exit(2);
  }
  result.feedbackExpected = send.feedbackExpected;
}
process.stdout.write(JSON.stringify(result));
