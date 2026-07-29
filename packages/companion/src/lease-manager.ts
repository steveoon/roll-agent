export const COMPANION_LEASE_KINDS = ["client", "turn", "shell-session", "approval"] as const;

export type CompanionLeaseKind = (typeof COMPANION_LEASE_KINDS)[number];

export interface CompanionLease {
  readonly kind: CompanionLeaseKind;
  readonly id: string;
}

function leaseKey(lease: CompanionLease): string {
  return `${lease.kind}:${lease.id}`;
}

export class WorkspaceLeaseManager {
  private readonly leases = new Map<string, CompanionLease>();

  acquire(lease: CompanionLease): () => void {
    const key = leaseKey(lease);
    this.leases.set(key, lease);
    return () => {
      this.leases.delete(key);
    };
  }

  release(lease: CompanionLease): boolean {
    return this.leases.delete(leaseKey(lease));
  }

  releaseClient(clientId: string): boolean {
    return this.release({ kind: "client", id: clientId });
  }

  has(lease: CompanionLease): boolean {
    return this.leases.has(leaseKey(lease));
  }

  canStopRuntime(): boolean {
    return this.leases.size === 0;
  }

  list(): readonly CompanionLease[] {
    return [...this.leases.values()];
  }
}
