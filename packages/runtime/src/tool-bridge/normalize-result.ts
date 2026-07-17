import type { JSONValue } from "@ai-sdk/provider";
import { extractTextContent, isToolErrorResult } from "@roll-agent/core/cli/utils/tool-results";

export const TOOL_OUTCOME_KINDS = {
  success: "success",
  userRejected: "user_rejected",
  policyDenied: "policy_denied",
  invalidInput: "invalid_input",
  cancelled: "cancelled",
  toolFailed: "tool_failed",
} as const;

const MAX_TOOL_DISPLAY_CHARS = 16_000;
const MAX_TOOL_DISPLAY_ITEMS = 64;
const MAX_TOOL_MODEL_CHARS = 60_000;
const MAX_TOOL_MODEL_ITEMS = 128;
const MODEL_CLIPPED_MARKER = "\n\n[工具模型内容已截断；完整结果仍保留在 raw 视图]";

export type ToolOutcomeKind = (typeof TOOL_OUTCOME_KINDS)[keyof typeof TOOL_OUTCOME_KINDS];

export type ToolOutcome =
  | { readonly kind: typeof TOOL_OUTCOME_KINDS.success }
  | {
      readonly kind:
        | typeof TOOL_OUTCOME_KINDS.userRejected
        | typeof TOOL_OUTCOME_KINDS.policyDenied
        | typeof TOOL_OUTCOME_KINDS.invalidInput
        | typeof TOOL_OUTCOME_KINDS.cancelled
        | typeof TOOL_OUTCOME_KINDS.toolFailed;
      readonly reason?: string;
    };

export type ToolModelContentPart =
  | { type: "text"; text: string }
  | {
      type: "file";
      data: { type: "data"; data: string };
      mediaType: string;
      filename?: string;
    };

/** AI SDK compatible model-facing projection of a tool result. */
export type ToolModelOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JSONValue }
  | { type: "execution-denied"; reason?: string }
  | { type: "error-text"; value: string }
  | { type: "error-json"; value: JSONValue }
  | { type: "content"; value: ToolModelContentPart[] };

/**
 * One execution result, deliberately split for three consumers:
 * - `raw`: lossless Harness / automation value;
 * - `model`: bounded provider-facing value;
 * - `display`: concise terminal / UI value.
 *
 * `output` and `isError` are compatibility aliases for callers that have not migrated yet.
 */
export interface NormalizedToolResult {
  readonly raw: unknown;
  readonly model: ToolModelOutput;
  readonly display: unknown;
  readonly outcome: ToolOutcome;
  readonly output: unknown;
  readonly isError: boolean;
}

export interface ToolResultOptions {
  readonly raw?: unknown;
  readonly model?: ToolModelOutput;
  readonly reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isRecord(value)) {
    const out: Record<string, JSONValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = toJsonValue(item);
    }
    return out;
  }
  return value === undefined ? null : String(value);
}

function isBinaryFieldName(fieldName: string | undefined): boolean {
  if (!fieldName) {
    return false;
  }
  const tokens = fieldName
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
  return (
    (tokens.length === 1 && ["data", "image", "audio"].includes(tokens[0] ?? "")) ||
    tokens.some((token) => ["base64", "blob", "bytes"].includes(token)) ||
    (tokens.includes("data") &&
      tokens.some((token) => ["image", "audio", "binary"].includes(token)))
  );
}

function binaryPlaceholder(value: string): string {
  return `[binary content omitted: ${String(value.length)} chars]`;
}

function clipTextToBudget(value: string, budget: number, marker: string): string {
  if (value.length <= budget) {
    return value;
  }
  if (budget <= marker.length) {
    return marker.slice(0, budget);
  }
  return `${value.slice(0, budget - marker.length)}${marker}`;
}

