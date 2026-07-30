import { createHash, randomUUID } from "node:crypto";
import type { JSONValue } from "@ai-sdk/provider";
import { TOOL_OUTCOME_KINDS, isToolCancellationExecutionState } from "./normalize-result.ts";
import type {
  NormalizedToolResult,
  ToolModelContentPart,
  ToolModelOutput,
  ToolOutcome,
} from "./normalize-result.ts";

export const TOOL_EXECUTION_RECORD_VERSION = 1 as const;
export const TOOL_EXECUTION_VALUE_ENVELOPE_VERSION = 1 as const;
export const TOOL_EXECUTION_PERSISTENCE_VERSION = 1 as const;

export const TOOL_EXECUTION_PERSISTENCE_LIMITS = {
  inputBytes: 32 * 1_024,
  rawBytes: 64 * 1_024,
  modelBytes: 64 * 1_024,
  displayBytes: 32 * 1_024,
  outcomeBytes: 8 * 1_024,
  identifierBytes: 4 * 1_024,
  recordBytes: 256 * 1_024,
} as const;

export const TOOL_EXECUTION_EVIDENCE_OMISSION_REASONS = {
  sizeLimit: "size_limit",
  recordLimit: "record_limit",
} as const;

export const TOOL_EXECUTION_VALUE_ENCODINGS = {
  json: "json",
  diagnostic: "diagnostic",
  redacted: "redacted",
} as const;

export const TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS = {
  error: "error",
  undefined: "undefined",
  bigint: "bigint",
  cycle: "cycle",
  nonFiniteNumber: "non_finite_number",
  unsupported: "unsupported",
  unreadable: "unreadable",
} as const;

export type ToolExecutionRecordVersion = typeof TOOL_EXECUTION_RECORD_VERSION;
export type ToolExecutionValueEnvelopeVersion = typeof TOOL_EXECUTION_VALUE_ENVELOPE_VERSION;
export type ToolExecutionPersistenceVersion = typeof TOOL_EXECUTION_PERSISTENCE_VERSION;
export type ToolExecutionEvidenceOmissionReason =
  (typeof TOOL_EXECUTION_EVIDENCE_OMISSION_REASONS)[keyof typeof TOOL_EXECUTION_EVIDENCE_OMISSION_REASONS];
export type ToolExecutionValueEncoding =
  (typeof TOOL_EXECUTION_VALUE_ENCODINGS)[keyof typeof TOOL_EXECUTION_VALUE_ENCODINGS];
export type ToolExecutionValueDiagnosticKind =
  (typeof TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS)[keyof typeof TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS];

declare const toolExecutionRecordIdBrand: unique symbol;

export type ToolExecutionRecordId = string & {
  readonly [toolExecutionRecordIdBrand]: "ToolExecutionRecordId";
};

export interface ToolExecutionValueDiagnostic {
  readonly kind: ToolExecutionValueDiagnosticKind;
  readonly path: string;
  readonly message: string;
  readonly detail?: string;
  readonly referencePath?: string;
}

export interface JsonToolExecutionValueEnvelope {
  readonly version: ToolExecutionValueEnvelopeVersion;
  readonly encoding: typeof TOOL_EXECUTION_VALUE_ENCODINGS.json;
  readonly value: JSONValue;
}

export interface DiagnosticToolExecutionValueEnvelope {
  readonly version: ToolExecutionValueEnvelopeVersion;
  readonly encoding: typeof TOOL_EXECUTION_VALUE_ENCODINGS.diagnostic;
  /** JSON-safe best-effort preview. Unsupported values are replaced by diagnostic markers. */
  readonly value: JSONValue;
  readonly diagnostics: readonly ToolExecutionValueDiagnostic[];
}

export interface RedactedToolExecutionValueEnvelope {
  readonly version: ToolExecutionValueEnvelopeVersion;
  readonly encoding: typeof TOOL_EXECUTION_VALUE_ENCODINGS.redacted;
}

export type PersistedToolExecutionValueEnvelope =
  | JsonToolExecutionValueEnvelope
  | DiagnosticToolExecutionValueEnvelope;

export type ToolExecutionValueEnvelope =
  | PersistedToolExecutionValueEnvelope
  | RedactedToolExecutionValueEnvelope;

export interface ToolExecutionRecord {
  readonly version: ToolExecutionRecordVersion;
  readonly id: ToolExecutionRecordId;
  readonly toolCallId: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly createdAt: string;
  readonly input: PersistedToolExecutionValueEnvelope;
  readonly raw: PersistedToolExecutionValueEnvelope;
  readonly model: ToolModelOutput;
  readonly display: PersistedToolExecutionValueEnvelope;
  readonly outcome: ToolOutcome;
}

export interface PersistedToolExecutionFieldMetadata {
  /** UTF-8 bytes before the write-time redaction pass. */
  readonly originalByteLength: number;
  /** UTF-8 bytes retained in the persisted projection. */
  readonly storedByteLength: number;
  /** SHA-256 of the redacted value, never of the original secret-bearing value. */
  readonly redactedSha256: string;
  readonly redactionApplied: true;
  readonly truncated: boolean;
  readonly omissionReason?: ToolExecutionEvidenceOmissionReason;
}

