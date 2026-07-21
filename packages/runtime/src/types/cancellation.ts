import type { AssistantModelMessage, ModelMessage } from "ai";
import { z } from "zod";

export const SESSION_CANCELLATION_REASONS = {
  user: "user",
  timeout: "timeout",
  runtime: "runtime",
} as const;

export type SessionCancellationReason =
  (typeof SESSION_CANCELLATION_REASONS)[keyof typeof SESSION_CANCELLATION_REASONS];

const TURN_CANCELLATION_METADATA = {
  providerKey: "rollHarness",
  checkpointKey: "turnCancellation",
  version: 1,
  kind: "turn-cancellation",
} as const;

export const turnCancellationMetadataV1Schema = z
  .object({
    version: z.literal(TURN_CANCELLATION_METADATA.version),
    kind: z.literal(TURN_CANCELLATION_METADATA.kind),
    reason: z.enum([
      SESSION_CANCELLATION_REASONS.user,
      SESSION_CANCELLATION_REASONS.timeout,
      SESSION_CANCELLATION_REASONS.runtime,
    ]),
  })
  .readonly();

export function createTurnCancellationMessage(
  content: string,
  reason: SessionCancellationReason,
): AssistantModelMessage {
  return {
    role: "assistant",
    content,
    providerOptions: {
      [TURN_CANCELLATION_METADATA.providerKey]: {
        [TURN_CANCELLATION_METADATA.checkpointKey]: {
          version: TURN_CANCELLATION_METADATA.version,
          kind: TURN_CANCELLATION_METADATA.kind,
          reason,
        },
      },
    },
  };
}

export function readTurnCancellationReason(
  message: ModelMessage,
): SessionCancellationReason | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  const value =
    message.providerOptions?.[TURN_CANCELLATION_METADATA.providerKey]?.[
      TURN_CANCELLATION_METADATA.checkpointKey
    ];
  const parsed = turnCancellationMetadataV1Schema.safeParse(value);
  return parsed.success ? parsed.data.reason : undefined;
}

export function stripTurnCancellationMetadata(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (readTurnCancellationReason(message) === undefined) {
      return message;
    }
    const providerOptions = { ...message.providerOptions };
    const harness = { ...providerOptions[TURN_CANCELLATION_METADATA.providerKey] };
    delete harness[TURN_CANCELLATION_METADATA.checkpointKey];
    if (Object.keys(harness).length === 0) {
      delete providerOptions[TURN_CANCELLATION_METADATA.providerKey];
    } else {
      providerOptions[TURN_CANCELLATION_METADATA.providerKey] = harness;
    }
    if (Object.keys(providerOptions).length === 0) {
      const sanitized: ModelMessage = { ...message };
      delete sanitized.providerOptions;
      return sanitized;
    }
    return { ...message, providerOptions };
  });
}

export const USER_CANCELLATION_ABORT_REASON = "roll:user-cancelled";
export const RUNTIME_CANCELLATION_ABORT_REASON = "roll:runtime-aborted";
export const TURN_TIMEOUT_ABORT_REASON = "roll:turn-timeout";

export function isTurnTimeoutAbortReason(reason: unknown): boolean {
  return reason === TURN_TIMEOUT_ABORT_REASON;
}

export function isTimeoutAbortReason(reason: unknown): boolean {
  return (
    isTurnTimeoutAbortReason(reason) ||
    (reason instanceof DOMException && reason.name === "TimeoutError")
  );
}

export function isUserCancellationSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === USER_CANCELLATION_ABORT_REASON;
}
