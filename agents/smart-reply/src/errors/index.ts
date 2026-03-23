export {
  ErrorCode,
  ErrorCategory,
  ERROR_CODE_TO_CATEGORY,
  ERROR_USER_MESSAGES,
  getErrorCategory,
  getErrorUserMessage,
  isErrorInCategory,
} from "./error-codes.ts";

export type {
  ErrorCode as ErrorCodeType,
  ErrorCategory as ErrorCategoryType,
} from "./error-codes.ts";

export {
  AppError,
  isAppError,
  isErrorCode,
  isErrorCategory,
  isLLMError,
  isConfigError,
  isNetworkError,
  isAuthError,
} from "./app-error.ts";

export type { AppErrorOptions, SerializedAppError } from "./app-error.ts";

export {
  createLLMError,
  createConfigError,
  createNetworkError,
  createValidationError,
  createBusinessError,
  createSystemError,
  createStructuredOutputError,
} from "./error-factory.ts";

export type { LLMErrorContext, StructuredOutputErrorContext } from "./error-factory.ts";

export {
  wrapError,
  toError,
  parseAISDKError,
  parseNoObjectGeneratedError,
  extractErrorContext,
  getUserMessage,
  logError,
} from "./error-utils.ts";

export type { ErrorContext, NoObjectGeneratedErrorInfo } from "./error-utils.ts";
