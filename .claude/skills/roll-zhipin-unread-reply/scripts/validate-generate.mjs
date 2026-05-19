#!/usr/bin/env node
/** stdin: generate_reply_preview roll stdout. stdout: preparedReplyId; exit 2/3 on failure. */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
if (!jsonText) {
  process.exit(1);
}
let j;
try {
  j = JSON.parse(jsonText);
} catch {
  process.exit(1);
}
if (j.success === false) {
  process.exit(2);
}
if (!j.preparedReplyId) {
  process.exit(3);
}
process.stdout.write(String(j.preparedReplyId));
