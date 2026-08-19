#!/usr/bin/env node
/**
 * Merge a screen-run manifest (JSONL rows with stage:"screen") with agent-written
 * resume decisions, producing the act-phase plan.
 *
 * Usage: node apply-screen-decisions.mjs <manifest.jsonl> <decisions.json|jsonl> <suitable.tsv> <unsuitable.jsonl>
 *
 * decisions entries: {conversationId, fit: boolean, reason?: string}
 * suitable.tsv rows: conversationId \t name \t resumeImagePath
 * unsuitable.jsonl rows: ready-to-append skip rows (stage:"skip").
 * stdout: summary JSON {screened, suitable, unsuitable}.
 */
import { readFileSync, writeFileSync } from "node:fs";

function readRows(path) {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const [manifestPath, decisionsPath, suitableOut, unsuitableOut] = process.argv.slice(2);
if (!manifestPath || !decisionsPath || !suitableOut || !unsuitableOut) {
  console.error(
    "usage: node apply-screen-decisions.mjs <manifest.jsonl> <decisions.json|jsonl> <suitable.tsv> <unsuitable.jsonl>",
  );
  process.exit(1);
}

const manifest = readRows(manifestPath).filter(
  (r) => r?.stage === "screen" && r?.conversationId,
);
const decisions = readRows(decisionsPath);
const decByCid = new Map(
  decisions.filter((d) => d?.conversationId).map((d) => [String(d.conversationId), d]),
);

const suitable = [];
const unsuitable = [];
for (const row of manifest) {
  const cid = String(row.conversationId);
  const ts = new Date().toISOString();
  const base = { ts, name: row.name ?? "", conversationId: cid, ok: false, stage: "skip" };
  if (row.status !== "screened") {
    unsuitable.push({ ...base, reason: "resume_unavailable", detail: row.status ?? "unknown" });
    continue;
  }
  const dec = decByCid.get(cid);
  if (!dec) {
    unsuitable.push({ ...base, reason: "no_decision" });
    continue;
  }
  if (dec.fit === true) {
    suitable.push({
      conversationId: cid,
      name: row.name ?? "",
      resumeImagePath: row.resumeImagePath ?? "",
    });
  } else {
    unsuitable.push({ ...base, reason: "resume_mismatch", detail: dec.reason ?? "" });
  }
}

writeFileSync(
  suitableOut,
  suitable.map((s) => [s.conversationId, s.name, s.resumeImagePath].join("\t")).join("\n") +
    (suitable.length ? "\n" : ""),
);
writeFileSync(
  unsuitableOut,
  unsuitable.map((u) => JSON.stringify(u)).join("\n") + (unsuitable.length ? "\n" : ""),
);
process.stdout.write(
  JSON.stringify({ screened: manifest.length, suitable: suitable.length, unsuitable: unsuitable.length }),
);
