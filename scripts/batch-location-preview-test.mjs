#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractLastJson } from "../.claude/skills/roll-zhipin-unread-reply/scripts/roll-json-extract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = Number(process.env.TARGET ?? "10");
const BROWSER_INSTANCE = process.env.BROWSER_INSTANCE ?? "boss-a";
const ALLOW_REAL_ZHIPIN_BATCH = process.env.ALLOW_REAL_ZHIPIN_BATCH === "1";
const INCLUDE_RAW = process.env.INCLUDE_RAW === "1";

const STRONG_LOCATION =
  /(?:是在|附近|周边|旁边|地址|位置|在哪里|在哪|哪里|地铁|号线|门店|工作地址|[\p{Script=Han}]{2,12}(?:区|县|镇|乡|街道|路|坊|广场|商场|店|庄|沟(?!通))|浦东|阳坊|曹路|门头沟|就近安排吗|就近吗)/u;
const WEAK_LOCATION = /(?:还招人|还招|招人吗|有吗|招吗|岗位|职位|门店)/u;
const RECRUITER_PREVIEW =
  /(?:我们确实还在招|可以加微信发详细|发详细资料|排班制|你是想了解全职还是兼职)/u;

if (!ALLOW_REAL_ZHIPIN_BATCH) {
  console.error(
    "This script reads real BOSS Zhipin conversations. " +
      "Set ALLOW_REAL_ZHIPIN_BATCH=1 to run it.",
  );
  process.exit(1);
}

function redactIdentifier(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function buildReportRow(input) {
  const redacted = {
    candidateKey: redactIdentifier(`${input.conversationId}:${input.name}`),
    elapsedMs: input.elapsedMs,
    success: input.success,
    stage: input.stage ?? "",
    confidence: input.confidence ?? null,
    locationSignals: input.locationSignals ?? [],
    error: input.error ?? "",
  };

  if (!INCLUDE_RAW) {
    return redacted;
  }

  return {
    ...redacted,
    name: input.name,
    conversationId: input.conversationId,
    preview: input.preview,
    suggestedReply: input.suggestedReply ?? "",
  };
}

function runRoll(tool, input) {
  const out = execFileSync(
    "pnpm",
    [
      "dev",
      "--",
      "run",
      "browser-use-agent",
      tool,
      "--input-json",
      JSON.stringify({ browserInstance: BROWSER_INSTANCE, ...input }),
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  const jsonText = extractLastJson(out);
  if (jsonText === null) {
    throw new Error(`No JSON in roll output for ${tool}`);
  }
  return JSON.parse(jsonText);
}

function scoreCandidate(row) {
  const preview = String(row.preview ?? row.messagePreview ?? "");
  if (RECRUITER_PREVIEW.test(preview)) return -1;
  if (STRONG_LOCATION.test(preview)) return 3;
  if (WEAK_LOCATION.test(preview)) return 1;
  return 0;
}

function pickCandidates(rows) {
  return rows
    .filter((row) => row.conversationId && row.name)
    .map((row) => ({ row, score: scoreCandidate(row) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (b.row.hasUnread ? 1 : 0) - (a.row.hasUnread ? 1 : 0))
    .slice(0, TARGET)
    .map((item) => item.row);
}

const messagesPayload = runRoll("zhipin_read_messages", {
  limit: 80,
  onlyUnread: false,
  maxScrolls: 10,
});
const rows = Array.isArray(messagesPayload.candidates) ? messagesPayload.candidates : [];
const picked = pickCandidates(rows);

if (picked.length === 0) {
  console.error("No location-related candidates found.");
  process.exit(1);
}

console.error(`Picked ${String(picked.length)} candidates for location preview test.`);

const results = [];
for (const [index, row] of picked.entries()) {
  const { name, conversationId, preview } = row;
  console.error(`[${String(index + 1)}/${String(picked.length)}] ${name} | ${preview}`);
  const startedAt = Date.now();
  try {
    const previewResult = runRoll("zhipin_generate_reply_preview", {
      conversationId,
      candidateName: name,
      maxMessages: 50,
    });
    let locationSignals = [];
    try {
      const info = runRoll("zhipin_get_candidate_info", {
        conversationId,
        candidateName: name,
        maxMessages: 30,
      });
      locationSignals = Array.isArray(info.locationSignals) ? info.locationSignals : [];
    } catch {
      locationSignals = [];
    }
    results.push(
      buildReportRow({
        name,
        conversationId,
        preview,
        elapsedMs: Date.now() - startedAt,
        success: previewResult.success === true,
        suggestedReply: previewResult.suggestedReply ?? "",
        stage: previewResult.stage ?? "",
        confidence: previewResult.confidence ?? null,
        locationSignals,
        error: previewResult.error ?? "",
      }),
    );
  } catch (error) {
    results.push(
      buildReportRow({
        name,
        conversationId,
        preview,
        elapsedMs: Date.now() - startedAt,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

const reportPath = join(ROOT, ".tmp-location-preview-report.json");
writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, count: results.length, results }, null, 2));
