export interface SessionTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export type SessionEventStage = "bootstrap" | "plan" | "execute";

export type SessionEvent =
  | { readonly type: "message-start"; readonly messageId: string }
  | { readonly type: "text-delta"; readonly delta: string }
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
      readonly output: unknown;
      readonly isError: boolean;
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
    }
  | { readonly type: "error"; readonly stage: SessionEventStage; readonly message: string };
