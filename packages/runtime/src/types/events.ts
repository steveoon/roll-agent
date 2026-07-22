import type { SessionCancellationReason } from "./cancellation.ts";
import type { ToolOutcome } from "../tool-bridge/normalize-result.ts";

export interface SessionTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export type SessionEventStage = "bootstrap" | "plan" | "execute";
export type SessionDebugStage = "turn" | "compaction" | "model" | "persist";
export type SessionDebugData = Readonly<Record<string, string | number | boolean>>;

export type SessionEvent =
  | {
      readonly type: "debug";
      readonly stage: SessionDebugStage;
      readonly message: string;
      readonly elapsedMs?: number;
      readonly data?: SessionDebugData;
    }
  | { readonly type: "message-start"; readonly messageId: string }
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "reasoning-start"; readonly reasoningId: string }
  | {
      readonly type: "reasoning-delta";
      readonly reasoningId: string;
      readonly delta: string;
    }
  | { readonly type: "reasoning-end"; readonly reasoningId: string }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly agentName: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly agentName: string;
      readonly toolName: string;
      /** Stable key for querying the typed, append-only execution record. */
      readonly executionId?: string;
      readonly outcome?: ToolOutcome;
      readonly display?: unknown;
      /** @deprecated Use `display`. */
      readonly output: unknown;
      /** @deprecated Derive control flow from `outcome`. */
      readonly isError: boolean;
    }
  | {
      readonly type: "tool-output-delta";
      readonly toolCallId: string;
      readonly agentName: string;
      readonly toolName: string;
      readonly stream: "stdout" | "stderr";
      readonly delta: string;
    }
  | {
      readonly type: "confirmation-required";
      readonly approvalId: string;
      readonly agentName: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly reason?: string;
    }
  | {
      readonly type: "step-finish";
      readonly finishReason: string;
      readonly usage?: SessionTokenUsage;
    }
  | {
      readonly type: "message-finish";
      readonly text: string;
      readonly totalUsage?: SessionTokenUsage;
      readonly sessionUsage?: SessionTokenUsage;
      readonly contextInputTokens?: number;
      readonly outputTokensPerSecond?: number;
      readonly stoppedAtStepLimit?: boolean;
    }
  | {
      readonly type: "compaction-start";
      readonly reason: ContextCompactionReason;
    }
  | {
      readonly type: "context-compacted";
      readonly reason: ContextCompactionReason;
      readonly strategy: ContextCompactionStrategy;
      readonly removed: number;
      readonly kept: number;
      readonly truncatedTools?: number;
      readonly beforeInputTokens?: number;
      readonly checkpointId?: string;
      readonly checkpointGeneration?: number;
      readonly checkpointSummaryStatus?: "valid" | "fallback" | "skipped";
    }
  | {
      readonly type: "turn-cancelled";
      readonly reason: SessionCancellationReason;
      readonly message: string;
      readonly execSessionIds?: readonly number[];
    }
  | { readonly type: "error"; readonly stage: SessionEventStage; readonly message: string };

export type ContextCompactionReason = "auto" | "manual";

export type ContextCompactionStrategy = "summarize" | "truncate";
