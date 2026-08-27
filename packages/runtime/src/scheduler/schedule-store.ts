import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expandTilde } from "../store/thread-store.ts";
import { SCHEDULER_LIMITS } from "./limits.ts";
import {
  TRIGGER_KINDS,
  computeNextRunAtMs,
  parseTriggerJson,
  triggerSpecSchema,
  type TriggerSpec,
} from "./trigger.ts";
import {
  CANCEL_INVOCATION_OUTCOMES,
  COMPLETE_INVOCATION_OUTCOMES,
  EXECUTOR_LIVENESS,
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_LIVE_STATUSES,
  INVOCATION_MODES,
  INVOCATION_STATUSES,
  INVOCATION_TERMINAL_STATUSES,
  INVOCATION_TREE_LIVENESS,
  TRACKED_LEADER_STATES,
  SCHEDULE_STATUSES,
  SCHEDULE_STORE_ERROR_CODES,
  ScheduleStoreError,
  type CancelInvocationOptions,
  type CancelInvocationOutcome,
  type ClaimedInvocation,
  type CompleteInvocationInput,
  type CompleteInvocationOutcome,
  type CreateScheduleInput,
  type EnqueueManualInvocationOptions,
  type ExecutorIdentity,
  type ExecutorLiveness,
  type ExecutorLivenessProbe,
  type FailInvocationOptions,
  type FinalizeCancellationInput,
  type InvocationFailureOutcome,
  type InvocationMode,
  type InvocationRecord,
  type InvocationStatus,
  type InvocationTreeLivenessProbe,
  type PersistedTrackedGroup,
  type RecordInvocationTreeInput,
  type RemoveScheduleOptions,
  type ScheduleRecord,
  type ScheduleStatus,
} from "./types.ts";

const SCHEMA_VERSION = 4;
const BUSY_TIMEOUT_MS = 15_000;
const TERMINAL_STATUS_PLACEHOLDERS = INVOCATION_TERMINAL_STATUSES.map(() => "?").join(", ");

const LIVENESS_PROBE_RESULTS = {
  dead: "dead",
  notDead: "not-dead",
  deferred: "deferred",
} as const;
type LivenessProbeResult = (typeof LIVENESS_PROBE_RESULTS)[keyof typeof LIVENESS_PROBE_RESULTS];

const TRACKED_GROUP_PARSE_RESULTS = {
  valid: "valid",
  invalid: "invalid",
} as const;
type TrackedGroupParseResult =
  | {
      readonly kind: typeof TRACKED_GROUP_PARSE_RESULTS.valid;
      readonly groups: readonly PersistedTrackedGroup[];
    }
  | { readonly kind: typeof TRACKED_GROUP_PARSE_RESULTS.invalid };

function unsupportedSchemaVersionError(version: number): Error {
  return new Error(
    `ScheduleStore schema v${String(version)} 高于当前支持的 v${String(SCHEMA_VERSION)}`,
  );
}

function validateAuthoritativeSchedulerDatabase(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get() as { readonly user_version: number };
  if (version.user_version > SCHEMA_VERSION) {
    throw unsupportedSchemaVersionError(version.user_version);
  }
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('schedules', 'invocations')",
    )
    .all() as Array<{ readonly name: string }>;
  const names = new Set(tables.map((row) => row.name));
  if (version.user_version < 1 || !names.has("schedules") || !names.has("invocations")) {
    throw new Error("not a valid authoritative scheduler database");
  }
}

export interface ScheduleStoreOptions {
  readonly maxSchedules?: number;
  readonly claimLeaseMs?: number;
  readonly retryBudget?: number;
  readonly retryBackoffMs?: number;
  readonly executorLiveness?: ExecutorLivenessProbe;
  readonly treeLiveness?: InvocationTreeLivenessProbe;
  readonly maxLivenessProbesPerClaim?: number;
  readonly livenessProbeDeferralMs?: number;
  readonly invocationRetentionPerSchedule?: number;
  readonly invocationRetentionMs?: number;
  readonly requireExistingDatabase?: boolean;
}

interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger_json: string;
  readonly status: string;
  readonly authority_digest: string | null;
  readonly next_run_at: number | null;
  readonly last_run_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface InvocationRow {
  readonly id: string;
  readonly schedule_id: string;
  readonly mode: string;
  readonly status: string;
  readonly scheduled_for: number;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly executor_pid: number | null;
  readonly executor_start_token: string | null;
  readonly executor_probed_at: number | null;
  readonly claimed_by: string | null;
  readonly ownership_token: string | null;
  readonly lease_until: number | null;
  readonly retry_at: number | null;
  readonly thread_id: string | null;
  readonly output_excerpt: string | null;
  readonly error: string | null;
  readonly pending_actions_json: string;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  readonly tree_tracked_pgids: string | null;
  readonly tree_unsettled: number | null;
  readonly tree_survivor_pids: string | null;
}

const INVOCATION_MODE_VALUES: readonly string[] = Object.values(INVOCATION_MODES);
const INVOCATION_STATUS_VALUES: readonly string[] = Object.values(INVOCATION_STATUSES);

function isInvocationMode(value: string): value is InvocationMode {
  return INVOCATION_MODE_VALUES.includes(value);
}

function isInvocationStatus(value: string): value is InvocationStatus {
  return INVOCATION_STATUS_VALUES.includes(value);
}

function parsePendingActions(json: string): readonly string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parsePidList(json: string | null): readonly number[] {
  return parseTrackedGroups(json).map((group) => group.pgid);
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isTrackedLeaderState(value: unknown): value is PersistedTrackedGroup["leaderState"] {
  return (
    value === TRACKED_LEADER_STATES.alive ||
    value === TRACKED_LEADER_STATES.exited ||
    value === TRACKED_LEADER_STATES.unknown
  );
}

function parseTrackedGroup(value: unknown): PersistedTrackedGroup | undefined {
  if (isPositivePid(value)) {
    return { pgid: value, leaderState: TRACKED_LEADER_STATES.unknown };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("pgid" in value) ||
    !isPositivePid(value.pgid) ||
    !("leaderState" in value) ||
    !isTrackedLeaderState(value.leaderState)
  ) {
    return undefined;
  }
  if (!("startToken" in value)) {
    return { pgid: value.pgid, leaderState: value.leaderState };
  }
  return typeof value.startToken === "string" && value.startToken.length > 0
    ? { pgid: value.pgid, leaderState: value.leaderState, startToken: value.startToken }
    : undefined;
}

function parseTrackedGroupsResult(json: string | null): TrackedGroupParseResult {
  if (json === null) {
    return { kind: TRACKED_GROUP_PARSE_RESULTS.valid, groups: [] };
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return { kind: TRACKED_GROUP_PARSE_RESULTS.invalid };
    }
    const byPgid = new Map<number, PersistedTrackedGroup>();
    for (const item of parsed) {
      const group = parseTrackedGroup(item);
      if (group === undefined) {
        return { kind: TRACKED_GROUP_PARSE_RESULTS.invalid };
      }
      byPgid.set(group.pgid, group);
    }
    return { kind: TRACKED_GROUP_PARSE_RESULTS.valid, groups: [...byPgid.values()] };
  } catch {
    return { kind: TRACKED_GROUP_PARSE_RESULTS.invalid };
  }
}

