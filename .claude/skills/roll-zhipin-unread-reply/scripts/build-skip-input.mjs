#!/usr/bin/env node
/**
 * Build skip-rules input JSON from files (avoids shell quoting issues).
 * Usage: node build-skip-input.mjs <info-raw.json> <preview.txt> <pageUrl> <pageTitle> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [infoPath, previewPath, pageUrl, pageTitle, outPath] = process.argv.slice(2);
if (!infoPath || !previewPath || !outPath) {
  console.error(
    "usage: node build-skip-input.mjs <info-raw.json> <preview.txt> <pageUrl> <pageTitle> <out.json>",
  );
  process.exit(1);
}

let info = {};
try {
  info = JSON.parse(readFileSync(infoPath, "utf8"));
} catch {
  info = {};
}

const preview = readFileSync(previewPath, "utf8");
const payload = {
  preview,
  candidateInfo: info.candidateInfo ?? {},
  preferredBrand: info.preferredBrand ?? "",
  chatMessages: info.chatMessages ?? [],
  pageUrl: pageUrl ?? "",
  pageTitle: pageTitle ?? "",
};

writeFileSync(outPath, JSON.stringify(payload), "utf8");
