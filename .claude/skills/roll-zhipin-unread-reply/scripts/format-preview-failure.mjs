#!/usr/bin/env node
/** Build one safe JSONL row from parse-generate-preview.mjs failure metadata. */
import { readStdinUtf8 } from "./roll-json-extract.mjs";

const [ts, name = "", conversationId = ""] = process.argv.slice(2);
if (!ts) {
  console.error("usage: format-preview-failure.mjs <ts> <name> <conversationId>");
  process.exit(1);
}

let metadata;
try {
  metadata = JSON.parse(await readStdinUtf8());
} catch {
  process.exit(1);
}

if (metadata === null || typeof metadata !== "object" || metadata.ok !== false) {
  process.exit(1);
}

const row = {
  ts,
  name,
  conversationId,
  ok: false,
  stage: "preview",
};

for (const key of [
  "error",
  "errorKind",
  "requestId",
  "elapsedMs",
  "clientTimeoutMs",
  "lastStartedPhase",
  "activePhase",
  "phaseLatencies",
]) {
  if (metadata[key] !== undefined) {
    row[key] = metadata[key];
  }
}

process.stdout.write(JSON.stringify(row));
