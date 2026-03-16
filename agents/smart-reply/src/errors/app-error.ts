import type { ErrorCode, ErrorCategory } from "./error-codes.ts";
import { getErrorCategory, getErrorUserMessage } from "./error-codes.ts";

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  userMessage?: string | undefined;
  cause?: Error | undefined;
  details?: unknown | undefined;
}

export interface SerializedAppError {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  userMessage: string;
  timestamp: string;
  details?: unknown | undefined;
  cause?: SerializedAppError | { message: string; stack?: string | undefined } | undefined;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly userMessage: string;
  readonly details?: unknown | undefined;
  override readonly cause?: Error | undefined;
  readonly timestamp: string;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.category = getErrorCategory(options.code);
    this.userMessage = options.userMessage || getErrorUserMessage(options.code);
    this.details = options.details;
    this.cause = options.cause;
    this.timestamp = new Date().toISOString();
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  toJSON(): SerializedAppError {
    const result: SerializedAppError = {
      code: this.code,
      category: this.category,
      message: this.message,
      userMessage: this.userMessage,
      timestamp: this.timestamp,
    };
    if (this.details !== undefined) {
      result.details = this.details;
    }
    if (this.cause) {
      if (this.cause instanceof AppError) {
        result.cause = this.cause.toJSON();
      } else {
        result.cause = { message: this.cause.message, stack: this.cause.stack };
      }
    }
    return result;
  }

  getErrorChain(): Array<AppError | Error> {
    const chain: Array<AppError | Error> = [this];
    let current: Error | undefined = this.cause;
    while (current) {
      chain.push(current);
      current = current instanceof AppError ? current.cause : undefined;
    }
    return chain;
  }

  getRootCause(): Error {
    const chain = this.getErrorChain();
    // chain always contains at least `this`, so the last element is guaranteed
    return chain[chain.length - 1] as Error;
  }

  hasErrorCode(code: ErrorCode): boolean {
    return this.getErrorChain().some((error) => error instanceof AppError && error.code === code);
  }

  hasErrorCategory(category: ErrorCategory): boolean {
    return this.getErrorChain().some(
      (error) => error instanceof AppError && error.category === category,
    );
  }

  toLogString(): string {
    const parts = [`[${this.code}]`, this.message];
    if (this.details) {
      parts.push(`Details: ${JSON.stringify(this.details)}`);
    }
    if (this.cause) {
      parts.push(`Caused by: ${this.cause.message}`);
    }
    return parts.join(" | ");
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isErrorCode(error: unknown, code: ErrorCode): boolean {
  return isAppError(error) && error.code === code;
}

export function isErrorCategory(error: unknown, category: ErrorCategory): boolean {
  return isAppError(error) && error.category === category;
}

export function isLLMError(error: unknown): boolean {
  return isErrorCategory(error, "LLM");
}

export function isConfigError(error: unknown): boolean {
  return isErrorCategory(error, "CONFIG");
}

export function isNetworkError(error: unknown): boolean {
  return isErrorCategory(error, "NETWORK");
}

export function isAuthError(error: unknown): boolean {
  return isErrorCategory(error, "AUTH");
}
