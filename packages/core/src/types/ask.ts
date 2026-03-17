import type { RouteDecision, RouteSelection } from "./router.ts";

export const ASK_RESULT_STATUSES = [
  "success",
  "needs_input",
  "needs_confirmation",
  "failed",
] as const;
export type AskResultStatus = (typeof ASK_RESULT_STATUSES)[number];

export const ASK_FAILURE_STAGES = ["route", "connect", "execute"] as const;
export type AskFailureStage = (typeof ASK_FAILURE_STAGES)[number];

export const ASK_VALIDATION_ISSUE_CODES = [
  "missing_required",
  "invalid_type",
  "invalid_enum",
  "unexpected_property",
] as const;
export type AskValidationIssueCode = (typeof ASK_VALIDATION_ISSUE_CODES)[number];

export interface AskValidationIssue {
  readonly path: string;
  readonly code: AskValidationIssueCode;
  readonly message: string;
  readonly description?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface AskNeedsInputResult {
  readonly status: "needs_input";
  readonly decision: RouteDecision;
  readonly validationIssues: ReadonlyArray<AskValidationIssue>;
  readonly message: string;
}

export interface AskNeedsConfirmationResult {
  readonly status: "needs_confirmation";
  readonly decision: RouteSelection;
  readonly message: string;
}

export interface AskFailedResult {
  readonly status: "failed";
  readonly stage: AskFailureStage;
  readonly decision?: RouteSelection | RouteDecision;
  readonly message: string;
}

export interface AskSuccessResult {
  readonly status: "success";
  readonly decision: RouteDecision;
  readonly result: unknown;
}

export type AskCommandResult =
  | AskNeedsInputResult
  | AskNeedsConfirmationResult
  | AskFailedResult
  | AskSuccessResult;
