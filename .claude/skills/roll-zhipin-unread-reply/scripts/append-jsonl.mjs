#!/usr/bin/env node
/**
 * Append one JSON object as a line to a JSONL file.
 * Usage:
 *   node append-jsonl.mjs <file.jsonl> '<json>'
 *   echo '<json>' | node append-jsonl.mjs <file.jsonl>
 */
import { appendFileSync, readFileSync } from "node:fs";

const file = process.argv[2];
let line = process.argv[3];
if (!file) {
  console.error("usage: node append-jsonl.mjs <file.jsonl> ['<json>']");
  process.exit(1);
}
if (!line) {
  line = readFileSync(0, "utf8").trim();
}
if (!line) {
  console.error("missing json line");
  process.exit(1);
}
JSON.parse(line);
appendFileSync(file, `${line}\n`, "utf8");
