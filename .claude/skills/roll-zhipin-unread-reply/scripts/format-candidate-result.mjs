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

const base = {
  ts,
  name,
  conversationId,
  preparedReplyId,
  hasDualDraft: meta.hasDualDraft === true,
  judgeAttempted: meta.judgeAttempted === true,
  judgeSkipped: meta.judgeSkipped === true,
  judgeFallback: meta.judgeFallback === true,
  chosenOption: meta.chosenOption,
  recommendedOption: meta.recommendedOption,
  judgeError: meta.judgeError,
  feedbackStatus: send.feedbackStatus,
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
