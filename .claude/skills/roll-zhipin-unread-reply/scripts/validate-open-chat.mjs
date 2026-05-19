#!/usr/bin/env node
/** argv[2]: expected conversationId. stdin: zhipin_open_chat roll stdout. */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const expectedCid = process.argv[2] ?? "";
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
if (j.success !== true) {
  process.exit(1);
}
if (j.conversationId && expectedCid && j.conversationId !== expectedCid) {
  process.exit(2);
}
process.exit(0);
