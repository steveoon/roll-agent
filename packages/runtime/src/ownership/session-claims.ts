import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SessionOwnershipHost } from "../host-contracts/session-ownership.ts";

export const SESSION_OCCUPANCY_CAPABILITY = {
  version: 1,
  scope: "canonical-library-and-thread",
  claims: "sqlite-sidecar-cas",
  idleOwnership: true,
  forceTakeover: false,
  legacyWriters: "unverified-sequential-only",
} as const;

const claimSchema = z.object({
  thread_id: z.string(),
  claim_id: z.string(),
  identity: z.string(),
  owner_json: z.string(),
});
type Claim = z.infer<typeof claimSchema>;
const ownerSchema = z.object({
  kind: z.string(),
  label: z.string(),
  workspace: z.string().optional(),
});
function safeOwner(claim: Claim | undefined): z.infer<typeof ownerSchema> | undefined {
  if (claim === undefined) return undefined;
  try {
    return ownerSchema.parse(JSON.parse(claim.owner_json));
  } catch {
    return undefined;
  }
}
const MAINTENANCE = ""; // Valid thread IDs are nonempty; reserved for the library gate.

export class SessionOccupiedError extends Error {
  readonly details: {
    readonly reason: string;
    readonly threadId: string;
    readonly ownerKind?: string;
    readonly label?: string;
    readonly workspace?: string;
    readonly action: string;
  };
  constructor(threadId: string, claim?: Claim, reason = "session_occupied") {
    super("此会话正在另一个客户端中使用。请先退出该客户端的当前会话，再重新检测；两端请选择其一。");
    this.name = "SessionOccupiedError";
    const owner = safeOwner(claim);
    this.details = {
      reason,
      threadId,
      action: "close_other_client_and_retry",
      ...(owner !== undefined
        ? {
            ownerKind: owner.kind,
            label: owner.label,
            ...(owner.workspace === undefined ? {} : { workspace: owner.workspace }),
          }
        : {}),
    };
  }
}

/** Symlinks share the canonical SQLite journal. Hardlinks do not; reject before opening writable. */
export function canonicalSessionDatabasePath(path: string): string {
  if (!existsSync(path)) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new SessionOccupiedError("", undefined, "ambiguous_library_alias");
    }
    return resolve(realpathSync(dirname(path)), "threads.db");
  }
  const canonical = realpathSync(path);
  if (statSync(canonical).nlink > 1) {
    throw new SessionOccupiedError("", undefined, "ambiguous_library_alias");
  }
  return canonical;
}

export interface SessionClaim {
  readonly threadId: string;
  readonly token: string;
  assert(): void;
  release(): void;
}

/**
 * Cooperative local-process fencing. The sidecar is never unlinked/replaced. A dead process
 * cannot write; a live/unknown process is never reaped. This is not a distributed FS lock and
 * does not constrain old binaries or external effects surviving their parent process.
 */
export class SessionClaims {
  private readonly db: DatabaseSync;
  private readonly held = new Map<string, { readonly claim: Claim; references: number }>();
  private closed = false;
  readonly databasePath: string;

