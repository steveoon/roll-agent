#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { extractLastJson } from "./roll-json-extract.mjs";

const MAX_FALLBACK_LENGTH = 2000;

function parseLastJson(text) {
  const jsonText = extractLastJson(text);
  if (!jsonText) {
    return null;
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function compactFallback(text, label) {
  const compact = text.trim().replace(/\s+/g, " ");
  if (!compact) {
    return `${label} returned no output`;
  }
  return compact.slice(0, MAX_FALLBACK_LENGTH);
}

function findErrorMessage(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    const nested = parseLastJson(value);
    if (nested !== null) {
      return findErrorMessage(nested, depth + 1);
    }
    return value.trim();
  }
  if (typeof value !== "object") {
    return "";
  }

  for (const key of ["error", "message", "reason", "details", "text"]) {
    const message = findErrorMessage(value[key], depth + 1);
    if (message) {
      return message;
    }
  }
  for (const key of ["result", "data", "structuredContent", "content"]) {
    const message = findErrorMessage(value[key], depth + 1);
    if (message) {
      return message;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = findErrorMessage(item, depth + 1);
      if (message) {
        return message;
      }
    }
  }
  return "";
}

function summarizeFailure(text, label, expectedConversationId = "") {
  const payload = parseLastJson(text);
  if (payload === null) {
    return compactFallback(text, label);
  }

  const succeeded = payload.success === true || payload.ok === true;
  if (
    succeeded &&
    expectedConversationId &&
    payload.conversationId &&
    payload.conversationId !== expectedConversationId
  ) {
    return `conversationId mismatch: expected ${expectedConversationId}, got ${payload.conversationId}`;
  }
  if (succeeded) {
    return "";
  }

  return findErrorMessage(payload) || `${label} returned a failure response`;
}

function summarizeRejectedOpenChat(text, expectedConversationId) {
  return (
    summarizeFailure(text, "zhipin_open_chat", expectedConversationId) ||
    "zhipin_open_chat output was rejected by validate-open-chat"
  );
}

const [ts, name, conversationId, initialPath, reloadPath, retryPath] = process.argv.slice(2);
if (!ts || !initialPath || !reloadPath || !retryPath) {
  console.error(
    "usage: format-open-chat-failure.mjs <ts> <name> <conversationId> <initialPath> <reloadPath> <retryPath>",
  );
  process.exit(1);
}

const initialOutput = readFileSync(initialPath, "utf8");
const reloadOutput = readFileSync(reloadPath, "utf8");
const retryOutput = readFileSync(retryPath, "utf8");
const reloadError = summarizeFailure(reloadOutput, "zhipin_open_chat_page(forceReload=true)");

const row = {
  ts,
  name: name ?? "",
  conversationId: conversationId ?? "",
  ok: false,
  stage: "open_chat",
  recoveryAttempted: true,
  recoveryAction: "zhipin_open_chat_page(forceReload=true)",
  initialError: summarizeRejectedOpenChat(initialOutput, conversationId),
  retryError: summarizeRejectedOpenChat(retryOutput, conversationId),
};
if (reloadError) {
  row.reloadError = reloadError;
}

process.stdout.write(JSON.stringify(row));
