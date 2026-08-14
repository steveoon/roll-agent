export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
  readonly scope?: "once" | "session";
}

type Resolver = (decision: ApprovalDecision) => void;

export class ApprovalGate {
  private readonly pending = new Map<string, Resolver>();

  request(approvalId: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(approvalId, resolve);
    });
  }

  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const resolver = this.pending.get(approvalId);
    if (!resolver) {
      return false;
    }
    this.pending.delete(approvalId);
    resolver(decision);
    return true;
  }

  abortAll(reason = "aborted"): void {
    for (const resolver of this.pending.values()) {
      resolver({ approved: false, reason });
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
