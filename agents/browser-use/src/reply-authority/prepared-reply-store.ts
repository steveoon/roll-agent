import { randomUUID } from "node:crypto";

export type PreparedReplyRecord = {
  readonly preparedReplyId: string;
  readonly signedEnvelope: string;
  readonly suggestedReply: string;
  readonly stage: string;
  readonly confidence: number;
  readonly expiresAt: number;
  readonly requestId?: string;
  readonly unreadCountBeforeReply?: number;
};

type StoredPreparedReply = PreparedReplyRecord & {
  readonly consumed: boolean;
};

export type PreparedReplyConsumeResult =
  | { readonly ok: true; readonly record: PreparedReplyRecord }
  | { readonly ok: false; readonly reason: "not_found" | "expired" | "consumed" };

export type PreparedReplyInspectResult = PreparedReplyConsumeResult;

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
  };
}

export function resetPreparedReplyStoreForTests(): void {
  preparedReplies = new Map<string, StoredPreparedReply>();
}
