import type { AskValidationIssue, AskRuntimeIssue } from "@roll-agent/runtime/tool-contracts";
import type { CompletedAppOutputStatus } from "@roll-agent/protocol/app-output";
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

export {
  ASK_VALIDATION_ISSUE_CODES,
  ASK_RUNTIME_ISSUE_CATEGORIES,
  ASK_RUNTIME_ISSUE_CODES,
} from "@roll-agent/runtime/tool-contracts";
export type {
  AskValidationIssueCode,
  AskRuntimeIssueCategory,
  AskRuntimeIssueCode,
  AskValidationIssue,
  AskRuntimeIssue,
} from "@roll-agent/runtime/tool-contracts";

export interface AskNeedsInputResult {
  readonly status: "needs_input";
  readonly decision: RouteDecision;
  readonly validationIssues: ReadonlyArray<AskValidationIssue>;
  readonly runtimeIssues: ReadonlyArray<AskRuntimeIssue>;
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
  readonly appOutputStatus?: CompletedAppOutputStatus;
  readonly status: "success";
  readonly decision: RouteDecision;
  readonly result: unknown;
}

export type AskCommandResult =
  | AskNeedsInputResult
  | AskNeedsConfirmationResult
  | AskFailedResult
  | AskSuccessResult;
