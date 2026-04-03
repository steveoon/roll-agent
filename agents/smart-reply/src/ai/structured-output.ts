import { setTimeout, clearTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import {
  asSchema,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  type FlexibleSchema,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";
import { z } from "zod";
import { wrapError, logError, ErrorCode, type AppError } from "../errors/index.ts";
import { verboseLog } from "../log-control.ts";

// ========== safeGenerateObject ==========

export interface SafeGenerateObjectOptions<T> {
  model: LanguageModel;
  schema: z.ZodType<T>;
  outputSchema?: FlexibleSchema<T> | undefined;
  schemaName?: string | undefined;
  system?: string | undefined;
  prompt: string;
  transformOutput?: ((value: unknown) => unknown | Promise<unknown>) | undefined;
  onError?: ((error: AppError, rawText?: string) => void) | undefined;
}

export interface SafeGenerateObjectSuccess<T> {
  success: true;
  data: T;
  usage?: LanguageModelUsage | undefined;
}

export interface SafeGenerateObjectFailure {
  success: false;
  error: AppError;
  rawText?: string | undefined;
}

export type SafeGenerateObjectResult<T> = SafeGenerateObjectSuccess<T> | SafeGenerateObjectFailure;

/**
 * 按 JSON Schema type 声明不支持的关键词。
 * key = JSON Schema type 名称（"array" | "number" | "integer" | "string" 等），
 * value = 该类型下需要剥离的关键词列表。
 * "integer" 会自动合并 "number" 的规则，无需重复声明。
 */
export interface StructuredOutputCompatibilityOptions {
  unsupportedKeywordsByType?: Readonly<Record<string, readonly string[]>> | undefined;
}

function isDetailsRecord(details: unknown): details is Record<string, unknown> {
  return typeof details === "object" && details !== null;
}

function attachSchemaName(appError: AppError, schemaName?: string | undefined): void {
  if (schemaName && isDetailsRecord(appError.details)) {
    appError.details.schemaName = schemaName;
  }
}

/** 解析 JSON Schema node 的 type 字段，返回所有声明的类型 */
function getSchemaTypes(node: Record<string, unknown>): string[] {
  const type = node.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

/** 收集一个 schema node 因其类型而应被剥离的所有关键词 */
function collectUnsupportedKeywords(
  types: string[],
  rules: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> | null {
  let merged: Set<string> | null = null;
  for (const t of types) {
    const keywords = rules.get(t);
    if (keywords !== undefined && keywords.size > 0) {
      merged ??= new Set();
      for (const k of keywords) merged.add(k);
    }
  }
  return merged;
}

function stripUnsupportedKeywordsFromJsonSchema(
  value: unknown,
  rules: ReadonlyMap<string, ReadonlySet<string>>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUnsupportedKeywordsFromJsonSchema(item, rules));
  }

  if (value === null || typeof value !== "object") return value;

  const node = value as Record<string, unknown>;
  const types = getSchemaTypes(node);
  const unsupported = collectUnsupportedKeywords(types, rules);
  const sanitizedNode: Record<string, unknown> = {};

  for (const [key, childValue] of Object.entries(node)) {
    if (unsupported !== null && unsupported.has(key)) continue;
    sanitizedNode[key] = stripUnsupportedKeywordsFromJsonSchema(childValue, rules);
  }

  return sanitizedNode;
}

function buildRulesMap(
  options: StructuredOutputCompatibilityOptions,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byType = options.unsupportedKeywordsByType;
  if (byType === undefined) return new Map();

  const map = new Map<string, Set<string>>();
  for (const [type, keywords] of Object.entries(byType)) {
    if (keywords.length === 0) continue;
    const existing = map.get(type);
    if (existing !== undefined) {
      for (const k of keywords) existing.add(k);
    } else {
      map.set(type, new Set(keywords));
    }
  }

  // "integer" 自动继承 "number" 的规则
  const numberKeywords = map.get("number");
  if (numberKeywords !== undefined && numberKeywords.size > 0) {
    const integerKeywords = map.get("integer");
    if (integerKeywords !== undefined) {
      for (const k of numberKeywords) integerKeywords.add(k);
    } else {
      map.set("integer", new Set(numberKeywords));
    }
  }

  return map;
}

export function createStructuredOutputCompatibilitySchema<T>(
  schema: FlexibleSchema<T>,
  options: StructuredOutputCompatibilityOptions = {},
): FlexibleSchema<T> {
  const rules = buildRulesMap(options);
  if (rules.size === 0) return schema;

  const baseSchema = asSchema(schema);

  return jsonSchema<T>(
    async () =>
      stripUnsupportedKeywordsFromJsonSchema(
        await baseSchema.jsonSchema,
        rules,
      ) as Awaited<typeof baseSchema.jsonSchema>,
    {
      // Output.object 先负责 JSON 解析；严格的业务校验在 safeGenerateObject 里回落到原始 Zod schema。
      validate: (value) => ({ success: true, value: value as T }),
    },
  );
}

export async function safeGenerateObject<T>(
  options: SafeGenerateObjectOptions<T>,
): Promise<SafeGenerateObjectResult<T>> {
  const { model, schema, outputSchema, schemaName, system, prompt, transformOutput, onError } =
    options;
  try {
    const result = await generateText({
      model,
      ...(system !== undefined ? { system } : {}),
      prompt,
      output: Output.object({
        schema: outputSchema ?? schema,
        ...(schemaName !== undefined ? { name: schemaName } : {}),
      }),
    });

    if (outputSchema === undefined && transformOutput === undefined) {
      return { success: true, data: result.output, usage: result.usage };
    }

    const transformedOutput =
      transformOutput !== undefined ? await transformOutput(result.output) : result.output;
    const parsed = await schema.safeParseAsync(transformedOutput);

    if (!parsed.success) {
      const appError = wrapError(parsed.error, ErrorCode.LLM_RESPONSE_PARSE_ERROR);
      attachSchemaName(appError, schemaName);
      logError(`Structured output validation (${schemaName || "unknown"})`, appError);
      if (onError) onError(appError, result.text);
      return { success: false, error: appError, rawText: result.text };
    }

    return { success: true, data: parsed.data, usage: result.usage };
  } catch (error) {
    const appError = wrapError(error, ErrorCode.LLM_RESPONSE_PARSE_ERROR);
    let rawText: string | undefined;
    if (NoObjectGeneratedError.isInstance(error)) rawText = error.text;
    attachSchemaName(appError, schemaName);
    logError(`Structured output generation (${schemaName || "unknown"})`, appError);
    if (onError) onError(appError, rawText);
    return { success: false, error: appError, rawText };
  }
}

// ========== safeGenerateText ==========

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;

export interface SafeGenerateTextOptions {
  model: LanguageModel;
  system?: string | undefined;
  prompt: string;
  timeoutMs?: number | undefined;
  maxOutputTokens?: number | undefined;
  context?: string | undefined;
  onError?: ((error: AppError) => void) | undefined;
}

export interface SafeGenerateTextUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}

export interface SafeGenerateTextSuccess {
  success: true;
  text: string;
  usage?: SafeGenerateTextUsage | undefined;
  latencyMs: number;
}

export interface SafeGenerateTextFailure {
  success: false;
  error: AppError;
}

export type SafeGenerateTextResult = SafeGenerateTextSuccess | SafeGenerateTextFailure;

export async function safeGenerateText(
  options: SafeGenerateTextOptions,
): Promise<SafeGenerateTextResult> {
  const {
    model,
    system,
    prompt,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    context = "generateText",
    onError,
  } = options;
  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const result = await generateText({
      model,
      ...(system !== undefined ? { system } : {}),
      prompt,
      maxOutputTokens,
      abortSignal: controller.signal,
    });
    clearTimeout(timeoutId);
    const latencyMs = Math.round(performance.now() - startTime);
    const rawUsage = result.usage;
    const totalTokens =
      rawUsage?.inputTokens !== undefined && rawUsage?.outputTokens !== undefined
        ? rawUsage.inputTokens + rawUsage.outputTokens
        : undefined;
    const usage: SafeGenerateTextUsage = {
      inputTokens: rawUsage?.inputTokens,
      outputTokens: rawUsage?.outputTokens,
      totalTokens,
    };
    verboseLog(
      `[${context}] 生成成功 | 耗时: ${latencyMs}ms | Tokens: ${totalTokens ?? "N/A"} (input: ${usage.inputTokens ?? "?"}, output: ${usage.outputTokens ?? "?"})`,
    );
    return { success: true, text: result.text, usage, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime);
    const isTimeout =
      error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
    const errorCode = isTimeout ? ErrorCode.LLM_TIMEOUT : ErrorCode.LLM_GENERATION_FAILED;
    const appError = wrapError(error, errorCode);
    if (isDetailsRecord(appError.details)) {
      appError.details.context = context;
      appError.details.latencyMs = latencyMs;
    }
    logError(`${context} (${latencyMs}ms)`, appError);
    if (onError) onError(appError);
    return { success: false, error: appError };
  }
}