export interface ToolExecutionPersistenceMetadata {
  readonly version: ToolExecutionPersistenceVersion;
  readonly fields: {
    readonly input: PersistedToolExecutionFieldMetadata;
    readonly raw: PersistedToolExecutionFieldMetadata;
    readonly model: PersistedToolExecutionFieldMetadata;
    readonly display: PersistedToolExecutionFieldMetadata;
    readonly outcome: PersistedToolExecutionFieldMetadata;
  };
}

/**
 * Durable projection of an in-memory ToolExecutionRecord.
 *
 * The core fields deliberately remain assignment-compatible with ToolExecutionRecord so existing
 * recovery and compaction consumers can keep using typed identity/outcome/model/display data. The
 * persistence metadata proves that the evidence passed the bounded write-time projection.
 */
export interface PersistedToolExecutionRecord extends ToolExecutionRecord {
  readonly persistence: ToolExecutionPersistenceMetadata;
}

export interface CreateToolExecutionRecordInput {
  readonly id?: string;
  readonly toolCallId: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly result: NormalizedToolResult;
  readonly createdAt?: string;
}

export interface RedactedToolExecutionRecordSummary {
  readonly version: ToolExecutionRecordVersion;
  readonly id: ToolExecutionRecordId;
  readonly toolCallId: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly createdAt: string;
  readonly input: RedactedToolExecutionValueEnvelope;
  readonly raw: RedactedToolExecutionValueEnvelope;
  readonly model: ToolModelOutput;
  readonly display: PersistedToolExecutionValueEnvelope;
  readonly outcome: ToolOutcome;
  readonly persistence?: ToolExecutionPersistenceMetadata;
}

interface EncodeState {
  readonly ancestors: WeakMap<object, string>;
  readonly diagnostics: ToolExecutionValueDiagnostic[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const REDACTED_VALUE: RedactedToolExecutionValueEnvelope = Object.freeze({
  version: TOOL_EXECUTION_VALUE_ENVELOPE_VERSION,
  encoding: TOOL_EXECUTION_VALUE_ENCODINGS.redacted,
});
const REDACTED_TEXT = "[redacted]";
const SENSITIVE_CJK_FIELD_SUFFIX_PATTERN = /(?:密码|口令|密钥|秘钥|令牌|凭证|授权(?:信息)?)$/u;
const COMPACT_SENSITIVE_FIELD_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authkey",
  "authsecret",
  "authtoken",
  "bearertoken",
  "clientkey",
  "clientsecret",
  "connectionstring",
  "privatekey",
  "refreshtoken",
  "secretkey",
  "sessiontoken",
]);
const TEXT_FIELD_ASSIGNMENT_PATTERN =
  /(?<![\p{L}\p{N}_.-])(?:(['"`])([\p{L}_][\p{L}\p{N}_.-]*)\1|([\p{L}_][\p{L}\p{N}_.-]*))(\s*[:=：＝]\s*)/gu;
const EMBEDDED_BASE64_DATA_URI_PATTERN =
  /data:[^,\s]+;base64,[a-z0-9+/_=-]+(?:(?:[ \t]*\r?\n[ \t]*|[ \t]*\\(?:r\\n|n)[ \t]*)[a-z0-9+/_=-]+)*/giu;
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/giu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JSONValue {
  if (depth > 64) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isDiagnostic(value: unknown): value is ToolExecutionValueDiagnostic {
  return (
    isRecord(value) &&
    Object.values(TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS).includes(
      value.kind as ToolExecutionValueDiagnosticKind,
    ) &&
    typeof value.path === "string" &&
    typeof value.message === "string" &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.referencePath === undefined || typeof value.referencePath === "string")
  );
}

function isPersistedEnvelope(value: unknown): value is PersistedToolExecutionValueEnvelope {
  if (
    !isRecord(value) ||
    value.version !== TOOL_EXECUTION_VALUE_ENVELOPE_VERSION ||
    !isJsonValue(value.value)
  ) {
    return false;
  }
  if (value.encoding === TOOL_EXECUTION_VALUE_ENCODINGS.json) {
    return true;
  }
  return (
    value.encoding === TOOL_EXECUTION_VALUE_ENCODINGS.diagnostic &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic)
  );
}

function isToolOutcome(value: unknown): value is ToolOutcome {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === TOOL_OUTCOME_KINDS.success) {
    return value.reason === undefined && value.executionState === undefined;
  }
  if (
    !Object.values(TOOL_OUTCOME_KINDS).includes(value.kind as ToolOutcome["kind"]) ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    return false;
  }
  if (value.kind !== TOOL_OUTCOME_KINDS.cancelled) {
    return value.executionState === undefined;
  }
  return (
    value.executionState === undefined || isToolCancellationExecutionState(value.executionState)
  );
}

function isModelContentPart(value: unknown): value is ToolModelContentPart {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string";
  }
  return (
    value.type === "file" &&
    isRecord(value.data) &&
    value.data.type === "data" &&
    typeof value.data.data === "string" &&
    typeof value.mediaType === "string" &&
    (value.filename === undefined || typeof value.filename === "string")
  );
}

