export const ASK_VALIDATION_ISSUE_CODES = [
  "missing_required",
  "requires_explicit_input",
  "invalid_type",
  "invalid_enum",
  "too_small",
  "unexpected_property",
] as const;
export type AskValidationIssueCode = (typeof ASK_VALIDATION_ISSUE_CODES)[number];

export const ASK_RUNTIME_ISSUE_CATEGORIES = ["env"] as const;
export type AskRuntimeIssueCategory = (typeof ASK_RUNTIME_ISSUE_CATEGORIES)[number];

export const ASK_RUNTIME_ISSUE_CODES = ["missing_required_env"] as const;
export type AskRuntimeIssueCode = (typeof ASK_RUNTIME_ISSUE_CODES)[number];

export interface AskValidationIssue {
  readonly path: string;
  readonly code: AskValidationIssueCode;
  readonly message: string;
  readonly description?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface AskRuntimeIssue {
  readonly category: AskRuntimeIssueCategory;
  readonly code: AskRuntimeIssueCode;
  readonly name: string;
  readonly message: string;
  readonly purpose?: string;
  readonly example?: string;
}