function toModelJsonValue(value: unknown, fieldName?: string, depth = 0): JSONValue {
  if (depth > 16) {
    return "[nested value omitted]";
  }
  if (typeof value === "string") {
    if (isBinaryFieldName(fieldName) || /^data:[^,]+;base64,/iu.test(value)) {
      return binaryPlaceholder(value);
    }
    return clipTextToBudget(value, MAX_TOOL_MODEL_CHARS, MODEL_CLIPPED_MARKER);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value) || typeof value !== "number" ? value : String(value);
  }
  if (Array.isArray(value)) {
    const visible = value
      .slice(0, MAX_TOOL_MODEL_ITEMS)
      .map((item) => toModelJsonValue(item, undefined, depth + 1));
    if (value.length > MAX_TOOL_MODEL_ITEMS) {
      visible.push(`[${String(value.length - MAX_TOOL_MODEL_ITEMS)} items omitted]`);
    }
    return visible;
  }
  if (isRecord(value)) {
    const out: Record<string, JSONValue> = {};
    const entries = Object.entries(value).filter(([key]) => key !== "_meta");
    for (const [key, item] of entries.slice(0, MAX_TOOL_MODEL_ITEMS)) {
      out[key] = toModelJsonValue(item, key, depth + 1);
    }
    if (entries.length > MAX_TOOL_MODEL_ITEMS) {
      out["[omitted]"] = `${String(entries.length - MAX_TOOL_MODEL_ITEMS)} fields`;
    }
    return out;
  }
  return value === undefined ? null : String(value);
}

function toDisplayJsonValue(value: unknown, fieldName?: string, depth = 0): JSONValue {
  if (depth > 12) {
    return "[nested value omitted]";
  }
  if (typeof value === "string") {
    if (isBinaryFieldName(fieldName) || /^data:[^,]+;base64,/iu.test(value)) {
      return binaryPlaceholder(value);
    }
    return value.length <= MAX_TOOL_DISPLAY_CHARS ? value : clipDisplayText(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value) || typeof value !== "number" ? value : String(value);
  }
  if (Array.isArray(value)) {
    const visible = value
      .slice(0, MAX_TOOL_DISPLAY_ITEMS)
      .map((item) => toDisplayJsonValue(item, undefined, depth + 1));
    if (value.length > MAX_TOOL_DISPLAY_ITEMS) {
      visible.push(`[${String(value.length - MAX_TOOL_DISPLAY_ITEMS)} items omitted]`);
    }
    return visible;
  }
  if (isRecord(value)) {
    const out: Record<string, JSONValue> = {};
    const entries = Object.entries(value).filter(([key]) => key !== "_meta");
    for (const [key, item] of entries.slice(0, MAX_TOOL_DISPLAY_ITEMS)) {
      out[key] = toDisplayJsonValue(item, key, depth + 1);
    }
    if (entries.length > MAX_TOOL_DISPLAY_ITEMS) {
      out["[omitted]"] = `${String(entries.length - MAX_TOOL_DISPLAY_ITEMS)} fields`;
    }
    return out;
  }
  return value === undefined ? null : String(value);
}

function serialize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(toJsonValue(value), null, 2);
}

