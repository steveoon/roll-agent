import { NoObjectGeneratedError } from "ai";
import { AppError, isAppError } from "./app-error.ts";
import type { ErrorCode, ErrorCategory } from "./error-codes.ts";
import { ErrorCode as EC } from "./error-codes.ts";
import {
  createLLMError,
  createNetworkError,
  createStructuredOutputError,
} from "./error-factory.ts";

interface AISDKErrorInfo {
  isAuthError: boolean;
  isModelNotFound: boolean;
  isRateLimited: boolean;
  isTimeout: boolean;
  statusCode?: number | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  originalMessage?: string | undefined;
  responseBody?: string | undefined;
}

export interface NoObjectGeneratedErrorInfo {
  isNoObjectGeneratedError: boolean;
  rawText?: string | undefined;
  isMarkdownFormat: boolean;
  cause?: Error | undefined;
  response?:
    | { id?: string | undefined; timestamp?: Date | undefined; modelId?: string | undefined }
    | undefined;
  usage?: unknown | undefined;
}

export function parseAISDKError(error: unknown): AISDKErrorInfo | null {
  if (!error || typeof error !== "object") return null;
  const err = error as Record<string, unknown>;
  const isAISDKError =
    err.name === "AI_APICallError" ||
    err.name === "APICallError" ||
    (typeof err.url === "string" && typeof err.statusCode === "number");
  if (!isAISDKError) return null;

  const statusCode = typeof err.statusCode === "number" ? err.statusCode : undefined;
  const responseBody = typeof err.responseBody === "string" ? err.responseBody : undefined;
  const url = typeof err.url === "string" ? err.url : undefined;
  const message = err.message as string | undefined;

  let provider: string | undefined;
  if (url) {
    if (url.includes("openai.com") || url.includes("hash070.com")) provider = "openai";
    else if (url.includes("anthropic.com")) provider = "anthropic";
    else if (url.includes("dashscope.aliyuncs.com")) provider = "qwen";
    else if (url.includes("openrouter.ai")) provider = "openrouter";
    else if (url.includes("deepseek.com")) provider = "deepseek";
    else if (url.includes("moonshot.cn")) provider = "moonshotai";
    else if (url.includes("googleapis.com")) provider = "google";
  }

  let model: string | undefined;
  if (responseBody) {
    const modelMatch = responseBody.match(/model[`'":\s]+([^`'"}\s,]+)/i);
    if (modelMatch) model = modelMatch[1];
  }

  return {
    isAuthError: statusCode === 401 || statusCode === 403,
    isModelNotFound:
      (responseBody?.includes("model") && responseBody?.includes("not exist")) ||
      responseBody?.includes("not authorized to access this model") ||
      false,
    isRateLimited: statusCode === 429,
    isTimeout:
      statusCode === 408 ||
      statusCode === 504 ||
      message?.toLowerCase().includes("timeout") ||
      false,
    statusCode,
    provider,
    model,
    originalMessage: message,
    responseBody,
  };
}

function detectMarkdownFormat(text: string): boolean {
  const markdownPatterns = [
    /^```/m,
    /^#{1,6}\s/m,
    /^\s*[-*+]\s/m,
    /^\s*\d+\.\s/m,
    /\[.+\]\(.+\)/,
    /^\s*>/m,
  ];
  return markdownPatterns.some((pattern) => pattern.test(text));
}

export function parseNoObjectGeneratedError(error: unknown): NoObjectGeneratedErrorInfo | null {
  try {
    if (
      typeof NoObjectGeneratedError === "undefined" ||
      typeof NoObjectGeneratedError.isInstance !== "function"
    ) {
      return null;
    }
    if (!NoObjectGeneratedError.isInstance(error)) return null;
  } catch {
    return null;
  }
  const rawText = error.text;
  const isMarkdownFormat = rawText ? detectMarkdownFormat(rawText) : false;
  const response = error.response
    ? {
        id: error.response.id,
        timestamp: error.response.timestamp,
        modelId: error.response.modelId,
      }
    : undefined;
  const usage = error.usage ?? undefined;
  const result: NoObjectGeneratedErrorInfo = { isNoObjectGeneratedError: true, isMarkdownFormat };
  if (rawText !== undefined) result.rawText = rawText;
  if (error.cause instanceof Error) result.cause = error.cause;
  if (response !== undefined) result.response = response;
  if (usage !== undefined) result.usage = usage;
  return result;
}

export function wrapError(
  error: unknown,
  fallbackCode: ErrorCode = EC.SYSTEM_UNKNOWN,
  userMessage?: string,
): AppError {
  if (isAppError(error)) {
    if (userMessage && userMessage !== error.userMessage) {
      return new AppError({
        code: error.code,
        message: error.message,
        userMessage,
        cause: error.cause,
        details: error.details,
      });
    }
    return error;
  }
  const originalError = toError(error);

  const aiInfo = parseAISDKError(error);
  if (aiInfo) {
    const context = {
      model: aiInfo.model,
      provider: aiInfo.provider,
      statusCode: aiInfo.statusCode,
      responseBody: aiInfo.responseBody,
    };
    if (aiInfo.isModelNotFound) {
      return createLLMError(EC.LLM_MODEL_NOT_FOUND, originalError, context);
    }
    if (aiInfo.isAuthError) return createLLMError(EC.LLM_UNAUTHORIZED, originalError, context);
    if (aiInfo.isRateLimited) return createLLMError(EC.LLM_RATE_LIMITED, originalError, context);
    if (aiInfo.isTimeout) return createLLMError(EC.LLM_TIMEOUT, originalError, context);
    return createLLMError(EC.LLM_GENERATION_FAILED, originalError, context);
  }

  const noObjectInfo = parseNoObjectGeneratedError(error);
  if (noObjectInfo) {
    return createStructuredOutputError(EC.LLM_RESPONSE_PARSE_ERROR, originalError, {
      rawText: noObjectInfo.rawText,
      isMarkdownFormat: noObjectInfo.isMarkdownFormat,
      parseErrorMessage: noObjectInfo.cause?.message,
      usage: noObjectInfo.usage,
    });
  }

  const message = originalError.message.toLowerCase();
  if (
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("network") ||
    message.includes("fetch failed")
  ) {
    if (message.includes("timeout")) return createNetworkError(EC.NETWORK_TIMEOUT, originalError);
    return createNetworkError(EC.NETWORK_CONNECTION_FAILED, originalError);
  }

  return new AppError({ code: fallbackCode, message: originalError.message, cause: originalError });
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  if (typeof error === "object" && error !== null) {
    const message =
      (error as Record<string, unknown>).message ||
      (error as Record<string, unknown>).error ||
      JSON.stringify(error);
    return new Error(String(message));
  }
  return new Error(String(error));
}

export interface ErrorContext {
  errorCode: ErrorCode;
  category: ErrorCategory;
  originalError?: string | undefined;
  details?: unknown | undefined;
}

export function extractErrorContext(error: AppError): ErrorContext {
  const context: ErrorContext = { errorCode: error.code, category: error.category };
  if (error.cause) context.originalError = error.cause.message;
  if (error.details) context.details = error.details;
  return context;
}

export function getUserMessage(error: unknown): string {
  if (isAppError(error)) return error.userMessage;
  if (error instanceof Error) return "操作失败，请稍后重试";
  return "发生未知错误，请稍后重试";
}

export function logError(context: string, error: AppError): void {
  console.error(`[${error.code}] ${context}:`, error.toLogString());
  if (error.cause) console.error("Original error:", error.cause);
}
