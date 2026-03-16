import { AppError } from "./app-error.ts";
import { ErrorCode } from "./error-codes.ts";

export interface LLMErrorContext {
  model?: string | undefined;
  provider?: string | undefined;
  statusCode?: number | undefined;
  responseBody?: string | undefined;
}

export interface StructuredOutputErrorContext extends LLMErrorContext {
  rawText?: string | undefined;
  isMarkdownFormat?: boolean | undefined;
  parseErrorMessage?: string | undefined;
  schemaName?: string | undefined;
  usage?: unknown | undefined;
}

export function createLLMError(
  code:
    | typeof ErrorCode.LLM_UNAUTHORIZED
    | typeof ErrorCode.LLM_MODEL_NOT_FOUND
    | typeof ErrorCode.LLM_RATE_LIMITED
    | typeof ErrorCode.LLM_TIMEOUT
    | typeof ErrorCode.LLM_GENERATION_FAILED
    | typeof ErrorCode.LLM_RESPONSE_PARSE_ERROR,
  cause: Error,
  context?: LLMErrorContext,
): AppError {
  const modelInfo = context?.model ? ` (model: ${context.model})` : "";
  const providerInfo = context?.provider ? ` [${context.provider}]` : "";
  const messages: Record<string, string> = {
    [ErrorCode.LLM_UNAUTHORIZED]: `LLM API authentication failed${providerInfo}${modelInfo}`,
    [ErrorCode.LLM_MODEL_NOT_FOUND]: `Model not found or unavailable${modelInfo}${providerInfo}`,
    [ErrorCode.LLM_RATE_LIMITED]: `LLM API rate limited${providerInfo}`,
    [ErrorCode.LLM_TIMEOUT]: `LLM API request timeout${providerInfo}${modelInfo}`,
    [ErrorCode.LLM_GENERATION_FAILED]: `LLM generation failed${providerInfo}${modelInfo}`,
    [ErrorCode.LLM_RESPONSE_PARSE_ERROR]: `Failed to parse LLM response${providerInfo}`,
  };
  return new AppError({
    code,
    message: messages[code] || `LLM error: ${cause.message}`,
    cause,
    details: context,
  });
}

export function createConfigError(
  code:
    | typeof ErrorCode.CONFIG_NOT_FOUND
    | typeof ErrorCode.CONFIG_INVALID
    | typeof ErrorCode.CONFIG_MISSING_FIELD
    | typeof ErrorCode.CONFIG_LOAD_FAILED,
  message: string,
  context?: { configKey?: string; missingFields?: string[]; expectedType?: string },
  cause?: Error,
): AppError {
  return new AppError({
    code,
    message,
    ...(cause !== undefined ? { cause } : {}),
    ...(context !== undefined ? { details: context } : {}),
  });
}

export function createNetworkError(
  code:
    | typeof ErrorCode.NETWORK_TIMEOUT
    | typeof ErrorCode.NETWORK_CONNECTION_FAILED
    | typeof ErrorCode.NETWORK_HTTP_ERROR
    | typeof ErrorCode.NETWORK_DNS_FAILED,
  cause: Error,
  context?: { url?: string; statusCode?: number; method?: string },
): AppError {
  const urlInfo = context?.url ? ` (${context.url})` : "";
  const statusInfo = context?.statusCode ? ` [${context.statusCode}]` : "";
  const messages: Record<string, string> = {
    [ErrorCode.NETWORK_TIMEOUT]: `Network request timeout${urlInfo}`,
    [ErrorCode.NETWORK_CONNECTION_FAILED]: `Failed to connect${urlInfo}`,
    [ErrorCode.NETWORK_HTTP_ERROR]: `HTTP error${statusInfo}${urlInfo}`,
    [ErrorCode.NETWORK_DNS_FAILED]: `DNS resolution failed${urlInfo}`,
  };
  return new AppError({
    code,
    message: messages[code] || `Network error: ${cause.message}`,
    cause,
    details: context,
  });
}

export function createValidationError(
  code:
    | typeof ErrorCode.VALIDATION_INVALID_INPUT
    | typeof ErrorCode.VALIDATION_MISSING_REQUIRED
    | typeof ErrorCode.VALIDATION_FORMAT_ERROR
    | typeof ErrorCode.VALIDATION_SCHEMA_ERROR,
  message: string,
  details?: unknown,
): AppError {
  return new AppError({
    code,
    message,
    ...(details !== undefined ? { details } : {}),
  });
}

export function createBusinessError(
  code:
    | typeof ErrorCode.BUSINESS_RULE_VIOLATION
    | typeof ErrorCode.BUSINESS_RESOURCE_NOT_FOUND
    | typeof ErrorCode.BUSINESS_RESOURCE_EXISTS
    | typeof ErrorCode.BUSINESS_OPERATION_NOT_ALLOWED,
  message: string,
  userMessage?: string,
  details?: unknown,
): AppError {
  return new AppError({
    code,
    message,
    ...(userMessage !== undefined ? { userMessage } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

export function createSystemError(
  code:
    | typeof ErrorCode.SYSTEM_INTERNAL
    | typeof ErrorCode.SYSTEM_DEPENDENCY_FAILED
    | typeof ErrorCode.SYSTEM_RESOURCE_UNAVAILABLE
    | typeof ErrorCode.SYSTEM_UNKNOWN,
  message: string,
  cause?: Error,
  details?: unknown,
): AppError {
  return new AppError({
    code,
    message,
    ...(cause !== undefined ? { cause } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

export function createStructuredOutputError(
  code: typeof ErrorCode.LLM_RESPONSE_PARSE_ERROR,
  cause: Error,
  context: StructuredOutputErrorContext,
): AppError {
  const formatInfo = context.isMarkdownFormat ? " (detected markdown format)" : "";
  const schemaInfo = context.schemaName ? ` for schema "${context.schemaName}"` : "";
  return new AppError({
    code,
    message: `Failed to parse structured output${schemaInfo}${formatInfo}`,
    cause,
    details: {
      rawText: context.rawText,
      isMarkdownFormat: context.isMarkdownFormat,
      parseErrorMessage: context.parseErrorMessage,
      model: context.model,
      provider: context.provider,
      schemaName: context.schemaName,
      usage: context.usage,
    },
  });
}
