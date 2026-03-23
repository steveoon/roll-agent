import {
  generateText,
  NoObjectGeneratedError,
  Output,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";
import { z } from "zod";
import { wrapError, logError, ErrorCode, type AppError } from "../errors/index.ts";

// ========== safeGenerateObject ==========

export interface SafeGenerateObjectOptions<T> {
  model: LanguageModel;
  schema: z.ZodType<T>;
  schemaName?: string | undefined;
  system?: string | undefined;
  prompt: string;
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

export async function safeGenerateObject<T>(
  options: SafeGenerateObjectOptions<T>,
): Promise<SafeGenerateObjectResult<T>> {
  const { model, schema, schemaName, system, prompt, onError } = options;
  try {
    const result = await generateText({
      model,
      ...(system !== undefined ? { system } : {}),
      prompt,
      output: Output.object({
        schema,
        ...(schemaName !== undefined ? { name: schemaName } : {}),
      }),
    });
    return { success: true, data: result.output, usage: result.usage };
  } catch (error) {
    const appError = wrapError(error, ErrorCode.LLM_RESPONSE_PARSE_ERROR);
    let rawText: string | undefined;
    if (NoObjectGeneratedError.isInstance(error)) rawText = error.text;
    if (schemaName && appError.details && typeof appError.details === "object") {
      (appError.details as Record<string, unknown>).schemaName = schemaName;
    }
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
    console.error(
      `[${context}] 生成成功 | 耗时: ${latencyMs}ms | Tokens: ${totalTokens ?? "N/A"} (input: ${usage.inputTokens ?? "?"}, output: ${usage.outputTokens ?? "?"})`,
    );
    return { success: true, text: result.text, usage, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime);
    const isTimeout =
      error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
    const errorCode = isTimeout ? ErrorCode.LLM_TIMEOUT : ErrorCode.LLM_GENERATION_FAILED;
    const appError = wrapError(error, errorCode);
    if (appError.details && typeof appError.details === "object") {
      (appError.details as Record<string, unknown>).context = context;
      (appError.details as Record<string, unknown>).latencyMs = latencyMs;
    }
    logError(`${context} (${latencyMs}ms)`, appError);
    if (onError) onError(appError);
    return { success: false, error: appError };
  }
}
