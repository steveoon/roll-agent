import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ToolActionApprovalSchema = z.object({
  id: z.string().trim().min(1),
});
export type ToolActionApproval = z.infer<typeof ToolActionApprovalSchema>;

export type ToolActionApprovalSubject = {
  readonly tool: string;
  readonly target: string;
  readonly digest: string;
  readonly summary?: string;
};

type PendingToolActionApproval = ToolActionApprovalSubject & {
  readonly id: string;
  readonly expiresAtMs: number;
};

export type ToolActionApprovalRequest = {
  readonly id: string;
  readonly expiresAt: string;
  readonly tool: string;
  readonly target: string;
  readonly summary?: string;
  readonly retryInput: {
    readonly toolActionApproval: ToolActionApproval;
  };
};

const pendingApprovals = new Map<string, PendingToolActionApproval>();

function pruneExpiredApprovals(nowMs = Date.now()): void {
  for (const [id, approval] of pendingApprovals) {
    if (approval.expiresAtMs <= nowMs) {
      pendingApprovals.delete(id);
    }
  }
}

function subjectMatchesApproval(
  subject: ToolActionApprovalSubject,
  approval: PendingToolActionApproval,
): boolean {
  return (
    subject.tool === approval.tool &&
    subject.target === approval.target &&
    subject.digest === approval.digest
  );
}

export function createToolActionApprovalRequest(
  subject: ToolActionApprovalSubject,
  ttlMs: number,
  nowMs = Date.now(),
): ToolActionApprovalRequest {
  pruneExpiredApprovals(nowMs);

  const id = randomUUID();
  const expiresAtMs = nowMs + ttlMs;
  pendingApprovals.set(id, {
    id,
    tool: subject.tool,
    target: subject.target,
    digest: subject.digest,
    ...(subject.summary !== undefined ? { summary: subject.summary } : {}),
    expiresAtMs,
  });

  return {
    id,
    expiresAt: new Date(expiresAtMs).toISOString(),
    tool: subject.tool,
    target: subject.target,
    ...(subject.summary !== undefined ? { summary: subject.summary } : {}),
    retryInput: {
      toolActionApproval: { id },
    },
  };
}

export function approveToolAction(input: {
  readonly approval: ToolActionApproval;
  readonly subject: ToolActionApprovalSubject;
}): boolean {
  pruneExpiredApprovals();

  if (!isToolActionApprovalValid(input)) {
    return false;
  }

  pendingApprovals.delete(input.approval.id);
  return true;
}

export function isToolActionApprovalValid(input: {
  readonly approval: ToolActionApproval;
  readonly subject: ToolActionApprovalSubject;
}): boolean {
  pruneExpiredApprovals();

  const pendingApproval = pendingApprovals.get(input.approval.id);
  if (pendingApproval === undefined) {
    return false;
  }

  if (!subjectMatchesApproval(input.subject, pendingApproval)) {
    return false;
  }

  return true;
}

export function resetToolActionApprovalsForTests(): void {
  pendingApprovals.clear();
}
