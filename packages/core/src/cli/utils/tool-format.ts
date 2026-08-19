import { redactToolArgsForLog } from "./output.ts";

const MAX_APPROVAL_EXPLANATION_CHARS = 100;

export function formatToolInput(input: unknown): string {
  const json = JSON.stringify(redactToolArgsForLog(input)) ?? "";
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

function isDisplaySafeCodePoint(code: number): boolean {
  if (code === 0x09 || code === 0x0a) {
    return true;
  }
  if (code <= 0x08 || (code >= 0x0b && code <= 0x1f)) {
    return false;
  }
  return code < 0x7f || code > 0x9f;
}

export function sanitizeForDisplay(value: string): string {
  let out = "";
  for (const ch of value) {
    if (isDisplaySafeCodePoint(ch.codePointAt(0) ?? 0)) {
      out += ch;
    }
  }
  return out;
}

export function formatApprovalExplanation(value: string): string | undefined {
  const normalized = sanitizeForDisplay(value).replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return Array.from(normalized).slice(0, MAX_APPROVAL_EXPLANATION_CHARS).join("");
}

export function formatApprovalDetails(input: unknown): string {
  const redacted = redactToolArgsForLog(input);
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) {
    return sanitizeForDisplay(JSON.stringify(redacted) ?? "");
  }
  const entries = Object.entries(redacted as Record<string, unknown>);
  return entries
    .map(([key, value]) => {
      const rendered = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}: ${sanitizeForDisplay(rendered)}`;
    })
    .join("\n");
}
