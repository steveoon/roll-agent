export const SESSION_CANCELLATION_REASONS = {
  user: "user",
  timeout: "timeout",
  runtime: "runtime",
} as const;

export type SessionCancellationReason =
  (typeof SESSION_CANCELLATION_REASONS)[keyof typeof SESSION_CANCELLATION_REASONS];

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
