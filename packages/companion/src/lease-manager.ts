export const COMPANION_LEASE_KINDS = ["client", "turn", "shell-session", "approval"] as const;

export type CompanionLeaseKind = (typeof COMPANION_LEASE_KINDS)[number];

export interface CompanionLease {
  readonly kind: CompanionLeaseKind;
  readonly id: string;
}

function leaseKey(lease: CompanionLease): string {
  return `${lease.kind}:${lease.id}`;
}

interface CompanionLeaseAttachment {
  readonly lease: CompanionLease;
  readonly previous: CompanionLeaseAttachment | undefined;
  released: boolean;
}

export class WorkspaceLeaseManager {
  private readonly leases = new Map<string, CompanionLeaseAttachment>();

  acquire(lease: CompanionLease): () => void {
    const key = leaseKey(lease);
    const attachment: CompanionLeaseAttachment = {
      lease,
      previous: this.leases.get(key),
      released: false,
    };
    this.leases.set(key, attachment);
    return () => {
      if (attachment.released) {
        return;
      }
      attachment.released = true;
      if (this.leases.get(key) !== attachment) {
        return;
      }

      let replacement = attachment.previous;
      while (replacement?.released === true) {
        replacement = replacement.previous;
      }
      if (replacement === undefined) {
        this.leases.delete(key);
      } else {
        this.leases.set(key, replacement);
      }
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
    return [...this.leases.values()].map((attachment) => attachment.lease);
  }
}
