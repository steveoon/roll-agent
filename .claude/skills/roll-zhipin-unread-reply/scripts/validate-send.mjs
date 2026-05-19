#!/usr/bin/env node
/** stdin: send_prepared_reply roll stdout. exit 0 when success===true. */
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
process.exit(j.success === true ? 0 : 1);
