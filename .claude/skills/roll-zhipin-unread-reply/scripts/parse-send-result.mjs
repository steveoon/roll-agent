#!/usr/bin/env node
/** stdin: zhipin_send_prepared_reply roll stdout. stdout: { ok, feedbackStatus?, feedbackError? }. */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

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
if (typeof send.feedbackStatus === "string") {
  result.feedbackStatus = send.feedbackStatus;
}
if (typeof send.feedbackError === "string") {
  result.feedbackError = send.feedbackError;
}
process.stdout.write(JSON.stringify(result));
