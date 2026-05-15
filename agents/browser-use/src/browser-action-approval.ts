import { randomUUID } from "node:crypto";
import type {
  BrowserActionApproval,
  BrowserActionApprovalValidationInput,
  BrowserActionPreflightDetails,
} from "@roll-agent/browser";

const BROWSER_ACTION_APPROVAL_TTL_MS = 60_000;

type PendingBrowserActionApproval = {
  readonly id: string;
  readonly action: string;
  readonly target: string;
  readonly url?: string;
  readonly expiresAtMs: number;
};

export type BrowserActionApprovalRequest = {
  readonly id: string;
  readonly expiresAt: string;
  readonly action: string;
  readonly target: string;
  readonly url?: string;
  readonly retryInput: {
    readonly browserActionApproval: BrowserActionApproval;
  };
};

const pendingApprovals = new Map<string, PendingBrowserActionApproval>();

function pruneExpiredApprovals(nowMs = Date.now()): void {
  for (const [id, approval] of pendingApprovals) {
    if (approval.expiresAtMs <= nowMs) {
      pendingApprovals.delete(id);
    }
  }
}

function detailsMatchApproval(
  details: BrowserActionPreflightDetails,
  approval: PendingBrowserActionApproval,
): boolean {
  return (
    details.action === approval.action &&
    details.target === approval.target &&
    (details.url ?? undefined) === (approval.url ?? undefined)
  );
}

export function createBrowserActionApprovalRequest(
  details: BrowserActionPreflightDetails,
  nowMs = Date.now(),
): BrowserActionApprovalRequest {
  pruneExpiredApprovals(nowMs);

  const id = randomUUID();
  const expiresAtMs = nowMs + BROWSER_ACTION_APPROVAL_TTL_MS;
  const pendingApproval: PendingBrowserActionApproval = {
    id,
    action: details.action,
    target: details.target,
    ...(details.url !== undefined ? { url: details.url } : {}),
    expiresAtMs,
  };
  pendingApprovals.set(id, pendingApproval);

  return {
    id,
    expiresAt: new Date(expiresAtMs).toISOString(),
    action: details.action,
    target: details.target,
    ...(details.url !== undefined ? { url: details.url } : {}),
    retryInput: {
      browserActionApproval: { id },
    },
  };
}

export function approveBrowserAction(input: BrowserActionApprovalValidationInput): boolean {
  pruneExpiredApprovals();

  const pendingApproval = pendingApprovals.get(input.approval.id);
  if (pendingApproval === undefined) {
    return false;
  }

  if (!detailsMatchApproval(input.details, pendingApproval)) {
    return false;
  }

  pendingApprovals.delete(input.approval.id);
  return true;
}

export function resetBrowserActionApprovalsForTests(): void {
  pendingApprovals.clear();
}