function isToolModelOutput(value: unknown): value is ToolModelOutput {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "text" || value.type === "error-text") {
    return typeof value.value === "string";
  }
  if (value.type === "json" || value.type === "error-json") {
    return isJsonValue(value.value);
  }
  if (value.type === "execution-denied") {
    return value.reason === undefined || typeof value.reason === "string";
  }
  return (
    value.type === "content" && Array.isArray(value.value) && value.value.every(isModelContentPart)
  );
}

function objectPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

function arrayPath(path: string, index: number): string {
  return `${path}[${String(index)}]`;
}

function symbolPath(path: string, key: symbol): string {
  return `${path}[${String(key)}]`;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[value could not be stringified]";
  }
}

function diagnosticMarker(diagnostic: ToolExecutionValueDiagnostic): JSONValue {
  return {
    $rollDiagnostic: {
      kind: diagnostic.kind,
      path: diagnostic.path,
      message: diagnostic.message,
      ...(diagnostic.detail !== undefined ? { detail: diagnostic.detail } : {}),
      ...(diagnostic.referencePath !== undefined
        ? { referencePath: diagnostic.referencePath }
        : {}),
    },
  };
}

function recordDiagnostic(state: EncodeState, diagnostic: ToolExecutionValueDiagnostic): JSONValue {
  state.diagnostics.push(diagnostic);
  return diagnosticMarker(diagnostic);
}

function errorDiagnostic(value: Error, path: string): ToolExecutionValueDiagnostic {
  let detail: string | undefined;
  try {
    detail = value.stack;
  } catch {
    detail = undefined;
  }
  let name = "Error";
  let message = "Error value could not be inspected";
  try {
    name = value.name;
    message = value.message;
  } catch {
    // Retain the stable fallback above for hostile Error subclasses or proxies.
  }
  return {
    kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.error,
    path,
    message: `${name}: ${message}`,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function unsupportedDiagnostic(
  path: string,
  message: string,
  detail?: string,
): ToolExecutionValueDiagnostic {
  return {
    kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.unsupported,
    path,
    message,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function defineJsonProperty(
  target: Record<string, JSONValue>,
  key: string,
  value: JSONValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function encodeArray(value: readonly unknown[], path: string, state: EncodeState): JSONValue {
  const output: JSONValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = arrayPath(path, index);
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      output.push(
        recordDiagnostic(state, {
          kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.undefined,
          path: itemPath,
          message: "Sparse array slots are not JSON values",
        }),
      );
      continue;
    }
    let item: unknown;
    try {
      item = value[index];
    } catch (error) {
      output.push(
        recordDiagnostic(state, {
          kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.unreadable,
          path: itemPath,
          message: "Array item could not be read",
          detail: safeString(error),
        }),
      );
      continue;
    }
    output.push(encodeValue(item, itemPath, state));
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length" || (typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key))) {
      continue;
    }
    const propertyPath = typeof key === "symbol" ? symbolPath(path, key) : objectPath(path, key);
    recordDiagnostic(
      state,
      unsupportedDiagnostic(
        propertyPath,
        "Non-index array properties are not representable in JSON",
      ),
    );
  }
  return output;
}

function encodePlainObject(
  value: object,
  path: string,
  state: EncodeState,
): Record<string, JSONValue> {
  const output: Record<string, JSONValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    const propertyPath = typeof key === "symbol" ? symbolPath(path, key) : objectPath(path, key);
    if (typeof key === "symbol") {
      recordDiagnostic(
        state,
        unsupportedDiagnostic(
          propertyPath,
          "Symbol-keyed properties are not representable in JSON",
        ),
      );
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      recordDiagnostic(
        state,
        unsupportedDiagnostic(propertyPath, "Property descriptor disappeared while encoding"),
      );
      continue;
    }
    if (!descriptor.enumerable) {
      recordDiagnostic(
        state,
        unsupportedDiagnostic(
          propertyPath,
          "Non-enumerable properties are not representable in JSON",
        ),
      );
      continue;
    }
    if (!("value" in descriptor)) {
      defineJsonProperty(
        output,
        key,
        recordDiagnostic(
          state,
          unsupportedDiagnostic(
            propertyPath,
            "Accessor properties are not read during persistence",
          ),
        ),
      );
      continue;
    }
    defineJsonProperty(output, key, encodeValue(descriptor.value, propertyPath, state));
  }
  return output;
}

function encodeObject(value: object, path: string, state: EncodeState): JSONValue {
  const referencePath = state.ancestors.get(value);
  if (referencePath !== undefined) {
    return recordDiagnostic(state, {
      kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.cycle,
      path,
      message: "Cyclic references are not representable in JSON",
      referencePath,
    });
  }

  state.ancestors.set(value, path);
  try {
    if (value instanceof Error) {
      return recordDiagnostic(state, errorDiagnostic(value, path));
    }
    if (Array.isArray(value)) {
      return encodeArray(value, path, state);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return recordDiagnostic(
        state,
        unsupportedDiagnostic(
          path,
          "Only plain objects and arrays are losslessly representable in JSON",
          safeString(value),
        ),
      );
    }
    return encodePlainObject(value, path, state);
  } catch (error) {
    return recordDiagnostic(state, {
      kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.unreadable,
      path,
      message: "Object could not be inspected for persistence",
      detail: safeString(error),
    });
  } finally {
    state.ancestors.delete(value);
  }
}

function encodeValue(value: unknown, path: string, state: EncodeState): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    return recordDiagnostic(state, {
      kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.nonFiniteNumber,
      path,
      message: "Non-finite numbers are not JSON values",
      detail: safeString(value),
    });
  }
  if (typeof value === "undefined") {
    return recordDiagnostic(state, {
      kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.undefined,
      path,
      message: "undefined is not a JSON value",
    });
  }
  if (typeof value === "bigint") {
    return recordDiagnostic(state, {
      kind: TOOL_EXECUTION_VALUE_DIAGNOSTIC_KINDS.bigint,
      path,
      message: "BigInt is not a JSON value",
      detail: value.toString(),
    });
  }
  if (typeof value === "symbol") {
    return recordDiagnostic(
      state,
      unsupportedDiagnostic(path, "Symbols are not JSON values", safeString(value)),
    );
  }
  if (typeof value === "function") {
    return recordDiagnostic(
      state,
      unsupportedDiagnostic(path, "Functions are not JSON values", value.name || "anonymous"),
    );
  }
  return encodeObject(value, path, state);
}

