export const CHAT_RESULT_STATUSES = [
  "unavailable",
  "completed",
  "needs_input",
  "needs_confirmation",
  "failed",
] as const;
export type ChatResultStatus = (typeof CHAT_RESULT_STATUSES)[number];

export const CHAT_FAILURE_STAGES = ["bootstrap", "plan", "execute"] as const;
export type ChatFailureStage = (typeof CHAT_FAILURE_STAGES)[number];

export interface ChatStepSummary {
  readonly summary: string;
  readonly agentName?: string;
  readonly toolName?: string;
}

export interface ChatTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ChatStepUsage {
  readonly finishReason: string;
  readonly usage?: ChatTokenUsage;
}

export interface ChatCompactionSummary {
  readonly reason: "auto" | "manual";
  readonly strategy: "summarize" | "truncate";
  readonly removed: number;
  readonly kept: number;
  readonly truncatedTools?: number;
  readonly beforeInputTokens?: number;
  readonly checkpointId?: string;
  readonly checkpointGeneration?: number;
  readonly checkpointSummaryStatus?: "valid" | "fallback" | "skipped";
}

export interface ChatInputRequirement {
  readonly name: string;
  readonly description: string;
}

export interface ChatPendingAction {
  readonly summary: string;
  readonly agentName?: string;
  readonly toolName?: string;
}

export interface ChatUnavailableResult {
  readonly status: "unavailable";
  readonly message: string;
}

export interface ChatCompletedResult {
  readonly status: "completed";
  readonly sessionId: string;
  readonly output: string;
  readonly steps: ReadonlyArray<ChatStepSummary>;
  readonly stepUsages?: ReadonlyArray<ChatStepUsage>;
  readonly totalUsage?: ChatTokenUsage;
  readonly sessionUsage?: ChatTokenUsage;
  readonly contextWindow?: number;
  readonly contextInputTokens?: number;
  readonly compactions?: ReadonlyArray<ChatCompactionSummary>;
}

export interface ChatNeedsInputResult {
  readonly status: "needs_input";
  readonly sessionId: string;
  readonly message: string;
  readonly requiredInputs: ReadonlyArray<ChatInputRequirement>;
}

export interface ChatNeedsConfirmationResult {
  readonly status: "needs_confirmation";
  readonly sessionId: string;
  readonly message: string;
  readonly pendingActions: ReadonlyArray<ChatPendingAction>;
}

export interface ChatFailedResult {
  readonly status: "failed";
  readonly stage: ChatFailureStage;
  readonly message: string;
  readonly sessionId?: string;
}

export type ChatCommandResult =
  | ChatUnavailableResult
  | ChatCompletedResult
  | ChatNeedsInputResult
  | ChatNeedsConfirmationResult
  | ChatFailedResult;
