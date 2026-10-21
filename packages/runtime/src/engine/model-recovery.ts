import { setTimeout as delay } from "node:timers/promises";

/** Opt-in, process-local host policy. Runtime alone owns retry admission and the turn budget. */
export interface ModelTurnRecovery {
  readonly isRecoverable: (error: unknown) => boolean;
  readonly prepare: (signal: AbortSignal) => Promise<void>;
  readonly onTurnStart?: () => void;
  readonly onRecovering?: () => void;
  readonly onTurnEnd?: (error?: unknown) => void;
  readonly formatError?: (error: unknown) => string;
}

export class ModelRecoveryBudget {
  private used = 0;
  private readonly policy: ModelTurnRecovery;
  private readonly delays: readonly number[];

  constructor(
    policy: ModelTurnRecovery,
    delays: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000],
  ) {
    this.policy = policy;
    this.delays = delays;
  }

  async attempt(
    initialError: unknown,
    signal: AbortSignal,
    onAttempt: (attempt: number) => void,
  ): Promise<
    { readonly recovered: true } | { readonly recovered: false; readonly error: unknown }
  > {
    let error = initialError;
    while (this.policy.isRecoverable(error)) {
      signal.throwIfAborted();
      const ms = this.delays[this.used];
      if (ms === undefined) break;
      this.used += 1;
      this.policy.onRecovering?.();
      onAttempt(this.used);
      await delay(ms, undefined, { signal });
      try {
        await this.policy.prepare(signal);
        signal.throwIfAborted();
        return { recovered: true };
      } catch (cause) {
        signal.throwIfAborted();
        error = cause;
      }
    }
    return { recovered: false, error };
  }
}
