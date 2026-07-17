#!/usr/bin/env node
/**
 * stdin: zhipin_generate_reply_preview roll stdout.
 * stdout: success metadata or an allowlisted, redacted failure diagnostic.
 */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const ERROR_KINDS = new Set(["rejected", "timeout", "server_error"]);

function optionalString(value, maxLength) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

function optionalNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeError(value) {
  const message = optionalString(value, 4000);
  if (message === undefined) {
    return undefined;
  }
  return message
    .replace(/\s+\(url=.*\)$/, "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .slice(0, 2000);
}

function sanitizePhaseLatencies(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .slice(0, 32)
    .flatMap(([phase, latencyMs]) => {
      const safePhase = optionalString(phase, 100);
      const safeLatencyMs = optionalNonNegativeInteger(latencyMs);
      return safePhase !== undefined && safeLatencyMs !== undefined
        ? [[safePhase, safeLatencyMs]]
        : [];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
if (!jsonText) {
  process.exit(1);
}
let preview;
try {
  preview = JSON.parse(jsonText);
} catch {
  process.exit(1);
}
if (preview.success === false) {
  const errorKind = ERROR_KINDS.has(preview.errorKind) ? preview.errorKind : undefined;
  const error =
    sanitizeError(preview.error) ?? "zhipin_generate_reply_preview returned a failure response";
  const requestId = optionalString(preview.requestId, 200);
  const elapsedMs = optionalNonNegativeInteger(preview.elapsedMs);
  const clientTimeoutMs = optionalNonNegativeInteger(preview.clientTimeoutMs);
  const lastStartedPhase = optionalString(preview.lastStartedPhase, 100);
  const activePhase = optionalString(preview.activePhase, 100);
  const phaseLatencies = sanitizePhaseLatencies(preview.phaseLatencies);

  process.stdout.write(
    JSON.stringify({
      ok: false,
      error,
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(clientTimeoutMs !== undefined ? { clientTimeoutMs } : {}),
      ...(lastStartedPhase !== undefined ? { lastStartedPhase } : {}),
      ...(activePhase !== undefined ? { activePhase } : {}),
      ...(phaseLatencies !== undefined ? { phaseLatencies } : {}),
    }),
  );
  process.exit(0);
}
if (!preview.preparedReplyId) {
  process.exit(3);
}
const hasDualDraft = (preview.replyVariantSelection?.options?.length ?? 0) >= 2;
process.stdout.write(
  JSON.stringify({
    preparedReplyId: String(preview.preparedReplyId),
    hasDualDraft,
  }),
);