function clipDisplayText(value: string): string {
  if (value.length <= MAX_TOOL_DISPLAY_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_TOOL_DISPLAY_CHARS)}\n\n[工具展示内容已截断]`;
}

function boundedJsonModelOutput(value: unknown, isError = false): ToolModelOutput {
  const json = toModelJsonValue(value);
  const serialized = serialize(json);
  if (serialized.length <= MAX_TOOL_MODEL_CHARS) {
    return isError ? { type: "error-json", value: json } : { type: "json", value: json };
  }
  const clipped = clipTextToBudget(serialized, MAX_TOOL_MODEL_CHARS, MODEL_CLIPPED_MARKER);
  return isError ? { type: "error-text", value: clipped } : { type: "text", value: clipped };
}

function boundedTextModelOutput(value: string, isError = false): ToolModelOutput {
  const clipped = clipTextToBudget(value, MAX_TOOL_MODEL_CHARS, MODEL_CLIPPED_MARKER);
  return isError ? { type: "error-text", value: clipped } : { type: "text", value: clipped };
}

function boundedModelContent(parts: readonly ToolModelContentPart[]): ToolModelContentPart[] {
  const bounded: ToolModelContentPart[] = [];
  let remaining = MAX_TOOL_MODEL_CHARS;
  for (const part of parts.slice(0, MAX_TOOL_MODEL_ITEMS)) {
    if (remaining <= 0) {
      break;
    }
    if (part.type === "text") {
      const text = clipTextToBudget(part.text, remaining, MODEL_CLIPPED_MARKER);
      bounded.push({ type: "text", text });
      remaining -= text.length;
      continue;
    }
    const size = part.data.data.length;
    if (size <= remaining) {
      bounded.push(part);
      remaining -= size;
      continue;
    }
    const marker = clipTextToBudget(
      `[${part.mediaType} file omitted from model projection: ${String(size)} chars]`,
      remaining,
      MODEL_CLIPPED_MARKER,
    );
    bounded.push({ type: "text", text: marker });
    remaining -= marker.length;
  }
  if (parts.length > MAX_TOOL_MODEL_ITEMS && remaining > 0) {
    const marker = clipTextToBudget(
      `[${String(parts.length - MAX_TOOL_MODEL_ITEMS)} model content parts omitted]`,
      remaining,
      MODEL_CLIPPED_MARKER,
    );
    bounded.push({ type: "text", text: marker });
  }
  return bounded;
}

function defaultModelOutput(display: unknown, outcome: ToolOutcome): ToolModelOutput {
  if (outcome.kind === TOOL_OUTCOME_KINDS.userRejected) {
    return {
      type: "execution-denied",
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  }
  if (outcome.kind === TOOL_OUTCOME_KINDS.success) {
    return typeof display === "string"
      ? boundedTextModelOutput(display)
      : boundedJsonModelOutput(display);
  }
  return boundedJsonModelOutput(
    {
      code: outcome.kind,
      message: typeof display === "string" ? display : serialize(display),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    },
    true,
  );
}

export function createToolResult(
  outcome: ToolOutcome,
  display: unknown,
  options: ToolResultOptions = {},
): NormalizedToolResult {
  const isError = outcome.kind !== TOOL_OUTCOME_KINDS.success;
  return {
    raw: Object.prototype.hasOwnProperty.call(options, "raw") ? options.raw : display,
    model: options.model ?? defaultModelOutput(display, outcome),
    display,
    outcome,
    output: display,
    isError,
  };
}

export function successfulToolResult(
  display: unknown,
  options: Omit<ToolResultOptions, "reason"> = {},
): NormalizedToolResult {
  return createToolResult({ kind: TOOL_OUTCOME_KINDS.success }, display, options);
}

export function failedToolResult(
  kind: Exclude<ToolOutcomeKind, typeof TOOL_OUTCOME_KINDS.success>,
  display: unknown,
  options: ToolResultOptions = {},
): NormalizedToolResult {
  return createToolResult(
    {
      kind,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
    },
    display,
    options,
  );
}

function getContent(result: unknown): unknown {
  return isRecord(result) ? result.content : undefined;
}

function getStructuredContent(result: unknown): unknown {
  return isRecord(result) ? result.structuredContent : undefined;
}

function taskToolResult(result: unknown): { readonly value: unknown; readonly wrapped: boolean } {
  return isRecord(result) && "toolResult" in result
    ? { value: result.toolResult, wrapped: true }
    : { value: result, wrapped: false };
}

function dataFilePart(value: Record<string, unknown>): ToolModelContentPart | undefined {
  if (typeof value.data !== "string" || typeof value.mimeType !== "string") {
    return undefined;
  }
  return {
    type: "file",
    data: { type: "data", data: value.data },
    mediaType: value.mimeType,
  };
}

function embeddedResourcePart(value: Record<string, unknown>): ToolModelContentPart | undefined {
  const resource = isRecord(value.resource) ? value.resource : undefined;
  if (!resource) {
    return undefined;
  }
  const uri = typeof resource.uri === "string" ? resource.uri : "embedded resource";
  if (typeof resource.text === "string") {
    return { type: "text", text: `[${uri}]\n${resource.text}` };
  }
  if (typeof resource.blob === "string") {
    return {
      type: "file",
      data: { type: "data", data: resource.blob },
      mediaType:
        typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream",
      filename: uri,
    };
  }
  return undefined;
}

function resourceLinkPart(value: Record<string, unknown>): ToolModelContentPart | undefined {
  if (typeof value.uri !== "string") {
    return undefined;
  }
  const name = typeof value.name === "string" ? value.name : "resource";
  const description = typeof value.description === "string" ? ` — ${value.description}` : "";
  return { type: "text", text: `[${name}] ${value.uri}${description}` };
}

function toModelContentPart(value: unknown): ToolModelContentPart | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.type === "image" || value.type === "audio") {
    return dataFilePart(value);
  }
  if (value.type === "resource") {
    return embeddedResourcePart(value);
  }
  if (value.type === "resource_link") {
    return resourceLinkPart(value);
  }
  return undefined;
}

function mcpModelOutput(
  result: unknown,
  display: unknown,
  isError: boolean,
  taskWrapped: boolean,
): ToolModelOutput {
  if (isError) {
    return defaultModelOutput(display, { kind: TOOL_OUTCOME_KINDS.toolFailed });
  }

  const content = getContent(result);
  const parts = Array.isArray(content)
    ? content.flatMap((value) => {
        const part = toModelContentPart(value);
        return part === undefined ? [] : [part];
      })
    : [];
  const structuredContent = getStructuredContent(result);
  if (structuredContent !== undefined && parts.length > 0) {
    parts.push({
      type: "text",
      text: `[structuredContent]\n${serialize(toModelJsonValue(structuredContent))}`,
    });
  }
  if (parts.length > 0) {
    return { type: "content", value: boundedModelContent(parts) };
  }
  if (structuredContent !== undefined) {
    return boundedJsonModelOutput(structuredContent);
  }
  if (taskWrapped) {
    return typeof result === "string"
      ? boundedTextModelOutput(result)
      : boundedJsonModelOutput(result);
  }
  return defaultModelOutput(display, { kind: TOOL_OUTCOME_KINDS.success });
}

function displayProjection(result: unknown, isError: boolean, taskWrapped: boolean): unknown {
  const texts = extractTextContent(getContent(result));
  if (texts.length > 0) {
    return clipDisplayText(texts.join("\n"));
  }
  const structuredContent = getStructuredContent(result);
  if (structuredContent !== undefined) {
    const json = toDisplayJsonValue(structuredContent);
    const serialized = serialize(json);
    return serialized.length <= MAX_TOOL_DISPLAY_CHARS ? json : clipDisplayText(serialized);
  }
  const content = getContent(result);
  if (Array.isArray(content) && content.length > 0) {
    const labels = content.slice(0, MAX_TOOL_DISPLAY_ITEMS).flatMap((value) => {
      if (!isRecord(value) || typeof value.type !== "string") {
        return [];
      }
      const mediaType = typeof value.mimeType === "string" ? ` ${value.mimeType}` : "";
      return [`[${value.type}${mediaType}]`];
    });
    if (labels.length > 0) {
      const omitted = content.length - Math.min(content.length, MAX_TOOL_DISPLAY_ITEMS);
      return `${labels.join("\n")}${omitted > 0 ? `\n[另有 ${String(omitted)} 项未展示]` : ""}`;
    }
  }
  if (taskWrapped) {
    const json = toDisplayJsonValue(result);
    const serialized = serialize(json);
    return serialized.length <= MAX_TOOL_DISPLAY_CHARS ? json : clipDisplayText(serialized);
  }
  return isError ? "工具执行失败（无可展示的文本结果）" : "工具执行完成（无可展示的文本结果）";
}

export function normalizeToolResult(result: unknown): NormalizedToolResult {
  const projected = taskToolResult(result);
  const isError = isToolErrorResult(projected.value);
  const display = displayProjection(projected.value, isError, projected.wrapped);
  const outcome: ToolOutcome = isError
    ? { kind: TOOL_OUTCOME_KINDS.toolFailed }
    : { kind: TOOL_OUTCOME_KINDS.success };
  return createToolResult(outcome, display, {
    raw: result,
    model: mcpModelOutput(projected.value, display, isError, projected.wrapped),
  });
}

function isToolOutcome(value: unknown): value is ToolOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  return Object.values(TOOL_OUTCOME_KINDS).some((kind) => kind === value.kind);
}

export function isNormalizedToolResult(value: unknown): value is NormalizedToolResult {
  return (
    isRecord(value) &&
    "raw" in value &&
    "model" in value &&
    "display" in value &&
    isToolOutcome(value.outcome)
  );
}

export function readToolOutcome(value: unknown): ToolOutcome {
  if (isNormalizedToolResult(value)) {
    return value.outcome;
  }
  if (isRecord(value) && value.type === "execution-denied") {
    return {
      kind: TOOL_OUTCOME_KINDS.userRejected,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  if (isRecord(value) && typeof value.type === "string" && value.type.startsWith("error")) {
    return { kind: TOOL_OUTCOME_KINDS.toolFailed };
  }
  return readLegacyIsError(value)
    ? { kind: TOOL_OUTCOME_KINDS.toolFailed }
    : { kind: TOOL_OUTCOME_KINDS.success };
}

function readLegacyIsError(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

export function readIsError(value: unknown): boolean {
  return readToolOutcome(value).kind !== TOOL_OUTCOME_KINDS.success;
}

export function readDisplayOutput(value: unknown): unknown {
  if (isNormalizedToolResult(value)) {
    return value.display;
  }
  return isRecord(value) && "output" in value ? value.output : value;
}

export function toolResultToModelOutput(result: NormalizedToolResult): ToolModelOutput {
  return result.model;
}
