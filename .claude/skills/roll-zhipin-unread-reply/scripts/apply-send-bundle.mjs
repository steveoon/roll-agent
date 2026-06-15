#!/usr/bin/env node
/** stdin: { sendInput, meta } bundle JSON. argv[2]: output path for sp.json */
import { writeFileSync } from "node:fs";
import { readStdinUtf8 } from "./roll-json-extract.mjs";

const outPath = process.argv[2] ?? "";
if (outPath.length === 0) {
  process.exit(1);
}

const text = await readStdinUtf8();
let bundle;
try {
  bundle = JSON.parse(text);
} catch {
  process.exit(2);
}

const preparedReplyId = bundle?.sendInput?.preparedReplyId;
if (typeof preparedReplyId !== "string" || preparedReplyId.length === 0) {
  process.exit(3);
}

writeFileSync(outPath, JSON.stringify(bundle.sendInput), "utf8");
