#!/usr/bin/env node
/** stdin: zhipin_generate_reply_preview roll stdout. stdout: { preparedReplyId, hasDualDraft }. */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
if (!jsonText) {
  process.exit(1);
}
let preview;
try {
  preview = JSON.parse(jsonText);
} catch {
  process.exit(1);
}
if (preview.success === false) {
  process.exit(2);
}
if (!preview.preparedReplyId) {
  process.exit(3);
}
const hasDualDraft = (preview.replyVariantSelection?.options?.length ?? 0) >= 2;
process.stdout.write(
  JSON.stringify({
    preparedReplyId: String(preview.preparedReplyId),
    hasDualDraft,
  }),
);