function invalidTreeOwnershipMetadataError(): ScheduleStoreError {
  return new ScheduleStoreError(
    SCHEDULE_STORE_ERROR_CODES.invalid,
    "进程树所有权元数据无效；拒绝按空树继续，仅可显式 --abandon 放弃追踪",
  );
}

function parseTrackedGroups(json: string | null): readonly PersistedTrackedGroup[] {
  const result = parseTrackedGroupsResult(json);
  if (result.kind === TRACKED_GROUP_PARSE_RESULTS.invalid) {
    throw invalidTreeOwnershipMetadataError();
  }
  return result.groups;
}

function encodeTrackedGroups(groups: readonly PersistedTrackedGroup[]): string {
  const byPgid = new Map<number, PersistedTrackedGroup>();
  for (const group of groups) {
    if (!Number.isInteger(group.pgid) || group.pgid <= 0) {
      continue;
    }
    byPgid.set(
      group.pgid,
      group.startToken !== undefined && group.startToken.length > 0
        ? { pgid: group.pgid, leaderState: group.leaderState, startToken: group.startToken }
        : { pgid: group.pgid, leaderState: group.leaderState },
    );
  }
  return JSON.stringify([...byPgid.values()]);
}

function resolveTrackedGroups(
  trackedGroups: readonly PersistedTrackedGroup[] | undefined,
  trackedPgids: readonly number[] | undefined,
): readonly PersistedTrackedGroup[] {
  if (trackedGroups !== undefined) {
    return trackedGroups;
  }
  return (trackedPgids ?? []).map((pgid) => ({
    pgid,
    leaderState: TRACKED_LEADER_STATES.unknown,
  }));
}

function encodePidList(pids: readonly number[]): string {
  return JSON.stringify([...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))]);
}

const OCCUPYING_RUN_SQL = `(status IN (?, ?) OR (status = ? AND (tree_unsettled = 1 OR (tree_tracked_pgids IS NOT NULL AND trim(tree_tracked_pgids) != '[]'))))`;
const OCCUPYING_RUN_PARAMS = [
  INVOCATION_STATUSES.claimed,
  INVOCATION_STATUSES.running,
  INVOCATION_STATUSES.retry,
] as const;

function toExecutorIdentity(row: InvocationRow): ExecutorIdentity | undefined {
  return row.executor_pid !== null && row.executor_start_token !== null
    ? { pid: row.executor_pid, startToken: row.executor_start_token }
    : undefined;
}

function toInvocationRecord(row: InvocationRow): InvocationRecord {
  if (!isInvocationMode(row.mode) || !isInvocationStatus(row.status)) {
    throw new ScheduleStoreError(
      SCHEDULE_STORE_ERROR_CODES.invalid,
      `invocation ${row.id} 的 mode/status 非法: ${row.mode}/${row.status}`,
    );
  }
  const treeTrackedGroups = parseTrackedGroups(row.tree_tracked_pgids);
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    mode: row.mode,
    status: row.status,
    scheduledForMs: row.scheduled_for,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    executor: toExecutorIdentity(row),
    claimedBy: row.claimed_by ?? undefined,
    leaseUntilMs: row.lease_until ?? undefined,
    retryAtMs: row.retry_at ?? undefined,
    threadId: row.thread_id ?? undefined,
    outputExcerpt: row.output_excerpt ?? undefined,
    error: row.error ?? undefined,
    pendingActions: parsePendingActions(row.pending_actions_json),
    treeTrackedPgids: treeTrackedGroups.map((group) => group.pgid),
    treeTrackedGroups,
    treeUnsettled: row.tree_unsettled === 1,
    treeSurvivorPids: parsePidList(row.tree_survivor_pids),
    createdAtMs: row.created_at,
    startedAtMs: row.started_at ?? undefined,
    finishedAtMs: row.finished_at ?? undefined,
  };
}

export interface ClaimDueInput {
  readonly workerId: string;
  readonly nowMs: number;
  readonly limit: number;
  readonly heldInvocationIds?: ReadonlySet<string>;
}

interface LiveInvocationRow extends InvocationRow {
  readonly schedule_status: string;
}

function isScheduleStatus(value: string): value is ScheduleStatus {
  return value === SCHEDULE_STATUSES.active || value === SCHEDULE_STATUSES.paused;
}

function toScheduleRecord(row: ScheduleRow): ScheduleRecord {
  if (!isScheduleStatus(row.status)) {
    throw new ScheduleStoreError(
      SCHEDULE_STORE_ERROR_CODES.invalid,
      `schedule ${row.id} 的 status 非法: ${row.status}`,
    );
  }
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cwd: row.cwd,
    trigger: parseTriggerJson(row.trigger_json),
    status: row.status,
    authorityDigest: row.authority_digest ?? undefined,
    nextRunAtMs: row.next_run_at ?? undefined,
    lastRunAtMs: row.last_run_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}

function validateCreateInput(input: CreateScheduleInput): {
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger: TriggerSpec;
} {
  const name = input.name.trim();
  if (name.length === 0 || name.length > SCHEDULER_LIMITS.maxNameChars) {
    throw new ScheduleStoreError(
      SCHEDULE_STORE_ERROR_CODES.invalid,
      `name 必须为 1..${String(SCHEDULER_LIMITS.maxNameChars)} 个字符`,
    );
  }
  const prompt = input.prompt.trim();
  if (prompt.length === 0 || prompt.length > SCHEDULER_LIMITS.maxPromptChars) {
    throw new ScheduleStoreError(
      SCHEDULE_STORE_ERROR_CODES.invalid,
      `prompt 必须为 1..${String(SCHEDULER_LIMITS.maxPromptChars)} 个字符`,
    );
  }
  if (!isAbsolute(input.cwd)) {
    throw new ScheduleStoreError(SCHEDULE_STORE_ERROR_CODES.invalid, "cwd 必须是绝对路径");
  }
  const trigger = triggerSpecSchema.safeParse(input.trigger);
  if (!trigger.success) {
    throw new ScheduleStoreError(SCHEDULE_STORE_ERROR_CODES.invalid, "trigger 不合法");
  }
  return { name, prompt, cwd: input.cwd, trigger: trigger.data };
}

