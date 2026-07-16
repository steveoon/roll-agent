import { randomUUID } from "node:crypto";
import type { ReplyGateAdvisoryCode, ReplyVariantKind } from "@roll-agent/reply-authority-client";
import {
  PreparedReplyOptionValues,
  type PreparedReplyFallbackReason,
  type PreparedReplyJudgement,
  type PreparedReplyOption,
} from "./prepared-reply-decision.ts";
import type { PreparedReplyJudgeContext } from "./prepared-reply-judge-context.ts";

export { PreparedReplyOptionValues };
export type { PreparedReplyOption };

export type PreparedReplyVariantOption = {
  readonly option: PreparedReplyOption;
  readonly variant: ReplyVariantKind;
  readonly suggestedReply: string;
  readonly signedEnvelope: string;
  readonly envelopeExp: number;
};

export type PreparedReplyVariantFinding = {
  readonly code: ReplyGateAdvisoryCode;
  readonly description: string;
};

type PreparedReplyVariantGroupBase = {
  readonly groupId: string;
  readonly rubricVersion: string;
  readonly rubricHash: string;
  readonly feedbackExpiresAt?: number;
  readonly target: {
    readonly platform: "zhipin";
    readonly tenantId: string;
    readonly conversationId: string;
  };
};

export type PreparedReplyVariantGroup =
  | (PreparedReplyVariantGroupBase & {
      readonly state: "judge_ready";
      readonly options: readonly PreparedReplyVariantOption[];
      readonly findings: readonly PreparedReplyVariantFinding[];
      readonly recommendedOption: PreparedReplyOption;
      readonly judgeContext: PreparedReplyJudgeContext;
    })
  | (PreparedReplyVariantGroupBase & {
      readonly state: "not_learned";
      readonly chosenVariant: "draft";
      readonly reason: PreparedReplyFallbackReason;
    });

export type PreparedReplyRecord = {
  readonly preparedReplyId: string;
  readonly signedEnvelope: string;
  readonly suggestedReply: string;
  readonly stage: string;
  readonly confidence: number;
  readonly expiresAt: number;
  readonly requestId?: string;
  readonly unreadCountBeforeReply?: number;
  readonly variantGroup?: PreparedReplyVariantGroup;
  readonly judgement?: PreparedReplyJudgement;
};

type StoredPreparedReply = PreparedReplyRecord & {
  readonly consumed: boolean;
};

export type PreparedReplyConsumeResult =
  | { readonly ok: true; readonly record: PreparedReplyRecord }
  | { readonly ok: false; readonly reason: "not_found" | "expired" | "consumed" };

export type PreparedReplyInspectResult = PreparedReplyConsumeResult;

export type PreparedReplyJudgementUpdateResult = PreparedReplyConsumeResult;

let preparedReplies = new Map<string, StoredPreparedReply>();

function pruneExpiredPreparedReplies(nowSeconds: number): void {
  for (const [preparedReplyId, record] of preparedReplies) {
    if (record.expiresAt <= nowSeconds) {
      preparedReplies.delete(preparedReplyId);
    }
  }
}

export function savePreparedReply(
  input: Omit<PreparedReplyRecord, "preparedReplyId">,
  nowSeconds = Math.floor(Date.now() / 1000),
): PreparedReplyRecord {
  pruneExpiredPreparedReplies(nowSeconds);
  if (input.expiresAt <= nowSeconds) {
    throw new Error("Prepared reply 已过期，禁止保存。");
  }

  const preparedReplyId = `prep_${randomUUID()}`;
  const record = {
    preparedReplyId,
    ...input,
  };
  preparedReplies.set(preparedReplyId, { ...record, consumed: false });
  return record;
}

export function consumePreparedReply(
  preparedReplyId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): PreparedReplyConsumeResult {
  const record = preparedReplies.get(preparedReplyId);
  if (record === undefined) {
    pruneExpiredPreparedReplies(nowSeconds);
    return { ok: false, reason: "not_found" };
  }

  if (record.expiresAt <= nowSeconds) {
    preparedReplies.delete(preparedReplyId);
    pruneExpiredPreparedReplies(nowSeconds);
    return { ok: false, reason: "expired" };
  }

  if (record.consumed) {
    return { ok: false, reason: "consumed" };
  }

  preparedReplies.set(preparedReplyId, { ...record, consumed: true });
  return {
    ok: true,
    record: toPreparedReplyRecord(record),
  };
}

export function inspectPreparedReply(
  preparedReplyId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): PreparedReplyInspectResult {
  const record = preparedReplies.get(preparedReplyId);
  if (record === undefined) {
    pruneExpiredPreparedReplies(nowSeconds);
    return { ok: false, reason: "not_found" };
  }

  if (record.expiresAt <= nowSeconds) {
    preparedReplies.delete(preparedReplyId);
    pruneExpiredPreparedReplies(nowSeconds);
    return { ok: false, reason: "expired" };
  }

  if (record.consumed) {
    return { ok: false, reason: "consumed" };
  }

  return {
    ok: true,
    record: toPreparedReplyRecord(record),
  };
}

export function setPreparedReplyJudgement(
  preparedReplyId: string,
  judgement: PreparedReplyJudgement,
  nowSeconds = Math.floor(Date.now() / 1000),
): PreparedReplyJudgementUpdateResult {
  const inspected = inspectPreparedReply(preparedReplyId, nowSeconds);
  if (!inspected.ok) {
    return inspected;
  }

  const stored = preparedReplies.get(preparedReplyId);
  if (stored === undefined) {
    return { ok: false, reason: "not_found" };
  }
  preparedReplies.set(preparedReplyId, { ...stored, judgement });
  return {
    ok: true,
    record: toPreparedReplyRecord({ ...stored, judgement }),
  };
}

function toPreparedReplyRecord(record: StoredPreparedReply): PreparedReplyRecord {
  return {
    preparedReplyId: record.preparedReplyId,
    signedEnvelope: record.signedEnvelope,
    suggestedReply: record.suggestedReply,
    stage: record.stage,
    confidence: record.confidence,
    expiresAt: record.expiresAt,
    ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
    ...(record.unreadCountBeforeReply !== undefined
      ? { unreadCountBeforeReply: record.unreadCountBeforeReply }
      : {}),
    ...(record.variantGroup !== undefined ? { variantGroup: record.variantGroup } : {}),
    ...(record.judgement !== undefined ? { judgement: record.judgement } : {}),
  };
}

export function resetPreparedReplyStoreForTests(): void {
  preparedReplies = new Map<string, StoredPreparedReply>();
}
