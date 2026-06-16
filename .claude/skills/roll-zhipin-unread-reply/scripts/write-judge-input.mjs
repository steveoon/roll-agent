#!/usr/bin/env node
/** argv[2]: output path. argv[3]: preparedReplyId */
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] ?? "";
const preparedReplyId = process.argv[3] ?? "";
if (outPath.length === 0 || preparedReplyId.length === 0) {
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify({ preparedReplyId }), "utf8");