function cloneJsonValue(value: JSONValue): JSONValue {
  return encodeToolExecutionValue(value).value;
}

function cloneModelContentPart(part: ToolModelContentPart): ToolModelContentPart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  return {
    type: "file",
    data: { type: "data", data: part.data.data },
    mediaType: part.mediaType,
    ...(part.filename !== undefined ? { filename: part.filename } : {}),
  };
}

function cloneModelOutput(model: ToolModelOutput): ToolModelOutput {
  if (model.type === "text" || model.type === "error-text") {
    return { type: model.type, value: model.value };
  }
  if (model.type === "json" || model.type === "error-json") {
    return { type: model.type, value: cloneJsonValue(model.value) };
  }
  if (model.type === "execution-denied") {
    return {
      type: "execution-denied",
      ...(model.reason !== undefined ? { reason: model.reason } : {}),
    };
  }
  return { type: "content", value: model.value.map(cloneModelContentPart) };
}

function cloneOutcome(outcome: ToolOutcome): ToolOutcome {
  if (outcome.kind === "success") {
    return { kind: "success" };
  }
  return {
    kind: outcome.kind,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.kind === TOOL_OUTCOME_KINDS.cancelled && outcome.executionState !== undefined
      ? { executionState: outcome.executionState }
      : {}),
  };
}

function fieldNameTokens(fieldName: string): readonly string[] {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

export function isSensitiveFieldName(fieldName: string): boolean {
  if (fieldName === "_meta") {
    return true;
  }
  const trimmed = fieldName.trim();
  if (SENSITIVE_CJK_FIELD_SUFFIX_PATTERN.test(trimmed)) {
    return true;
  }
  const compact = trimmed.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  if (COMPACT_SENSITIVE_FIELD_NAMES.has(compact)) {
    return true;
  }
  const tokens = fieldNameTokens(fieldName);
  if (
    tokens.some((token) =>
      [
        "authorization",
        "cookie",
        "credential",
        "credentials",
        "passphrase",
        "passwd",
        "password",
        "secret",
      ].includes(token),
    )
  ) {
    return true;
  }
  if (tokens.includes("token")) {
    return !tokens.some((token) =>
      ["budget", "count", "limit", "maximum", "minimum", "total", "usage"].includes(token),
    );
  }
  const connectionLocator = tokens.some((token) => ["dsn", "uri", "url"].includes(token));
  const connectionResource = tokens.some((token) =>
    [
      "connection",
      "database",
      "datasource",
      "db",
      "jdbc",
      "mongo",
      "mongodb",
      "mysql",
      "postgres",
      "postgresql",
      "redis",
    ].includes(token),
  );
  if (
    (connectionLocator && connectionResource) ||
    (tokens.includes("connection") && tokens.includes("string"))
  ) {
    return true;
  }
  return (
    tokens.includes("key") &&
    tokens.some((token) => ["access", "api", "auth", "client", "private", "secret"].includes(token))
  );
}

function isBinaryFieldName(fieldName: string | undefined): boolean {
  if (fieldName === undefined) {
    return false;
  }
  const tokens = fieldNameTokens(fieldName);
  return (
    (tokens.length === 1 && ["audio", "data", "image"].includes(tokens[0] ?? "")) ||
    tokens.some((token) => ["base64", "blob", "bytes"].includes(token)) ||
    (tokens.includes("data") &&
      tokens.some((token) => ["audio", "binary", "image"].includes(token)))
  );
}

function binaryPlaceholder(value: string): string {
  return `[binary content omitted: ${String(value.length)} chars]`;
}

function quotedSecretEnd(value: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
  }
  return value.length;
}