  constructor(path: string, privateHost: SessionOwnershipHost) {
    this.host = privateHost;
    if (!privateHost.identity) {
      throw new Error("Session ownership requires a verifiable host identity");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.databasePath = canonicalSessionDatabasePath(path);
    const sidecar = `${this.databasePath}.occupancy.sqlite`;
    this.db = new DatabaseSync(sidecar);
    try {
      if (process.platform !== "win32") chmodSync(sidecar, 0o600);
      this.db.exec(`PRAGMA busy_timeout = 15000;
      CREATE TABLE IF NOT EXISTS claims (
        thread_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL,
        identity TEXT NOT NULL, owner_json TEXT NOT NULL
      );`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private readonly host: SessionOwnershipHost;

  private read(threadId: string): Claim | undefined {
    const row = this.db.prepare("SELECT * FROM claims WHERE thread_id = ?").get(threadId);
    return row === undefined ? undefined : claimSchema.parse(row);
  }

  private checkOpen(): void {
    if (this.closed) throw new Error("Session claims are closed");
    // Detect newly introduced aliases before every admission/write, not only at startup.
    if (
      existsSync(this.databasePath) &&
      canonicalSessionDatabasePath(this.databasePath) !== this.databasePath
    ) {
      throw new SessionOccupiedError("", undefined, "ambiguous_library_alias");
    }
  }

  private reap(claim: Claim): boolean {
    let status: ReturnType<SessionOwnershipHost["probe"]> = "unknown";
    try {
      status = this.host.probe(claim.identity);
    } catch {
      /* Unknown is occupied. */
    }
    if (status !== "dead") return false;
    // OS probing is outside all SQLite transactions. The observed token is the CAS fence.
    this.db
      .prepare("DELETE FROM claims WHERE thread_id = ? AND claim_id = ?")
      .run(claim.thread_id, claim.claim_id);
    return true;
  }

  acquire(threadId: string): SessionClaim {
    if (!threadId) throw new Error("Thread ID must be nonempty");
    return this.acquireKey(threadId);
  }

  private acquireKey(threadId: string): SessionClaim {
    this.checkOpen();
    const current = this.held.get(threadId);
    if (current !== undefined) {
      this.assert(current.claim);
      current.references++;
      return this.handle(current.claim);
    }
    const claim: Claim = {
      thread_id: threadId,
      claim_id: randomUUID(),
      identity: this.host.identity,
      owner_json: JSON.stringify(this.host.owner),
    };
    for (let attempt = 0; attempt < 32; attempt++) {
      this.db.exec("BEGIN IMMEDIATE");
      let conflict: Claim | undefined;
      try {
        conflict =
          this.read(MAINTENANCE) ??
          (threadId === MAINTENANCE
            ? this.db
                .prepare("SELECT * FROM claims LIMIT 1")
                .all()
                .map((row) => claimSchema.parse(row))[0]
            : this.read(threadId));
        if (conflict === undefined) {
          this.db
            .prepare("INSERT INTO claims VALUES (?, ?, ?, ?)")
            .run(threadId, claim.claim_id, claim.identity, claim.owner_json);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      if (conflict === undefined) {
        this.held.set(threadId, { claim, references: 1 });
        return this.handle(claim);
      }
      if (!this.reap(conflict)) throw new SessionOccupiedError(threadId, conflict);
    }
    throw new SessionOccupiedError(threadId);
  }

  /** No writer can enter while maintenance owns this gate; any held writer blocks it. */
  maintenance(): SessionClaim {
    return this.acquireKey(MAINTENANCE);
  }

  private assert(claim: Claim): void {
    this.checkOpen();
    if (this.read(claim.thread_id)?.claim_id !== claim.claim_id) {
      throw new SessionOccupiedError(claim.thread_id, undefined, "stale_session_claim");
    }
  }

  private handle(claim: Claim): SessionClaim {
    let released = false;
    return {
      threadId: claim.thread_id,
      token: claim.claim_id,
      assert: () => {
        if (released) {
          throw new SessionOccupiedError(claim.thread_id, undefined, "stale_session_claim");
        }
        this.assert(claim);
      },
      release: () => {
        if (released) return;
        released = true;
        const current = this.held.get(claim.thread_id);
        if (current?.claim.claim_id !== claim.claim_id) return;
        current.references--;
        if (current.references !== 0) return;
        this.db
          .prepare("DELETE FROM claims WHERE thread_id = ? AND claim_id = ?")
          .run(claim.thread_id, claim.claim_id);
        this.held.delete(claim.thread_id);
      },
    };
  }

  /** Refuse to convert resource disposal into proof that unsettled sessions are safe. */
  close(): void {
    if (this.closed) return;
    if (this.held.size !== 0) {
      throw new Error("Cannot close ownership store with unsettled session claims");
    }
    this.db.close();
    this.closed = true;
  }
}