export class ScheduleStore {
  private readonly db: DatabaseSync;
  private readonly maxSchedules: number;
  private readonly claimLeaseMs: number;
  private readonly retryBudget: number;
  private readonly retryBackoffMs: number;
  private readonly executorLiveness: ExecutorLivenessProbe;
  private readonly treeLiveness: InvocationTreeLivenessProbe | undefined;
  private readonly maxLivenessProbesPerClaim: number;
  private readonly livenessProbeDeferralMs: number;
  private readonly invocationRetentionPerSchedule: number;
  private readonly invocationRetentionMs: number;

  constructor(dir: string, options: ScheduleStoreOptions = {}) {
    this.maxSchedules = options.maxSchedules ?? 50;
    this.claimLeaseMs = options.claimLeaseMs ?? SCHEDULER_LIMITS.claimLeaseMs;
    this.retryBudget = options.retryBudget ?? SCHEDULER_LIMITS.retryBudget;
    this.retryBackoffMs = options.retryBackoffMs ?? SCHEDULER_LIMITS.retryBackoffMs;
    this.executorLiveness = options.executorLiveness ?? (() => EXECUTOR_LIVENESS.unknown);
    this.treeLiveness = options.treeLiveness;
    this.maxLivenessProbesPerClaim =
      options.maxLivenessProbesPerClaim ?? SCHEDULER_LIMITS.maxLivenessProbesPerClaim;
    this.livenessProbeDeferralMs =
      options.livenessProbeDeferralMs ?? SCHEDULER_LIMITS.livenessProbeDeferralMs;
    this.invocationRetentionPerSchedule =
      options.invocationRetentionPerSchedule ?? SCHEDULER_LIMITS.invocationRetentionPerSchedule;
    this.invocationRetentionMs =
      options.invocationRetentionMs ?? SCHEDULER_LIMITS.invocationRetentionMs;
    const resolved = expandTilde(dir);
    if (options.requireExistingDatabase === true && !existsSync(resolved)) {
      throw new Error("authoritative scheduler database does not exist");
    }
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") {
      chmodSync(resolved, 0o700);
    }
    const databasePath = resolve(resolved, "schedules.db");
    if (options.requireExistingDatabase === true && !existsSync(databasePath)) {
      throw new Error("authoritative scheduler database does not exist");
    }
    this.db = new DatabaseSync(databasePath);
    if (options.requireExistingDatabase === true) {
      try {
        this.db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
        validateAuthoritativeSchedulerDatabase(this.db);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    if (process.platform !== "win32") {
      try {
        chmodSync(databasePath, 0o600);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.init();
  }

  private init(): void {
    this.db.exec(
      `PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)};
       PRAGMA foreign_keys = ON;
       PRAGMA secure_delete = ON;`,
    );
    const versionRow = this.db.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    if (versionRow.user_version > SCHEMA_VERSION) {
      throw unsupportedSchemaVersionError(versionRow.user_version);
    }
    this.transaction(() => {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS schedules (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           prompt TEXT NOT NULL,
           cwd TEXT NOT NULL,
           trigger_json TEXT NOT NULL,
           status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
           authority_digest TEXT,
           next_run_at INTEGER,
           last_run_at INTEGER,
           last_error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS invocations (
           id TEXT PRIMARY KEY,
           schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
           mode TEXT NOT NULL CHECK (mode IN ('scheduled', 'manual')),
           status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'running', 'retry', 'completed', 'needs_confirmation', 'failed')),
           scheduled_for INTEGER NOT NULL,
           attempt INTEGER NOT NULL DEFAULT 0,
           max_attempts INTEGER NOT NULL DEFAULT ${String(SCHEDULER_LIMITS.retryBudget)},
           executor_pid INTEGER,
           executor_start_token TEXT,
           executor_probed_at INTEGER,
           claimed_by TEXT,
           ownership_token TEXT,
           lease_until INTEGER,
           retry_at INTEGER,
           thread_id TEXT,
           output_excerpt TEXT,
           error TEXT,
           pending_actions_json TEXT NOT NULL DEFAULT '[]',
           created_at INTEGER NOT NULL,
           started_at INTEGER,
           finished_at INTEGER,
           tree_tracked_pgids TEXT,
           tree_unsettled INTEGER NOT NULL DEFAULT 0,
           tree_survivor_pids TEXT,
           UNIQUE (schedule_id, mode, scheduled_for)
         );
         CREATE INDEX IF NOT EXISTS idx_schedules_due
           ON schedules (next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_invocations_live
           ON invocations (schedule_id) WHERE status IN ('pending', 'claimed', 'running', 'retry');`,
      );
      if (versionRow.user_version < SCHEMA_VERSION) {
        this.addMissingColumns();
      }
      this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)};`);
    });
  }

  private addMissingColumns(): void {
    const additions = [
      { table: "schedules", column: "authority_digest", definition: "TEXT" },
      {
        table: "invocations",
        column: "max_attempts",
        definition: `INTEGER NOT NULL DEFAULT ${String(SCHEDULER_LIMITS.retryBudget)}`,
      },
      { table: "invocations", column: "executor_pid", definition: "INTEGER" },
      { table: "invocations", column: "executor_start_token", definition: "TEXT" },
      { table: "invocations", column: "executor_probed_at", definition: "INTEGER" },
      { table: "invocations", column: "tree_tracked_pgids", definition: "TEXT" },
      {
        table: "invocations",
        column: "tree_unsettled",
        definition: "INTEGER NOT NULL DEFAULT 0",
      },
      { table: "invocations", column: "tree_survivor_pids", definition: "TEXT" },
    ] as const;
    for (const addition of additions) {
      const existing = (
        this.db.prepare(`PRAGMA table_info(${addition.table})`).all() as Array<{
          readonly name: string;
        }>
      ).map((column) => column.name);
      if (!existing.includes(addition.column)) {
        this.db.exec(
          `ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`,
        );
      }
    }
    this.clampOversizedIntervals();
  }

  private clampOversizedIntervals(): void {
    const rows = this.db.prepare("SELECT id, trigger_json FROM schedules").all() as Array<{
      readonly id: string;
      readonly trigger_json: string;
    }>;
    for (const row of rows) {
      let raw: unknown;
      try {
        raw = JSON.parse(row.trigger_json) as unknown;
      } catch {
        continue;
      }
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("kind" in raw) ||
        raw.kind !== TRIGGER_KINDS.interval ||
        !("everyMs" in raw) ||
        typeof raw.everyMs !== "number" ||
        raw.everyMs <= SCHEDULER_LIMITS.maxIntervalMs
      ) {
        continue;
      }
      this.db
        .prepare(
          `UPDATE schedules SET trigger_json = ?, status = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify({ kind: TRIGGER_KINDS.interval, everyMs: SCHEDULER_LIMITS.maxIntervalMs }),
          SCHEDULE_STATUSES.paused,
          `原间隔 ${String(raw.everyMs)} ms 超过上限 365 天，已按 365 天登记并暂停；确认后 roll schedule resume`,
          Date.now(),
          row.id,
        );
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSchedule(input: CreateScheduleInput, nowMs: number = Date.now()): ScheduleRecord {
    const valid = validateCreateInput(input);
    return this.transaction(() => {
      const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM schedules").get() as {
        readonly count: number;
      };
      if (countRow.count >= this.maxSchedules) {
        throw new ScheduleStoreError(
          SCHEDULE_STORE_ERROR_CODES.limitReached,
          `已达到定时任务上限 ${String(this.maxSchedules)}，请先删除不再需要的任务`,
        );
      }
      const id = randomUUID();
      const nextRunAt =
        input.fireImmediately === true ? nowMs : computeNextRunAtMs(valid.trigger, nowMs);
      this.db
        .prepare(
          `INSERT INTO schedules
             (id, name, prompt, cwd, trigger_json, status, authority_digest, next_run_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          valid.name,
          valid.prompt,
          valid.cwd,
          JSON.stringify(valid.trigger),
          SCHEDULE_STATUSES.active,
          input.authorityDigest ?? null,
          nextRunAt,
          nowMs,
          nowMs,
        );
      return this.requireSchedule(id);
    });
  }

  setAuthorityDigest(id: string, digest: string, nowMs: number = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE schedules SET authority_digest = ?, updated_at = ? WHERE id = ?")
      .run(digest, nowMs, id);
    return result.changes === 1;
  }

  getSchedule(id: string): ScheduleRecord | undefined {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
      | ScheduleRow
      | undefined;
    return row ? toScheduleRecord(row) : undefined;
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules ORDER BY created_at ASC, rowid ASC")
      .all() as unknown as ScheduleRow[];
    return rows.map(toScheduleRecord);
  }

  setScheduleStatus(id: string, status: ScheduleStatus, nowMs: number = Date.now()): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE schedules SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, nowMs, id);
      if (result.changes !== 1) {
        return false;
      }
      if (status === SCHEDULE_STATUSES.paused) {
        const retrying = this.db
          .prepare("SELECT id FROM invocations WHERE schedule_id = ? AND mode = ? AND status = ?")
          .all(id, INVOCATION_MODES.scheduled, INVOCATION_STATUSES.retry) as Array<{
          readonly id: string;
        }>;
        for (const row of retrying) {
          this.finishInvocationAsFailedInTransaction(row.id, "任务已暂停，放弃重试", nowMs);
        }
      }
      return true;
    });
  }

  probeExecutor(executor: ExecutorIdentity): ExecutorLiveness {
    return this.executorLiveness(executor);
  }

  listRunningInvocations(): InvocationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM invocations WHERE status = ? ORDER BY started_at ASC")
      .all(INVOCATION_STATUSES.running) as unknown as InvocationRow[];
    return rows.map(toInvocationRecord);
  }

  listActiveWorkerInvocations(): InvocationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations WHERE status IN (?, ?)
          ORDER BY COALESCE(started_at, created_at) ASC, created_at ASC`,
      )
      .all(INVOCATION_STATUSES.claimed, INVOCATION_STATUSES.running) as unknown as InvocationRow[];
    return rows.map(toInvocationRecord);
  }

  prepareWorkerShutdown(
    workerId: string,
    reason: string,
    nowMs: number = Date.now(),
  ): ClaimedInvocation[] {
    return this.transaction(() => {
      const claimed = this.db
        .prepare("SELECT id FROM invocations WHERE claimed_by = ? AND status = ?")
        .all(workerId, INVOCATION_STATUSES.claimed) as Array<{ readonly id: string }>;
      for (const row of claimed) {
        this.finishInvocationAsFailedInTransaction(row.id, reason, nowMs);
      }
      const running = this.db
        .prepare(
          `SELECT * FROM invocations WHERE claimed_by = ? AND status = ?
            ORDER BY started_at ASC, created_at ASC`,
        )
        .all(workerId, INVOCATION_STATUSES.running) as unknown as InvocationRow[];
      return running.map((row) => {
        if (row.ownership_token === null) {
          throw new ScheduleStoreError(
            SCHEDULE_STORE_ERROR_CODES.invalid,
            `running invocation ${row.id} 缺少 ownership token`,
          );
        }
        const claim = this.loadClaim(row.id, row.ownership_token);
        if (claim === undefined) {
          throw new ScheduleStoreError(
            SCHEDULE_STORE_ERROR_CODES.invalid,
            `running invocation ${row.id} 无法加载 worker claim`,
          );
        }
        return claim;
      });
    });
  }

  removeSchedule(id: string, options: RemoveScheduleOptions = {}): boolean {
    return this.transaction(() => {
      if (options.abandon !== true) {
        const occupying = this.db
          .prepare(
            `SELECT id, status FROM invocations WHERE schedule_id = ? AND ${OCCUPYING_RUN_SQL} LIMIT 1`,
          )
          .get(id, ...OCCUPYING_RUN_PARAMS) as
          | { readonly id: string; readonly status: string }
          | undefined;
        if (occupying !== undefined) {
          throw new ScheduleStoreError(
            SCHEDULE_STORE_ERROR_CODES.invalid,
            `定时任务 ${id} 仍有未结束的运行（invocation ${occupying.id}，${occupying.status}）；先 cancel --kill 清场，或显式 --abandon 放弃追踪`,
          );
        }
      }
      const result = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
      return result.changes === 1;
    });
  }

  enqueueManualInvocation(
    scheduleId: string,
    nowMs: number = Date.now(),
    options: EnqueueManualInvocationOptions = {},
  ): InvocationRecord {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? this.retryBudget));
    return this.transaction(() => {
      this.requireSchedule(scheduleId);
      const id = randomUUID();
      for (let offset = 0; offset < 1_000; offset += 1) {
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO invocations
               (id, schedule_id, mode, status, scheduled_for, attempt, max_attempts, created_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            id,
            scheduleId,
            INVOCATION_MODES.manual,
            INVOCATION_STATUSES.pending,
            nowMs + offset,
            maxAttempts,
            nowMs,
          );
        if (inserted.changes === 1) {
          return this.requireInvocation(id);
        }
      }
      throw new ScheduleStoreError(
        SCHEDULE_STORE_ERROR_CODES.invalid,
        `schedule ${scheduleId} 的手动触发入队失败`,
      );
    });
  }

  claimPendingInvocation(
    id: string,
    workerId: string,
    nowMs: number = Date.now(),
  ): ClaimedInvocation | undefined {
    return this.transaction(() => {
      const token = randomUUID();
      const result = this.db
        .prepare(
          `UPDATE invocations
             SET status = ?, claimed_by = ?, ownership_token = ?, lease_until = ?, attempt = 1,
                 retry_at = NULL
           WHERE id = ? AND status = ?
             AND NOT EXISTS (
               SELECT 1 FROM invocations o
                WHERE o.schedule_id = (SELECT schedule_id FROM invocations WHERE id = ?)
                  AND o.id != ? AND ${OCCUPYING_RUN_SQL})`,
        )
        .run(
          INVOCATION_STATUSES.claimed,
          workerId,
          token,
          nowMs + this.claimLeaseMs,
          id,
          INVOCATION_STATUSES.pending,
          id,
          id,
          ...OCCUPYING_RUN_PARAMS,
        );
      return result.changes === 1 ? this.loadClaim(id, token) : undefined;
    });
  }

  findLiveRun(scheduleId: string): InvocationRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM invocations WHERE schedule_id = ? AND ${OCCUPYING_RUN_SQL}
          ORDER BY started_at ASC, created_at ASC LIMIT 1`,
      )
      .get(scheduleId, ...OCCUPYING_RUN_PARAMS) as InvocationRow | undefined;
    return row ? toInvocationRecord(row) : undefined;
  }

  discardPendingInvocation(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM invocations WHERE id = ? AND status = ?")
      .run(id, INVOCATION_STATUSES.pending);
    return result.changes === 1;
  }

  cancelInvocation(
    id: string,
    reason: string,
    nowMs: number = Date.now(),
    options: CancelInvocationOptions = {},
  ): CancelInvocationOutcome {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as
        | InvocationRow
        | undefined;
      return this.cancelInvocationInTransaction(row, reason, nowMs, options);
    });
  }

  finalizeCancellation(input: FinalizeCancellationInput): CancelInvocationOutcome {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(input.id) as
        | InvocationRow
        | undefined;
      const mismatch = this.revisionMismatch(row, {
        ...(input.expectedOwnershipToken !== undefined
          ? { expectedOwnershipToken: input.expectedOwnershipToken }
          : {}),
        expectedAttempt: input.expectedAttempt,
        ...(input.expectedClaimedBy !== undefined
          ? { expectedClaimedBy: input.expectedClaimedBy }
          : {}),
      });
      if (mismatch !== undefined) {
        return mismatch;
      }
      if (
        input.abandon !== true &&
        row !== undefined &&
        parseTrackedGroupsResult(row.tree_tracked_pgids).kind ===
          TRACKED_GROUP_PARSE_RESULTS.invalid
      ) {
        return CANCEL_INVOCATION_OUTCOMES.treeUnsettled;
      }
      if (input.tree !== undefined) {
        const written = this.writeInvocationTreeInTransaction({
          id: input.id,
          unsettled: input.tree.unsettled,
          ...(input.tree.trackedGroups !== undefined
            ? { trackedGroups: input.tree.trackedGroups }
            : {}),
          ...(input.tree.trackedPgids !== undefined
            ? { trackedPgids: input.tree.trackedPgids }
            : {}),
          ...(input.tree.survivorPids !== undefined
            ? { survivorPids: input.tree.survivorPids }
            : {}),
          expectedAttempt: input.expectedAttempt,
        });
        if (!written) {
          return CANCEL_INVOCATION_OUTCOMES.ownershipChanged;
        }
      }
      const current = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(input.id) as
        | InvocationRow
        | undefined;
      return this.cancelInvocationInTransaction(current, input.reason, input.nowMs, {
        ...(input.abandon === true ? { abandon: true } : {}),
        expectedAttempt: input.expectedAttempt,
        ...(input.expectedOwnershipToken !== undefined
          ? { expectedOwnershipToken: input.expectedOwnershipToken }
          : {}),
        ...(input.expectedClaimedBy !== undefined
          ? { expectedClaimedBy: input.expectedClaimedBy }
          : {}),
      });
    });
  }

  private revisionMismatch(
    row: InvocationRow | undefined,
    options: CancelInvocationOptions,
  ): CancelInvocationOutcome | undefined {
    if (row === undefined || !isInvocationStatus(row.status)) {
      return CANCEL_INVOCATION_OUTCOMES.notFound;
    }
    if (
      options.expectedOwnershipToken !== undefined &&
      row.ownership_token !== options.expectedOwnershipToken
    ) {
      return CANCEL_INVOCATION_OUTCOMES.ownershipChanged;
    }
    if (options.expectedAttempt !== undefined && row.attempt !== options.expectedAttempt) {
      return CANCEL_INVOCATION_OUTCOMES.ownershipChanged;
    }
    if (
      options.expectedClaimedBy !== undefined &&
      (row.claimed_by ?? undefined) !== options.expectedClaimedBy
    ) {
      return CANCEL_INVOCATION_OUTCOMES.ownershipChanged;
    }
    return undefined;
  }

  private cancelInvocationInTransaction(
    row: InvocationRow | undefined,
    reason: string,
    nowMs: number,
    options: CancelInvocationOptions,
  ): CancelInvocationOutcome {
    const mismatch = this.revisionMismatch(row, options);
    if (mismatch !== undefined) {
      return mismatch;
    }
    if (row === undefined || !isInvocationStatus(row.status)) {
      return CANCEL_INVOCATION_OUTCOMES.notFound;
    }
    if (!(INVOCATION_LIVE_STATUSES as readonly InvocationStatus[]).includes(row.status)) {
      return CANCEL_INVOCATION_OUTCOMES.terminal;
    }
    if (row.status === INVOCATION_STATUSES.running && options.abandon !== true) {
      const executor = toExecutorIdentity(row);
      const liveness =
        executor === undefined ? EXECUTOR_LIVENESS.unknown : this.executorLiveness(executor);
      if (liveness === EXECUTOR_LIVENESS.alive || liveness === EXECUTOR_LIVENESS.descendants) {
        return CANCEL_INVOCATION_OUTCOMES.executorAlive;
      }
      if (liveness === EXECUTOR_LIVENESS.unknown) {
        return CANCEL_INVOCATION_OUTCOMES.executorUnknown;
      }
    }
    const force = options.abandon === true;
    if (!force && this.treeBlocksTerminal(row)) {
      return CANCEL_INVOCATION_OUTCOMES.treeUnsettled;
    }
    if (!this.finishInvocationAsFailedInTransaction(row.id, reason, nowMs, { force })) {
      return CANCEL_INVOCATION_OUTCOMES.treeUnsettled;
    }
    return CANCEL_INVOCATION_OUTCOMES.cancelled;
  }

  private hasOtherLiveRunInTransaction(scheduleId: string, exceptId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM invocations
          WHERE schedule_id = ? AND id != ? AND ${OCCUPYING_RUN_SQL} LIMIT 1`,
      )
      .get(scheduleId, exceptId, ...OCCUPYING_RUN_PARAMS);
    return row !== undefined;
  }

  claimDue(input: ClaimDueInput): ClaimedInvocation[] {
    const held = input.heldInvocationIds ?? new Set<string>();
    return this.transaction(() => {
      const claimed: ClaimedInvocation[] = [];
      const liveRows = this.db
        .prepare(
          `SELECT i.*, s.status AS schedule_status FROM invocations i
             JOIN schedules s ON s.id = i.schedule_id
            WHERE i.status = ?
               OR (i.status = ? AND i.retry_at IS NOT NULL AND i.retry_at <= ?)
               OR (i.status IN (?, ?) AND i.lease_until IS NOT NULL AND i.lease_until <= ?)
            ORDER BY i.scheduled_for ASC, i.created_at ASC`,
        )
        .all(
          INVOCATION_STATUSES.pending,
          INVOCATION_STATUSES.retry,
          input.nowMs,
          INVOCATION_STATUSES.claimed,
          INVOCATION_STATUSES.running,
          input.nowMs,
        ) as unknown as LiveInvocationRow[];
      const reclaimable: LiveInvocationRow[] = [];
      const probeCandidates = liveRows.filter(
        (row) =>
          row.status === INVOCATION_STATUSES.running &&
          !held.has(row.id) &&
          toExecutorIdentity(row) !== undefined,
      );
      probeCandidates.sort((a, b) => (a.executor_probed_at ?? -1) - (b.executor_probed_at ?? -1));
      const probeResults = new Map<string, LivenessProbeResult>();
      let probesLeft = input.limit <= 0 ? 0 : this.maxLivenessProbesPerClaim;
      for (const row of probeCandidates) {
        const executor = toExecutorIdentity(row);
        if (executor === undefined) {
          continue;
        }
        if (probesLeft <= 0) {
          probeResults.set(row.id, LIVENESS_PROBE_RESULTS.deferred);
          continue;
        }
        probesLeft -= 1;
        this.db
          .prepare("UPDATE invocations SET executor_probed_at = ? WHERE id = ?")
          .run(input.nowMs, row.id);
        probeResults.set(
          row.id,
          this.executorLiveness(executor) === EXECUTOR_LIVENESS.dead
            ? LIVENESS_PROBE_RESULTS.dead
            : LIVENESS_PROBE_RESULTS.notDead,
        );
      }
      for (const row of liveRows) {
        const inFlight =
          row.status === INVOCATION_STATUSES.claimed || row.status === INVOCATION_STATUSES.running;
        const probe = probeResults.get(row.id);
        if (inFlight && (held.has(row.id) || probe === LIVENESS_PROBE_RESULTS.notDead)) {
          this.db
            .prepare("UPDATE invocations SET lease_until = ? WHERE id = ?")
            .run(input.nowMs + this.claimLeaseMs, row.id);
          continue;
        }
        if (probe === LIVENESS_PROBE_RESULTS.deferred) {
          this.db
            .prepare("UPDATE invocations SET lease_until = ? WHERE id = ?")
            .run(input.nowMs + this.livenessProbeDeferralMs, row.id);
          continue;
        }
        reclaimable.push(row);
      }
      if (input.limit <= 0) {
        return claimed;
      }
      for (const row of reclaimable) {
        if (claimed.length >= input.limit) {
          break;
        }
        if (
          parseTrackedGroupsResult(row.tree_tracked_pgids).kind ===
          TRACKED_GROUP_PARSE_RESULTS.invalid
        ) {
          if (row.status === INVOCATION_STATUSES.retry) {
            this.db
              .prepare("UPDATE invocations SET retry_at = ? WHERE id = ?")
              .run(input.nowMs + this.claimLeaseMs, row.id);
          } else if (
            row.status === INVOCATION_STATUSES.claimed ||
            row.status === INVOCATION_STATUSES.running
          ) {
            this.db
              .prepare("UPDATE invocations SET lease_until = ? WHERE id = ?")
              .run(input.nowMs + this.claimLeaseMs, row.id);
          }
          continue;
        }
        if (
          row.mode === INVOCATION_MODES.scheduled &&
          row.schedule_status === SCHEDULE_STATUSES.paused
        ) {
          if (this.treeBlocksTerminal(row)) {
            this.db
              .prepare("UPDATE invocations SET lease_until = ? WHERE id = ?")
              .run(input.nowMs + this.claimLeaseMs, row.id);
            continue;
          }
          this.finishInvocationAsFailedInTransaction(
            row.id,
            "任务已暂停，放弃本次运行",
            input.nowMs,
          );
          continue;
        }
        if (this.hasOtherLiveRunInTransaction(row.schedule_id, row.id)) {
          continue;
        }
        const attempt = row.status === INVOCATION_STATUSES.pending ? 1 : row.attempt + 1;
        if (attempt > row.max_attempts) {
          if (this.treeBlocksTerminal(row)) {
            this.db
              .prepare("UPDATE invocations SET lease_until = ? WHERE id = ?")
              .run(input.nowMs + this.claimLeaseMs, row.id);
            continue;
          }
          this.markTerminalFailureInTransaction(
            row,
            `重试预算耗尽（共 ${String(row.max_attempts)} 次尝试）：${row.error ?? "exec 未成功完成"}`,
            input.nowMs,
          );
          continue;
        }
        const token = randomUUID();
        this.db
          .prepare(
            `UPDATE invocations
               SET status = ?, claimed_by = ?, ownership_token = ?, lease_until = ?,
                   attempt = ?, retry_at = NULL
             WHERE id = ?`,
          )
          .run(
            INVOCATION_STATUSES.claimed,
            input.workerId,
            token,
            input.nowMs + this.claimLeaseMs,
            attempt,
            row.id,
          );
        const claim = this.loadClaim(row.id, token);
        if (claim !== undefined) {
          claimed.push(claim);
        }
      }
      if (claimed.length >= input.limit) {
        return claimed;
      }
      const dueRows = this.db
        .prepare(
          `SELECT s.* FROM schedules s
            WHERE s.status = ? AND s.next_run_at IS NOT NULL AND s.next_run_at <= ?
              AND NOT EXISTS (
                SELECT 1 FROM invocations i
                 WHERE i.schedule_id = s.id AND i.status IN (?, ?, ?, ?))
            ORDER BY s.next_run_at ASC, s.created_at ASC
            LIMIT ?`,
        )
        .all(
          SCHEDULE_STATUSES.active,
          input.nowMs,
          INVOCATION_STATUSES.pending,
          INVOCATION_STATUSES.claimed,
          INVOCATION_STATUSES.running,
          INVOCATION_STATUSES.retry,
          input.limit - claimed.length,
        ) as unknown as ScheduleRow[];
      for (const row of dueRows) {
        let trigger: TriggerSpec;
        try {
          trigger = parseTriggerJson(row.trigger_json);
        } catch (error) {
          this.db
            .prepare("UPDATE schedules SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
            .run(
              SCHEDULE_STATUSES.paused,
              `触发配置无法解析，已暂停：${error instanceof Error ? error.message : String(error)}`,
              input.nowMs,
              row.id,
            );
          continue;
        }
        const id = randomUUID();
        const token = randomUUID();
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO invocations
               (id, schedule_id, mode, status, scheduled_for, attempt, max_attempts, claimed_by,
                ownership_token, lease_until, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            row.id,
            INVOCATION_MODES.scheduled,
            INVOCATION_STATUSES.claimed,
            row.next_run_at ?? input.nowMs,
            this.retryBudget,
            input.workerId,
            token,
            input.nowMs + this.claimLeaseMs,
            input.nowMs,
          );
        this.db
          .prepare("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?")
          .run(computeNextRunAtMs(trigger, input.nowMs), input.nowMs, row.id);
        if (inserted.changes === 1) {
          const claim = this.loadClaim(id, token);
          if (claim !== undefined) {
            claimed.push(claim);
          }
        }
      }
      return claimed;
    });
  }

  beginInvocation(
    id: string,
    ownershipToken: string,
    nowMs: number = Date.now(),
    executor?: ExecutorIdentity,
  ): ClaimedInvocation | undefined {
    const result = this.db
      .prepare(
        `UPDATE invocations
           SET status = ?, started_at = ?, lease_until = ?, executor_pid = ?,
               executor_start_token = ?, executor_probed_at = NULL
         WHERE id = ? AND ownership_token = ? AND status = ?`,
      )
      .run(
        INVOCATION_STATUSES.running,
        nowMs,
        nowMs + this.claimLeaseMs,
        executor?.pid ?? null,
        executor?.startToken ?? null,
        id,
        ownershipToken,
        INVOCATION_STATUSES.claimed,
      );
    return result.changes === 1 ? this.loadClaim(id, ownershipToken) : undefined;
  }

  renewLease(id: string, ownershipToken: string, nowMs: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE invocations SET lease_until = ?
         WHERE id = ? AND ownership_token = ? AND status IN (?, ?)`,
      )
      .run(
        nowMs + this.claimLeaseMs,
        id,
        ownershipToken,
        INVOCATION_STATUSES.claimed,
        INVOCATION_STATUSES.running,
      );
    return result.changes === 1;
  }

  completeInvocation(input: CompleteInvocationInput): CompleteInvocationOutcome {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(input.id) as
        | InvocationRow
        | undefined;
      if (
        row === undefined ||
        row.ownership_token !== input.ownershipToken ||
        (row.status !== INVOCATION_STATUSES.claimed && row.status !== INVOCATION_STATUSES.running)
      ) {
        return COMPLETE_INVOCATION_OUTCOMES.lostClaim;
      }
      if (this.treeBlocksTerminal(row)) {
        return COMPLETE_INVOCATION_OUTCOMES.treeUnsettled;
      }
      const result = this.db
        .prepare(
          `UPDATE invocations
             SET status = ?, thread_id = ?, output_excerpt = ?, pending_actions_json = ?,
                 error = NULL, finished_at = ?, claimed_by = NULL, ownership_token = NULL,
                 lease_until = NULL, retry_at = NULL, tree_tracked_pgids = NULL,
                 tree_unsettled = 0, tree_survivor_pids = NULL
           WHERE id = ? AND ownership_token = ? AND status IN (?, ?)`,
        )
        .run(
          input.status,
          input.threadId ?? null,
          input.outputExcerpt ?? null,
          JSON.stringify(input.pendingActions ?? []),
          input.nowMs,
          input.id,
          input.ownershipToken,
          INVOCATION_STATUSES.claimed,
          INVOCATION_STATUSES.running,
        );
      if (result.changes !== 1) {
        return COMPLETE_INVOCATION_OUTCOMES.lostClaim;
      }
      this.db
        .prepare(
          `UPDATE schedules SET last_run_at = ?, last_error = NULL, updated_at = ?
           WHERE id = (SELECT schedule_id FROM invocations WHERE id = ?)`,
        )
        .run(input.nowMs, input.nowMs, input.id);
      return COMPLETE_INVOCATION_OUTCOMES.written;
    });
  }

  recordInvocationTree(input: RecordInvocationTreeInput): boolean {
    if (input.ownershipToken !== undefined) {
      return this.writeInvocationTreeInTransaction({
        ...input,
        ownershipToken: input.ownershipToken,
      });
    }
    return this.writeInvocationTreeInTransaction({
      id: input.id,
      unsettled: input.unsettled,
      ...(input.trackedGroups !== undefined ? { trackedGroups: input.trackedGroups } : {}),
      ...(input.trackedPgids !== undefined ? { trackedPgids: input.trackedPgids } : {}),
      ...(input.survivorPids !== undefined ? { survivorPids: input.survivorPids } : {}),
      retryOnly: true,
    });
  }

  private writeInvocationTreeInTransaction(input: {
    readonly id: string;
    readonly unsettled: boolean;
    readonly trackedGroups?: readonly PersistedTrackedGroup[];
    readonly trackedPgids?: readonly number[];
    readonly survivorPids?: readonly number[];
    readonly ownershipToken?: string;
    readonly expectedAttempt?: number;
    readonly retryOnly?: boolean;
  }): boolean {
    const groups = input.unsettled
      ? resolveTrackedGroups(input.trackedGroups, input.trackedPgids)
      : [];
    const tracked = groups.length > 0 ? encodeTrackedGroups(groups) : null;
    const survivors = encodePidList(input.unsettled ? (input.survivorPids ?? []) : []);
    const unsettled = input.unsettled ? 1 : 0;
    if (input.ownershipToken !== undefined) {
      const result = this.db
        .prepare(
          `UPDATE invocations
             SET tree_tracked_pgids = ?, tree_unsettled = ?, tree_survivor_pids = ?
           WHERE id = ? AND ownership_token = ? AND status IN (?, ?)`,
        )
        .run(
          tracked,
          unsettled,
          survivors,
          input.id,
          input.ownershipToken,
          INVOCATION_STATUSES.claimed,
          INVOCATION_STATUSES.running,
        );
      return result.changes === 1;
    }
    if (input.expectedAttempt !== undefined) {
      const result = this.db
        .prepare(
          `UPDATE invocations
             SET tree_tracked_pgids = ?, tree_unsettled = ?, tree_survivor_pids = ?
           WHERE id = ? AND attempt = ? AND status IN (?, ?, ?)`,
        )
        .run(
          tracked,
          unsettled,
          survivors,
          input.id,
          input.expectedAttempt,
          INVOCATION_STATUSES.claimed,
          INVOCATION_STATUSES.running,
          INVOCATION_STATUSES.retry,
        );
      return result.changes === 1;
    }
    if (input.retryOnly === true) {
      const result = this.db
        .prepare(
          `UPDATE invocations
             SET tree_tracked_pgids = ?, tree_unsettled = ?, tree_survivor_pids = ?
           WHERE id = ? AND status = ?`,
        )
        .run(tracked, unsettled, survivors, input.id, INVOCATION_STATUSES.retry);
      return result.changes === 1;
    }
    return false;
  }

  failInvocation(
    id: string,
    ownershipToken: string,
    error: string,
    nowMs: number = Date.now(),
    options: FailInvocationOptions = {},
  ): InvocationFailureOutcome {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as
        | InvocationRow
        | undefined;
      if (
        row === undefined ||
        row.ownership_token !== ownershipToken ||
        (row.status !== INVOCATION_STATUSES.claimed && row.status !== INVOCATION_STATUSES.running)
      ) {
        return INVOCATION_FAILURE_OUTCOMES.lostClaim;
      }
      if (options.terminal === true || row.attempt >= row.max_attempts) {
        if (this.treeBlocksTerminal(row)) {
          return INVOCATION_FAILURE_OUTCOMES.treeUnsettled;
        }
        this.markTerminalFailureInTransaction(row, error, nowMs);
        return row.mode === INVOCATION_MODES.scheduled
          ? INVOCATION_FAILURE_OUTCOMES.terminalPaused
          : INVOCATION_FAILURE_OUTCOMES.terminal;
      }
      this.db
        .prepare(
          `UPDATE invocations
             SET status = ?, retry_at = ?, error = ?, claimed_by = NULL, ownership_token = NULL,
                 lease_until = NULL
           WHERE id = ?`,
        )
        .run(INVOCATION_STATUSES.retry, nowMs + this.retryBackoffMs, error, id);
      return INVOCATION_FAILURE_OUTCOMES.retryScheduled;
    });
  }

  getInvocation(id: string): InvocationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as
      | InvocationRow
      | undefined;
    return row ? toInvocationRecord(row) : undefined;
  }

  listInvocations(scheduleId: string, limit = 20): InvocationRecord[] {
    if (limit <= 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations WHERE schedule_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(scheduleId, limit) as unknown as InvocationRow[];
    return rows.map(toInvocationRecord);
  }

  pruneInvocations(nowMs: number = Date.now()): number {
    return this.transaction(() => {
      const aged = this.db
        .prepare(
          `DELETE FROM invocations
            WHERE status IN (${TERMINAL_STATUS_PLACEHOLDERS})
              AND finished_at IS NOT NULL AND finished_at < ?`,
        )
        .run(...INVOCATION_TERMINAL_STATUSES, nowMs - this.invocationRetentionMs);
      const excess = this.db
        .prepare(
          `DELETE FROM invocations WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY schedule_id
                 ORDER BY COALESCE(finished_at, created_at) DESC, rowid DESC) AS rn
                 FROM invocations WHERE status IN (${TERMINAL_STATUS_PLACEHOLDERS}))
              WHERE rn > ?)`,
        )
        .run(...INVOCATION_TERMINAL_STATUSES, this.invocationRetentionPerSchedule);
      return Number(aged.changes) + Number(excess.changes);
    });
  }

  nextWakeAtMs(): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(t) AS wake FROM (
           SELECT MIN(next_run_at) AS t FROM schedules
            WHERE status = ? AND next_run_at IS NOT NULL
           UNION ALL SELECT MIN(retry_at) FROM invocations WHERE status = ?
           UNION ALL SELECT MIN(lease_until) FROM invocations WHERE status IN (?, ?)
           UNION ALL SELECT MIN(scheduled_for) FROM invocations WHERE status = ?)`,
      )
      .get(
        SCHEDULE_STATUSES.active,
        INVOCATION_STATUSES.retry,
        INVOCATION_STATUSES.claimed,
        INVOCATION_STATUSES.running,
        INVOCATION_STATUSES.pending,
      ) as { readonly wake: number | null };
    return row.wake ?? undefined;
  }

  private treeBlocksTerminal(row: InvocationRow): boolean {
    const parsed = parseTrackedGroupsResult(row.tree_tracked_pgids);
    if (parsed.kind === TRACKED_GROUP_PARSE_RESULTS.invalid) {
      return true;
    }
    if (row.tree_unsettled !== 1 && parsed.groups.length === 0) {
      return false;
    }
    if (this.treeLiveness === undefined) {
      return true;
    }
    return this.treeLiveness(toInvocationRecord(row)) !== INVOCATION_TREE_LIVENESS.settled;
  }

  private finishInvocationAsFailedInTransaction(
    id: string,
    error: string,
    nowMs: number,
    options: { readonly force?: boolean } = {},
  ): boolean {
    const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as
      | InvocationRow
      | undefined;
    if (row === undefined) {
      return false;
    }
    if (options.force !== true && this.treeBlocksTerminal(row)) {
      return false;
    }
    this.db
      .prepare(
        `UPDATE invocations
           SET status = ?, error = ?, finished_at = ?, claimed_by = NULL, ownership_token = NULL,
               lease_until = NULL, retry_at = NULL, tree_tracked_pgids = NULL,
               tree_unsettled = 0, tree_survivor_pids = NULL
         WHERE id = ?`,
      )
      .run(INVOCATION_STATUSES.failed, error, nowMs, id);
    return true;
  }

  private markTerminalFailureInTransaction(row: InvocationRow, error: string, nowMs: number): void {
    if (!this.finishInvocationAsFailedInTransaction(row.id, error, nowMs)) {
      return;
    }
    if (row.mode === INVOCATION_MODES.scheduled) {
      this.db
        .prepare("UPDATE schedules SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(SCHEDULE_STATUSES.paused, error, nowMs, row.schedule_id);
    } else {
      this.db
        .prepare("UPDATE schedules SET last_error = ?, updated_at = ? WHERE id = ?")
        .run(error, nowMs, row.schedule_id);
    }
  }

  private loadClaim(id: string, ownershipToken: string): ClaimedInvocation | undefined {
    const invocation = this.getInvocation(id);
    if (invocation === undefined) {
      return undefined;
    }
    const schedule = this.getSchedule(invocation.scheduleId);
    if (schedule === undefined) {
      return undefined;
    }
    return { invocation, schedule, ownershipToken };
  }

  private requireInvocation(id: string): InvocationRecord {
    const record = this.getInvocation(id);
    if (record === undefined) {
      throw new ScheduleStoreError(SCHEDULE_STORE_ERROR_CODES.notFound, `invocation ${id} 不存在`);
    }
    return record;
  }

  close(): void {
    this.db.close();
  }

  private requireSchedule(id: string): ScheduleRecord {
    const record = this.getSchedule(id);
    if (record === undefined) {
      throw new ScheduleStoreError(SCHEDULE_STORE_ERROR_CODES.notFound, `schedule ${id} 不存在`);
    }
    return record;
  }
}