function sensitiveTextValueEnd(value: string, start: number): number {
  const first = value[start];
  if (first === '"' || first === "'" || first === "`") {
    return quotedSecretEnd(value, start, first);
  }
  if (first === "|" || first === ">") {
    // YAML-style block scalars have no local terminator in free-form text. Redact the
    // remainder instead of guessing where a potentially multi-line credential ends.
    return value.length;
  }

  // An unquoted assignment has no reliable terminator: whitespace may be part of a passphrase,
  // not a delimiter before another field. Fail closed through the end of this physical line.
  const lineBreak = /[\r\n]/u.exec(value.slice(start));
  return lineBreak === null ? value.length : start + lineBreak.index;
}

function redactSensitiveTextAssignments(value: string, redactedText: string): string {
  let cursor = 0;
  let output = "";
  for (const match of value.matchAll(TEXT_FIELD_ASSIGNMENT_PATTERN)) {
    if (match.index < cursor) {
      continue;
    }
    const fieldName = match[2] ?? match[3];
    if (fieldName === undefined || !isSensitiveFieldName(fieldName)) {
      continue;
    }
    const assignmentEnd = match.index + match[0].length;
    const secretEnd = sensitiveTextValueEnd(value, assignmentEnd);
    output += `${value.slice(cursor, assignmentEnd)}${redactedText}`;
    cursor = Math.max(assignmentEnd, secretEnd);
  }
  return `${output}${value.slice(cursor)}`;
}

export function redactSecretText(value: string, redactedText = REDACTED_TEXT): string {
  return redactSensitiveTextAssignments(value, redactedText)
    .replace(PRIVATE_KEY_BLOCK_PATTERN, redactedText)
    .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/giu, `Bearer ${redactedText}`)
    .replace(/\b(?:github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{20,})\b/giu, redactedText)
    .replace(/\bxox[a-z]-[a-z0-9-]{12,}\b/giu, redactedText)
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, redactedText)
    .replace(/\b(?:pk|rk|sk)-[a-z0-9_-]{8,}\b/giu, redactedText)
    .replace(/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]+\.[a-z0-9_-]+\b/giu, redactedText);
}

function redactSummaryString(value: string, fieldName?: string): string {
  if (isBinaryFieldName(fieldName) || /^data:[^,\s]+;base64,/iu.test(value)) {
    return binaryPlaceholder(value);
  }
  return redactSecretText(value).replace(EMBEDDED_BASE64_DATA_URI_PATTERN, (media) =>
    binaryPlaceholder(media),
  );
}

function redactJsonValue(value: JSONValue, fieldName?: string, depth = 0): JSONValue {
  if (depth > 64) {
    return "[nested value omitted]";
  }
  if (typeof value === "string") {
    return redactSummaryString(value, fieldName);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, undefined, depth + 1));
  }
  const output: Record<string, JSONValue> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] =
      item === undefined || isSensitiveFieldName(key)
        ? REDACTED_TEXT
        : redactJsonValue(item, key, depth + 1);
  }
  return output;
}

function redactDiagnostic(diagnostic: ToolExecutionValueDiagnostic): ToolExecutionValueDiagnostic {
  return {
    kind: diagnostic.kind,
    path: diagnostic.path,
    message: redactSummaryString(diagnostic.message),
    ...(diagnostic.detail !== undefined ? { detail: redactSummaryString(diagnostic.detail) } : {}),
    ...(diagnostic.referencePath !== undefined ? { referencePath: diagnostic.referencePath } : {}),
  };
}

function redactPersistedEnvelope(
  envelope: PersistedToolExecutionValueEnvelope,
): PersistedToolExecutionValueEnvelope {
  if (envelope.encoding === TOOL_EXECUTION_VALUE_ENCODINGS.json) {
    return {
      version: envelope.version,
      encoding: TOOL_EXECUTION_VALUE_ENCODINGS.json,
      value: redactJsonValue(envelope.value),
    };
  }
  return {
    version: envelope.version,
    encoding: TOOL_EXECUTION_VALUE_ENCODINGS.diagnostic,
    value: redactJsonValue(envelope.value),
    diagnostics: envelope.diagnostics.map(redactDiagnostic),
  };
}

function redactModelContentPart(part: ToolModelContentPart): ToolModelContentPart {
  if (part.type === "text") {
    return { type: "text", text: redactSummaryString(part.text) };
  }
  return {
    type: "file",
    data: { type: "data", data: binaryPlaceholder(part.data.data) },
    mediaType: redactSummaryString(part.mediaType),
    ...(part.filename !== undefined ? { filename: redactSummaryString(part.filename) } : {}),
  };
}

