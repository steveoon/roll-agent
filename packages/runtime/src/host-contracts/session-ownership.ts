export const SESSION_OWNER_LIVENESS = ["alive", "dead", "unknown"] as const;

/** Host-owned identity. Runtime deliberately does not interpret process IDs or OS tokens. */
export interface SessionOwnershipHost {
  readonly identity: string;
  readonly owner: {
    readonly kind: string;
    readonly label: string;
    readonly workspace?: string;
  };
  /** Only positive OS evidence may return dead. No TTL or PID-name heuristics. */
  probe(identity: string): (typeof SESSION_OWNER_LIVENESS)[number];
}
