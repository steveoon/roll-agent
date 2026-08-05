import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  normalizeUserInputResultForForm,
  type UserInputForm,
  type UserInputResult,
} from "@roll-agent/protocol";

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

export const sessionUserInputRequestIdSchema = z
  .string()
  .uuid()
  .brand<"SessionUserInputRequestId">();

export type SessionUserInputRequestId = z.output<typeof sessionUserInputRequestIdSchema>;

export interface SessionUserInputInteraction {
  readonly requestId: SessionUserInputRequestId;
  readonly form: UserInputForm;
  readonly expiresAt: string;
  readonly result: Promise<UserInputResult>;
}

interface PendingSessionUserInputInteraction {
  readonly requestId: SessionUserInputRequestId;
  readonly form: UserInputForm;
  readonly resolve: (result: UserInputResult) => void;
  readonly expiresAtMs: number;
  expiresTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Owns the engine-side lifetime of user input waits.
 *
 * Transport delivery has a separate InteractionId and is owned by
 * RuntimeClientRequestCoordinator. Keeping these identities separate prevents JSON-RPC delivery
 * retries from changing the model-visible tool invocation lifetime.
 */
export class UserInputInteractionManager {
  private readonly now: () => number;
  private readonly pending = new Map<
    SessionUserInputRequestId,
    PendingSessionUserInputInteraction
  >();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  request(form: UserInputForm, expiresAt: string): SessionUserInputInteraction {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error("user input expiresAt must be a valid ISO 8601 timestamp");
    }
    const requestId = sessionUserInputRequestIdSchema.parse(randomUUID());
    const deferred = Promise.withResolvers<UserInputResult>();
    const interaction: PendingSessionUserInputInteraction = {
      requestId,
      form,
      resolve: deferred.resolve,
      expiresAtMs,
      expiresTimer: undefined,
    };
    this.pending.set(requestId, interaction);
    this.scheduleExpiration(interaction, expiresAtMs);
    return { requestId, form, expiresAt, result: deferred.promise };
  }

  resolve(requestId: SessionUserInputRequestId, result: UserInputResult): boolean {
    const interaction = this.pending.get(requestId);
    if (interaction === undefined) {
      return false;
    }
    if (this.now() >= interaction.expiresAtMs) {
      this.settle(interaction.requestId, {
        status: "cancelled",
        reason: "用户输入请求已超时",
      });
      return false;
    }
    let normalized: UserInputResult;
    try {
      normalized = normalizeUserInputResultForForm(interaction.form, result);
    } catch {
      this.settle(interaction.requestId, {
        status: "cancelled",
        reason: "用户输入不符合原始表单约束",
      });
      return false;
    }
    return this.settle(requestId, normalized);
  }

  cancel(requestId: SessionUserInputRequestId, reason?: string): boolean {
    const normalizedReason = reason?.trim();
    return this.settle(requestId, {
      status: "cancelled",
      ...(normalizedReason ? { reason: normalizedReason } : {}),
    });
  }

  cancelAll(reason?: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.cancel(requestId, reason);
    }
  }

  private settle(requestId: SessionUserInputRequestId, result: UserInputResult): boolean {
    const interaction = this.pending.get(requestId);
    if (interaction === undefined) {
      return false;
    }
    this.pending.delete(requestId);
    if (interaction.expiresTimer !== undefined) {
      clearTimeout(interaction.expiresTimer);
      interaction.expiresTimer = undefined;
    }
    interaction.resolve(result);
    return true;
  }

  private scheduleExpiration(
    interaction: PendingSessionUserInputInteraction,
    expiresAtMs: number,
  ): void {
    const remainingMs = expiresAtMs - this.now();
    if (remainingMs <= 0) {
      this.cancel(interaction.requestId, "用户输入请求已超时");
      return;
    }
    interaction.expiresTimer = setTimeout(
      () => {
        interaction.expiresTimer = undefined;
        if (this.pending.get(interaction.requestId) !== interaction) {
          return;
        }
        if (this.now() >= expiresAtMs) {
          this.cancel(interaction.requestId, "用户输入请求已超时");
        } else {
          this.scheduleExpiration(interaction, expiresAtMs);
        }
      },
      Math.min(remainingMs, MAX_TIMEOUT_DELAY_MS),
    );
  }
}