function redactModelOutput(model: ToolModelOutput): ToolModelOutput {
  if (model.type === "text" || model.type === "error-text") {
    return { type: model.type, value: redactSummaryString(model.value) };
  }
  if (model.type === "json" || model.type === "error-json") {
    return { type: model.type, value: redactJsonValue(model.value) };
  }
  if (model.type === "execution-denied") {
    return {
      type: "execution-denied",
      ...(model.reason !== undefined ? { reason: redactSummaryString(model.reason) } : {}),
    };
  }
  return { type: "content", value: model.value.map(redactModelContentPart) };
}

function redactOutcome(outcome: ToolOutcome): ToolOutcome {
  if (outcome.kind === TOOL_OUTCOME_KINDS.success) {
    return { kind: TOOL_OUTCOME_KINDS.success };
  }
  return {
    kind: outcome.kind,
    ...(outcome.reason !== undefined ? { reason: redactSummaryString(outcome.reason) } : {}),
    ...(outcome.kind === TOOL_OUTCOME_KINDS.cancelled && outcome.executionState !== undefined
      ? { executionState: outcome.executionState }
      : {}),
  };
}

function serializedJson(value: unknown): string {
  return JSON.stringify(value);
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceOmissionEnvelope(
  redactedSha256: string,
  reason: ToolExecutionEvidenceOmissionReason,
): PersistedToolExecutionValueEnvelope {
  return {
    version: TOOL_EXECUTION_VALUE_ENVELOPE_VERSION,
    encoding: TOOL_EXECUTION_VALUE_ENCODINGS.json,
    value: {
      $rollEvidence: {
        omitted: true,
        reason,
        redactedSha256,
      },
    },
  };
}

function persistedFieldMetadata(
  originalSerialized: string,
  redactedSerialized: string,
  storedSerialized: string,
  omissionReason?: ToolExecutionEvidenceOmissionReason,
): PersistedToolExecutionFieldMetadata {
  return {
    originalByteLength: utf8ByteLength(originalSerialized),
    storedByteLength: utf8ByteLength(storedSerialized),
    redactedSha256: sha256(redactedSerialized),
    redactionApplied: true,
    truncated: omissionReason !== undefined,
    ...(omissionReason !== undefined ? { omissionReason } : {}),
  };
}

function boundPersistedEnvelope(
  envelope: PersistedToolExecutionValueEnvelope,
  byteLimit: number,
  forcedReason?: ToolExecutionEvidenceOmissionReason,
): {
  readonly value: PersistedToolExecutionValueEnvelope;
  readonly metadata: PersistedToolExecutionFieldMetadata;
} {
  const originalSerialized = serializedJson(envelope);
  const redacted = redactPersistedEnvelope(envelope);
  const redactedSerialized = serializedJson(redacted);
  const omissionReason =
    forcedReason ??
    (utf8ByteLength(redactedSerialized) > byteLimit
      ? TOOL_EXECUTION_EVIDENCE_OMISSION_REASONS.sizeLimit
      : undefined);
  if (omissionReason === undefined) {
    return {
      value: redacted,
      metadata: persistedFieldMetadata(originalSerialized, redactedSerialized, redactedSerialized),
    };
  }
  const omitted = evidenceOmissionEnvelope(sha256(redactedSerialized), omissionReason);
  const omittedSerialized = serializedJson(omitted);
  return {
    value: omitted,
    metadata: persistedFieldMetadata(
      originalSerialized,
      redactedSerialized,
      omittedSerialized,
      omissionReason,
    ),
  };
}

function boundedTextEvidence(
  value: string,
  byteLimit: number,
  label: string,
): { readonly value: string; readonly truncated: boolean } {
  const redacted = redactSummaryString(value);
  if (utf8ByteLength(redacted) <= byteLimit) {
    return { value: redacted, truncated: false };
  }
  const digest = sha256(redacted);
  const suffix = `…[${label} omitted; sha256:${digest}]`;
  const suffixBytes = utf8ByteLength(suffix);
  if (suffixBytes >= byteLimit) {
    return { value: suffix.slice(0, byteLimit), truncated: true };
  }
  let retained = redacted;
  while (retained.length > 0 && utf8ByteLength(retained) + suffixBytes > byteLimit) {
    retained = retained.slice(0, Math.floor(retained.length * 0.9));
  }
  return { value: `${retained}${suffix}`, truncated: true };
}

function boundModelOutput(
  model: ToolModelOutput,
  byteLimit: number,
  forcedReason?: ToolExecutionEvidenceOmissionReason,
): { readonly value: ToolModelOutput; readonly metadata: PersistedToolExecutionFieldMetadata } {
  const originalSerialized = serializedJson(model);
  const redacted = redactModelOutput(model);
  const redactedSerialized = serializedJson(redacted);
  const omissionReason =
    forcedReason ??
    (utf8ByteLength(redactedSerialized) > byteLimit
      ? TOOL_EXECUTION_EVIDENCE_OMISSION_REASONS.sizeLimit
      : undefined);
  const value: ToolModelOutput =
    omissionReason === undefined
      ? redacted
      : {
          type: "text",
          value: `[durable model evidence omitted; sha256:${sha256(redactedSerialized)}]`,
        };
  const storedSerialized = serializedJson(value);
  return {
    value,
    metadata: persistedFieldMetadata(
      originalSerialized,
      redactedSerialized,
      storedSerialized,
      omissionReason,
    ),
  };
}

function boundOutcome(
  outcome: ToolOutcome,
  byteLimit: number,
  forcedReason?: ToolExecutionEvidenceOmissionReason,
): { readonly value: ToolOutcome; readonly metadata: PersistedToolExecutionFieldMetadata } {
  const originalSerialized = serializedJson(outcome);
  const redacted = redactOutcome(outcome);
  const redactedSerialized = serializedJson(redacted);
  const omissionReason =
    forcedReason ??
    (utf8ByteLength(redactedSerialized) > byteLimit
      ? TOOL_EXECUTION_EVIDENCE_OMISSION_REASONS.sizeLimit
      : undefined);
  const value: ToolOutcome =
    omissionReason === undefined || redacted.kind === TOOL_OUTCOME_KINDS.success
      ? redacted
      : {
          kind: redacted.kind,
          reason: `[durable outcome detail omitted; sha256:${sha256(redactedSerialized)}]`,
          ...(redacted.kind === TOOL_OUTCOME_KINDS.cancelled &&
          redacted.executionState !== undefined
            ? { executionState: redacted.executionState }
            : {}),
        };
  const storedSerialized = serializedJson(value);
  return {
    value,
    metadata: persistedFieldMetadata(
      originalSerialized,
      redactedSerialized,
      storedSerialized,
      omissionReason,
    ),
  };
}

function isPersistedFieldMetadata(value: unknown): value is PersistedToolExecutionFieldMetadata {
  return (
    isRecord(value) &&
    Number.isInteger(value.originalByteLength) &&
    typeof value.originalByteLength === "number" &&
    value.originalByteLength >= 0 &&
    Number.isInteger(value.storedByteLength) &&
    typeof value.storedByteLength === "number" &&
    value.storedByteLength >= 0 &&
    typeof value.redactedSha256 === "string" &&
    SHA256_PATTERN.test(value.redactedSha256) &&
    value.redactionApplied === true &&
    typeof value.truncated === "boolean" &&
    (value.omissionReason === undefined ||
      Object.values(TOOL_EXECUTION_EVIDENCE_OMISSION_REASONS).includes(
        value.omissionReason as ToolExecutionEvidenceOmissionReason,
      ))
  );
}

function isToolExecutionPersistenceMetadata(
  value: unknown,
): value is ToolExecutionPersistenceMetadata {
  return (
    isRecord(value) &&
    value.version === TOOL_EXECUTION_PERSISTENCE_VERSION &&
    isRecord(value.fields) &&
    isPersistedFieldMetadata(value.fields.input) &&
    isPersistedFieldMetadata(value.fields.raw) &&
    isPersistedFieldMetadata(value.fields.model) &&
    isPersistedFieldMetadata(value.fields.display) &&
    isPersistedFieldMetadata(value.fields.outcome)
  );
}

export function isPersistedToolExecutionRecord(
  value: unknown,
): value is PersistedToolExecutionRecord {
  return (
    isToolExecutionRecord(value) &&
    isRecord(value) &&
    isToolExecutionPersistenceMetadata(value.persistence)
  );
}

function createPersistedProjection(
  record: ToolExecutionRecord,
  forcedReason?: ToolExecutionEvidenceOmissionReason,
): PersistedToolExecutionRecord {
  const input = boundPersistedEnvelope(
    record.input,
    TOOL_EXECUTION_PERSISTENCE_LIMITS.inputBytes,
    forcedReason,
  );
  const raw = boundPersistedEnvelope(
    record.raw,
    TOOL_EXECUTION_PERSISTENCE_LIMITS.rawBytes,
    forcedReason,
  );
  const model = boundModelOutput(
    record.model,
    TOOL_EXECUTION_PERSISTENCE_LIMITS.modelBytes,
    forcedReason,
  );
  const display = boundPersistedEnvelope(
    record.display,
    TOOL_EXECUTION_PERSISTENCE_LIMITS.displayBytes,
    forcedReason,
  );
  const outcome = boundOutcome(
    record.outcome,
    TOOL_EXECUTION_PERSISTENCE_LIMITS.outcomeBytes,
    forcedReason,
  );
  return {
    version: record.version,
    id: record.id,
    toolCallId: boundedTextEvidence(
      record.toolCallId,
      TOOL_EXECUTION_PERSISTENCE_LIMITS.identifierBytes,
      "toolCallId",
    ).value,
    agentName: boundedTextEvidence(
      record.agentName,
      TOOL_EXECUTION_PERSISTENCE_LIMITS.identifierBytes,
      "agentName",
    ).value,
    toolName: boundedTextEvidence(
      record.toolName,
      TOOL_EXECUTION_PERSISTENCE_LIMITS.identifierBytes,
      "toolName",
    ).value,
    createdAt: boundedTextEvidence(record.createdAt, 256, "createdAt").value,
    input: input.value,
    raw: raw.value,
    model: model.value,
    display: display.value,
    outcome: outcome.value,
    persistence: {
      version: TOOL_EXECUTION_PERSISTENCE_VERSION,
      fields: {
        input: input.metadata,
        raw: raw.metadata,
        model: model.metadata,
        display: display.metadata,
        outcome: outcome.metadata,
      },
    },
  };
}

export function prepareToolExecutionRecordForPersistence(
  record: ToolExecutionRecord,
): PersistedToolExecutionRecord {
  const persisted = createPersistedProjection(record);
  if (utf8ByteLength(serializedJson(persisted)) <= TOOL_EXECUTION_PERSISTENCE_LIMITS.recordBytes) {
    return persisted;
  }
  // Identity and typed outcome are still retained; only evidence payloads are collapsed. This
  // branch is deliberately non-throwing because the Tool side effect may already have happened.
  return createPersistedProjection(record, TOOL_EXECUTION_EVIDENCE_OMISSION_REASONS.recordLimit);
}

export function parsePersistedToolExecutionRecord(value: unknown): PersistedToolExecutionRecord {
  if (isPersistedToolExecutionRecord(value)) {
    return value;
  }
  return prepareToolExecutionRecordForPersistence(parseToolExecutionRecord(value));
}

export function isToolExecutionRecordId(value: unknown): value is ToolExecutionRecordId {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseToolExecutionRecordId(value: string): ToolExecutionRecordId {
  if (!isToolExecutionRecordId(value)) {
    throw new Error(`Invalid ToolExecutionRecord UUID: ${value}`);
  }
  return value;
}

export function createToolExecutionRecordId(): ToolExecutionRecordId {
  return parseToolExecutionRecordId(randomUUID());
}

export function isToolExecutionRecord(value: unknown): value is ToolExecutionRecord {
  return (
    isRecord(value) &&
    value.version === TOOL_EXECUTION_RECORD_VERSION &&
    isToolExecutionRecordId(value.id) &&
    typeof value.toolCallId === "string" &&
    typeof value.agentName === "string" &&
    typeof value.toolName === "string" &&
    typeof value.createdAt === "string" &&
    isPersistedEnvelope(value.input) &&
    isPersistedEnvelope(value.raw) &&
    isToolModelOutput(value.model) &&
    isPersistedEnvelope(value.display) &&
    isToolOutcome(value.outcome)
  );
}

export function parseToolExecutionRecord(value: unknown): ToolExecutionRecord {
  if (!isToolExecutionRecord(value)) {
    throw new Error("Invalid persisted ToolExecutionRecord");
  }
  return value;
}

export function encodeToolExecutionValue(value: unknown): PersistedToolExecutionValueEnvelope {
  const state: EncodeState = {
    ancestors: new WeakMap<object, string>(),
    diagnostics: [],
  };
  const snapshot = encodeValue(value, "$", state);
  if (state.diagnostics.length === 0) {
    return {
      version: TOOL_EXECUTION_VALUE_ENVELOPE_VERSION,
      encoding: TOOL_EXECUTION_VALUE_ENCODINGS.json,
      value: snapshot,
    };
  }
  return {
    version: TOOL_EXECUTION_VALUE_ENVELOPE_VERSION,
    encoding: TOOL_EXECUTION_VALUE_ENCODINGS.diagnostic,
    value: snapshot,
    diagnostics: state.diagnostics,
  };
}

export function createToolExecutionRecord(
  input: CreateToolExecutionRecordInput,
): ToolExecutionRecord {
  return {
    version: TOOL_EXECUTION_RECORD_VERSION,
    id:
      input.id !== undefined ? parseToolExecutionRecordId(input.id) : createToolExecutionRecordId(),
    toolCallId: input.toolCallId,
    agentName: input.agentName,
    toolName: input.toolName,
    createdAt: input.createdAt ?? new Date().toISOString(),
    input: encodeToolExecutionValue(input.input),
    raw: encodeToolExecutionValue(input.result.raw),
    model: cloneModelOutput(input.result.model),
    display: encodeToolExecutionValue(input.result.display),
    outcome: cloneOutcome(input.result.outcome),
  };
}

export function toRedactedToolExecutionRecordSummary(
  record: ToolExecutionRecord,
): RedactedToolExecutionRecordSummary {
  return {
    version: record.version,
    id: record.id,
    toolCallId: record.toolCallId,
    agentName: record.agentName,
    toolName: record.toolName,
    createdAt: record.createdAt,
    input: REDACTED_VALUE,
    raw: REDACTED_VALUE,
    model: redactModelOutput(record.model),
    display: redactPersistedEnvelope(record.display),
    outcome: redactOutcome(record.outcome),
    ...(isPersistedToolExecutionRecord(record) ? { persistence: record.persistence } : {}),
  };
}
