#!/usr/bin/env node
/** stdin: zhipin_capture_resume roll stdout. stdout: {imagePath, canvasSize}; exit 1 when missing. */
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
if (!j?.imagePath) {
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({ imagePath: j.imagePath, canvasSize: j.canvasSize ?? null }),
);
