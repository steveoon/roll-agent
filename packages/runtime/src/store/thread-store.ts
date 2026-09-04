import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { modelMessageSchema, type ModelMessage } from "ai";
import {
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES,
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS,
  runtimeDurableEventV13Schema,
  runtimeEventCursorSchema,
  runtimeEventIdSchema,
  timestampSchema,
  type RuntimeDurableEventV13,
  type RuntimeEventCursor,
  type RuntimeEventId,
} from "@roll-agent/protocol";
import {
  parsePersistedToolExecutionRecord,
  prepareToolExecutionRecordForPersistence,
  redactSecretText,
  type ToolExecutionPersistenceMetadata,
  type ToolExecutionRecord,
  type ToolExecutionRecordId,
} from "../tool-bridge/tool-execution-record.ts";
import {
  COMPACTION_CHECKPOINT_VERSION,
  COMPACTION_TRANSCRIPT_COMPLETENESS,
  TRANSCRIPT_MESSAGE_PROVENANCES,
  UnsupportedCompactionCheckpointVersionError,
  archivedTranscriptMessageSchema,
  createCompactionCheckpoint,
  createCompactionCheckpointDraft,
  parseCompactionCheckpoint,
  type ArchivedTranscriptMessage,
  type CompactionCheckpoint,
  type CompactionCheckpointDraftInput,
  type CompactionSemanticEvidenceWatermarks,
  type CompactionSummary,
  type CompactionTranscript,
} from "../engine/compaction-checkpoint.ts";
import {
  legacyCompactionTranscriptFragmentsSchema,
  type CompactionSemanticState,
} from "../engine/compaction-semantic-state.ts";
import { createLegacyCompactionTranscriptMessage } from "../engine/compactor.ts";
import {
  ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS,
  repairActiveToolProtocol,
} from "../engine/tool-protocol-repair.ts";
import { sanitizePersistedExplicitSkillCheckpoint } from "../engine/explicit-skill-context.ts";

const SCHEMA_VERSION = 6;
const DEFAULT_TOOL_EXECUTION_LIMIT = 100;
const MAX_TOOL_EXECUTION_LIMIT = 500;
const DEFAULT_TRANSCRIPT_LIMIT = 50;
const MAX_TRANSCRIPT_LIST_LIMIT = 500;
const MAX_TRANSCRIPT_PAGE_LIMIT = 100;
const THREAD_STORE_BUSY_TIMEOUT_MS = 15_000;

export const TOOL_EXECUTION_RETENTION_POLICY = {
  maxBytesPerThread: 16 * 1_024 * 1_024,
  maxRecordsPerThread: 2_000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
} as const;

export const RUNTIME_EVENT_RETENTION_POLICY = {
  maxBytesPerThread: RUNTIME_V13_MAX_DURABLE_EVENT_RECORD_BYTES,
  maxRecordsPerThread: RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS,
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
} as const;

export interface AppendRuntimeEventInput {
  readonly threadId: string;
  readonly turnId?: string;
  readonly timestamp: string;
  readonly event: RuntimeDurableEventV13;
}

export interface StoredRuntimeEvent {
  readonly eventId: RuntimeEventId;
  readonly cursor: RuntimeEventCursor;
  readonly threadSequence: number;
  readonly threadId: string;
  readonly turnId?: string;
  readonly timestamp: string;
  readonly event: RuntimeDurableEventV13;
}

export interface ResumeRuntimeEventsResult {
  readonly events: readonly StoredRuntimeEvent[];
  readonly throughCursor: RuntimeEventCursor | null;
  readonly replayedCount: number;
}

export class RuntimeEventCursorExpiredError extends Error {
  readonly cursor: RuntimeEventCursor | null;

  constructor(cursor: RuntimeEventCursor | null) {
    super("Runtime event cursor is older than the retained event prefix");
    this.name = "RuntimeEventCursorExpiredError";
    this.cursor = cursor;
  }
}

export class RuntimeEventCursorGapError extends Error {
  readonly cursor: RuntimeEventCursor;

  constructor(cursor: RuntimeEventCursor) {
    super("Runtime event cursor does not belong to the current Thread event log");
    this.name = "RuntimeEventCursorGapError";
    this.cursor = cursor;
  }
}

export const TRANSCRIPT_ENTRY_KINDS = ["message", "tool_execution"] as const;
export type TranscriptEntryKind = (typeof TRANSCRIPT_ENTRY_KINDS)[number];
export type TranscriptCompleteness = (typeof COMPACTION_TRANSCRIPT_COMPLETENESS)[number];

export const TOOL_EXECUTION_CONTEXT_REPRESENTATIONS = {
  rawTranscript: "raw_transcript",
  recoveryEvidence: "recovery_evidence",
} as const;
const LEGACY_TOOL_EXECUTION_CONTEXT_REPRESENTATION = "legacy_assumed";
export type ToolExecutionContextRepresentation =
  (typeof TOOL_EXECUTION_CONTEXT_REPRESENTATIONS)[keyof typeof TOOL_EXECUTION_CONTEXT_REPRESENTATIONS];

export interface ToolExecutionContextCoverageInput {
  readonly executionIds: readonly ToolExecutionRecordId[];
  readonly representation: ToolExecutionContextRepresentation;
}

export interface AppendMessagesOptions {
  readonly toolExecutionCoverage?: ToolExecutionContextCoverageInput;
}

export interface ThreadRecord {
  readonly id: string;
  readonly title: string | undefined;
  readonly model: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateThreadInput {
  readonly id?: string;
  readonly title?: string;
  readonly model?: string;
}

interface ThreadRow {
  readonly id: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ForeignKeyRow {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly on_delete: string;
}

interface ToolExecutionRow {
  readonly sequence: number;
  readonly record_json: string;
}

interface StoredToolExecutionMigrationRow {
  readonly storage_rowid: number;
  readonly record_json: string;
}

interface StoredMessageMigrationRow {
  readonly storage_rowid: number;
  readonly message_json: string;
}

interface ToolExecutionRetentionRow {
  readonly sequence: number;
}

interface ToolExecutionSequenceStateRow {
  readonly next_sequence: number;
}

interface TranscriptMessageRow {
  readonly sequence: number;
  readonly provenance: string;
  readonly created_at: string;
  readonly message_json: string;
}

interface CompactionCheckpointRow {
  readonly schema_version: number;
  readonly checkpoint_json: string;
}

interface TranscriptCompletenessRow {
  readonly completeness: string;
}

interface RuntimeEventStateRow {
  readonly event_log_id: string;
  readonly next_sequence: number;
  readonly retained_from_sequence: number;
  readonly retained_predecessor_event_id: string | null;
  readonly latest_event_id: string | null;
  readonly retained_count: number;
  readonly retained_bytes: number;
}

interface RuntimeEventRow {
  readonly thread_sequence: number;
  readonly event_id: string;
  readonly turn_id: string | null;
  readonly event_timestamp: string;
  readonly event_json: string;
}

interface RuntimeEventSequenceRow {
  readonly thread_sequence: number;
  readonly event_id: string;
}

interface RuntimeEventRetentionAggregateRow {
  readonly removed_count: number;
  readonly removed_bytes: number | null;
}

interface RuntimeEventRetentionBoundaryRow {
  readonly keep_from: number | null;
}

interface ParsedRuntimeEventCursor {
  readonly eventLogId: string;
  readonly threadSequence: number;
  readonly eventId: RuntimeEventId;
}

export type SequencedToolExecutionRecord = ToolExecutionRecord & {
  readonly sequence: number;
  /** Present for records loaded from the bounded durable ledger; absent for in-memory fallbacks. */
  readonly persistence?: ToolExecutionPersistenceMetadata;
};

export interface ListToolExecutionsOptions {
  readonly afterSequence?: number;
  readonly throughSequence?: number;
  readonly limit?: number;
  readonly toolCallId?: string;
}

export interface ListTranscriptMessagesOptions {
  readonly afterSequence?: number;
  readonly throughSequence?: number;
  readonly limit?: number;
}

export interface ListRecentEntriesOptions {
  readonly beforeSequence?: number;
  readonly limit?: number;
}

export interface RecentTranscriptMessagePage {
  readonly entries: readonly ArchivedTranscriptMessage[];
  readonly nextBeforeSequence: number | undefined;
}

export interface RecentToolExecutionPage {
  readonly entries: readonly SequencedToolExecutionRecord[];
  readonly nextBeforeSequence: number | undefined;
}

export interface CompactionEvidenceWatermarks {
  /** Highest append-only transcript sequence that was visible while building the draft. */
  readonly transcriptMessagesThroughSequence: number;
  /** Highest append-only Tool execution sequence that was visible while building the draft. */
  readonly toolExecutionsThroughSequence: number;
}

export interface CommitCompactionInput {
  readonly messages: readonly ModelMessage[];
  /** Active projection observed while the checkpoint draft was built. */
  readonly expectedActiveMessages: readonly ModelMessage[];
  /** Latest checkpoint observed while the checkpoint draft was built. */
  readonly expectedLatestCheckpointId: string | undefined;
  readonly draft: CompactionCheckpointDraftInput;
  /** Harness-validated semantic recovery state; model output is never persisted directly. */
  readonly semanticState: CompactionSemanticState;
  /** Evidence actually removed from active history and processed by the semantic draft. */
  readonly semanticEvidenceWatermarks: CompactionSemanticEvidenceWatermarks;
  readonly evidenceWatermarks: CompactionEvidenceWatermarks;
  /** Narrow V1 migration payload; archived atomically and never inserted into active history. */
  readonly legacySnapshotTranscriptFragments?: readonly string[];
}

export interface ThreadSessionState {
  readonly messages: readonly ModelMessage[];
  readonly checkpoint: CompactionCheckpoint | undefined;
  readonly transcriptCompleteness: TranscriptCompleteness;
}

export type CheckpointTranscriptEntry =
  | {
      readonly kind: "message";
      readonly sequence: number;
      readonly provenance: ArchivedTranscriptMessage["provenance"];
      readonly createdAt: string;
      readonly message: ModelMessage;
    }
  | ({ readonly kind: "tool_execution" } & SequencedToolExecutionRecord);

export interface CheckpointTranscriptPage {
  readonly checkpointId: CompactionCheckpoint["id"];
  readonly kind: TranscriptEntryKind;
  readonly entries: readonly CheckpointTranscriptEntry[];
  readonly nextAfterSequence?: number;
  readonly previousCheckpointId?: CompactionCheckpoint["id"];
  readonly completeness: TranscriptCompleteness;
}

export interface ReadCheckpointTranscriptOptions {
  readonly checkpointId: string;
  readonly kind: TranscriptEntryKind;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export function expandTilde(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

export function defaultThreadsDir(): string {
  return resolve(homedir(), ".roll-agent", "threads");
}

function messagesHaveThreadDeleteCascade(db: DatabaseSync): boolean {
  const foreignKeys = db
    .prepare("PRAGMA foreign_key_list(messages)")
    .all() as unknown as ForeignKeyRow[];
  return foreignKeys.some(
    (foreignKey) =>
      foreignKey.table === "threads" &&
      foreignKey.from === "thread_id" &&
      foreignKey.to === "id" &&
      foreignKey.on_delete.toUpperCase() === "CASCADE",
  );
}

function linkLastValidSummaryCheckpoint(
  summary: CompactionSummary,
  lastValidCheckpoint: CompactionCheckpoint | undefined,
): CompactionSummary {
  if (summary.status === "valid") {
    return summary;
  }
  if (summary.status === "fallback") {
    return {
      status: "fallback",
      reason: summary.reason,
      ...(lastValidCheckpoint !== undefined
        ? { lastValidCheckpointId: lastValidCheckpoint.id }
        : {}),
    };
  }
  return {
    status: "skipped",
    ...(lastValidCheckpoint !== undefined ? { lastValidCheckpointId: lastValidCheckpoint.id } : {}),
  };
}

function parseCompactionCheckpointRow(row: CompactionCheckpointRow): CompactionCheckpoint {
  if (Number.isInteger(row.schema_version) && row.schema_version > COMPACTION_CHECKPOINT_VERSION) {
    throw new UnsupportedCompactionCheckpointVersionError(row.schema_version);
  }
  if (!Number.isInteger(row.schema_version)) {
    throw new Error("Invalid persisted compaction checkpoint schema version");
  }
  const checkpoint = parseCompactionCheckpoint(JSON.parse(row.checkpoint_json));
  if (checkpoint.version !== row.schema_version) {
    throw new Error(
      `Compaction checkpoint schema version mismatch: row v${String(row.schema_version)}, payload v${String(checkpoint.version)}`,
    );
  }
  return checkpoint;
}

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    title: row.title ?? undefined,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createStoredRuntimeEventId(): RuntimeEventId {
  return runtimeEventIdSchema.parse(randomUUID());
}

function createStoredRuntimeEventCursor(
  eventLogId: string,
  threadSequence: number,
  eventId: RuntimeEventId,
): RuntimeEventCursor {
  return runtimeEventCursorSchema.parse(`rte1:${eventLogId}:${String(threadSequence)}:${eventId}`);
}

function parseStoredRuntimeEventCursor(cursor: string): ParsedRuntimeEventCursor | undefined {
  const parsed = runtimeEventCursorSchema.safeParse(cursor);
  if (!parsed.success) {
    return undefined;
  }
  const parts = parsed.data.split(":");
  const threadSequence = Number(parts[2]);
  const eventId = runtimeEventIdSchema.safeParse(parts[3]);
  if (
    parts[1] === undefined ||
    !Number.isSafeInteger(threadSequence) ||
    threadSequence < 0 ||
    !eventId.success
  ) {
    return undefined;
  }
  return {
    eventLogId: parts[1],
    threadSequence,
    eventId: eventId.data,
  };
}

function normalizeRuntimeEventTimestamp(timestamp: string): string {
  return new Date(Date.parse(timestampSchema.parse(timestamp))).toISOString();
}

function parseRuntimeEventRow(
  eventLogId: string,
  threadId: string,
  row: RuntimeEventRow,
): StoredRuntimeEvent {
  const eventId = runtimeEventIdSchema.parse(row.event_id);
  return {
    eventId,
    cursor: createStoredRuntimeEventCursor(eventLogId, row.thread_sequence, eventId),
    threadSequence: row.thread_sequence,
    threadId,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    timestamp: row.event_timestamp,
    event: runtimeDurableEventV13Schema.parse(JSON.parse(row.event_json)),
  };
}

export interface ThreadStoreOptions {
  readonly now?: () => Date;
}

export class ThreadStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(dir: string = defaultThreadsDir(), options: ThreadStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    const resolved = expandTilde(dir);
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") {
      // The bounded ledger still contains operational evidence. Keep both an existing configured
      // directory and newly created stores private instead of relying on the host umask.
      chmodSync(resolved, 0o700);
    }
    const databasePath = resolve(resolved, "threads.db");
    this.db = new DatabaseSync(databasePath);
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
    // v4 rewrites and prunes legacy secret-bearing evidence. Secure deletion overwrites removed
    // cells instead of leaving recoverable payloads on SQLite freelist pages.
    this.db.exec(
      `PRAGMA busy_timeout = ${String(THREAD_STORE_BUSY_TIMEOUT_MS)};
       PRAGMA foreign_keys = ON;
       PRAGMA secure_delete = ON;`,
    );
    const versionRow = this.db.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    if (versionRow.user_version > SCHEMA_VERSION) {
      throw new Error(
        `ThreadStore schema v${String(versionRow.user_version)} 高于当前支持的 v${String(SCHEMA_VERSION)}`,
      );
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS threads (
         id TEXT PRIMARY KEY,
         title TEXT,
         model TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS messages (
         thread_id TEXT NOT NULL,
         idx INTEGER NOT NULL,
         role TEXT NOT NULL,
         content_json TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (thread_id, idx),
         FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
       );`,
      );
      if (!messagesHaveThreadDeleteCascade(this.db)) {
        this.db.exec(
          `CREATE TABLE messages_with_thread_fk (
             thread_id TEXT NOT NULL,
             idx INTEGER NOT NULL,
             role TEXT NOT NULL,
             content_json TEXT NOT NULL,
             created_at TEXT NOT NULL,
             PRIMARY KEY (thread_id, idx),
             FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
           );
           INSERT INTO messages_with_thread_fk
             (thread_id, idx, role, content_json, created_at)
             SELECT messages.thread_id, messages.idx, messages.role,
                    messages.content_json, messages.created_at
               FROM messages
               INNER JOIN threads ON threads.id = messages.thread_id;
           DROP TABLE messages;
           ALTER TABLE messages_with_thread_fk RENAME TO messages;`,
        );
      }
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS tool_executions (
             thread_id TEXT NOT NULL,
             sequence INTEGER NOT NULL,
             id TEXT NOT NULL,
             tool_call_id TEXT NOT NULL,
             agent_name TEXT NOT NULL,
             tool_name TEXT NOT NULL,
             record_json TEXT NOT NULL,
             created_at TEXT NOT NULL,
             PRIMARY KEY (thread_id, id),
             UNIQUE (thread_id, sequence),
             FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
           );
           CREATE INDEX IF NOT EXISTS idx_tool_executions_thread_call
             ON tool_executions(thread_id, tool_call_id, sequence);
           CREATE TABLE IF NOT EXISTS thread_tool_execution_state (
             thread_id TEXT PRIMARY KEY,
             next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
             FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
           );
           CREATE TABLE IF NOT EXISTS transcript_messages (
             thread_id TEXT NOT NULL,
             sequence INTEGER NOT NULL,
             role TEXT NOT NULL,
             message_json TEXT NOT NULL,
             provenance TEXT NOT NULL CHECK (provenance IN ('native', 'legacy_snapshot')),
             created_at TEXT NOT NULL,
             PRIMARY KEY (thread_id, sequence),
             FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
           );
           CREATE TABLE IF NOT EXISTS thread_transcript_state (
             thread_id TEXT PRIMARY KEY,
             completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'legacy_snapshot')),
             FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
           );
           CREATE TABLE IF NOT EXISTS tool_execution_context_coverage (
             thread_id TEXT NOT NULL,
             execution_id TEXT NOT NULL,
             representation TEXT NOT NULL
               CHECK (representation IN ('raw_transcript', 'recovery_evidence', 'legacy_assumed')),
             transcript_sequence INTEGER,
             created_at TEXT NOT NULL,
             PRIMARY KEY (thread_id, execution_id),
             CHECK (
               (representation = 'legacy_assumed' AND transcript_sequence IS NULL)
               OR (representation <> 'legacy_assumed' AND transcript_sequence IS NOT NULL)
             ),
             FOREIGN KEY (thread_id, execution_id)
               REFERENCES tool_executions(thread_id, id) ON DELETE CASCADE,
             FOREIGN KEY (thread_id, transcript_sequence)
               REFERENCES transcript_messages(thread_id, sequence) ON DELETE CASCADE
           );
           CREATE TABLE IF NOT EXISTS compaction_checkpoints (
             id TEXT PRIMARY KEY,
             thread_id TEXT NOT NULL,
             generation INTEGER NOT NULL,
             schema_version INTEGER NOT NULL,
             message_from_sequence INTEGER NOT NULL,
             message_through_sequence INTEGER NOT NULL,
             tool_from_sequence INTEGER NOT NULL,
             tool_through_sequence INTEGER NOT NULL,
             checkpoint_json TEXT NOT NULL,
             created_at TEXT NOT NULL,
             UNIQUE (thread_id, generation),
             FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
           );
           CREATE INDEX IF NOT EXISTS idx_compaction_checkpoints_thread_generation
             ON compaction_checkpoints(thread_id, generation DESC);
           CREATE TABLE IF NOT EXISTS thread_runtime_event_state (
             thread_id TEXT PRIMARY KEY,
             event_log_id TEXT NOT NULL UNIQUE,
             next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
             retained_from_sequence INTEGER NOT NULL
               CHECK (retained_from_sequence >= 0 AND retained_from_sequence <= next_sequence),
             retained_predecessor_event_id TEXT,
             latest_event_id TEXT,
             retained_count INTEGER NOT NULL CHECK (retained_count >= 0),
             retained_bytes INTEGER NOT NULL CHECK (retained_bytes >= 0),
             CHECK (
               (next_sequence = 0
                 AND retained_from_sequence = 0
                 AND retained_predecessor_event_id IS NULL
                 AND latest_event_id IS NULL)
               OR (next_sequence > 0 AND latest_event_id IS NOT NULL)
             ),
             CHECK (
               (retained_from_sequence = 0 AND retained_predecessor_event_id IS NULL)
               OR (retained_from_sequence > 0 AND retained_predecessor_event_id IS NOT NULL)
             ),
             FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
           );
           CREATE TABLE IF NOT EXISTS runtime_events (
             thread_id TEXT NOT NULL,
             thread_sequence INTEGER NOT NULL CHECK (thread_sequence >= 0),
             event_id TEXT NOT NULL UNIQUE,
             turn_id TEXT,
             event_timestamp TEXT NOT NULL,
             event_json TEXT NOT NULL,
             size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
             created_at TEXT NOT NULL,
             PRIMARY KEY (thread_id, thread_sequence),
             FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
           );
           CREATE INDEX IF NOT EXISTS idx_runtime_events_thread_created
             ON runtime_events(thread_id, created_at, thread_sequence);`,
      );
      this.db.exec(
        `INSERT OR IGNORE INTO thread_tool_execution_state (thread_id, next_sequence)
           SELECT id, 0 FROM threads;
         UPDATE thread_tool_execution_state
            SET next_sequence = MAX(
              next_sequence,
              COALESCE((
                SELECT MAX(tool_executions.sequence) + 1
                  FROM tool_executions
                 WHERE tool_executions.thread_id = thread_tool_execution_state.thread_id
              ), 0)
            );`,
      );
      if (versionRow.user_version < 3) {
        this.db.exec(
          `INSERT OR IGNORE INTO thread_transcript_state (thread_id, completeness)
             SELECT id, 'legacy_snapshot' FROM threads;
           INSERT OR IGNORE INTO transcript_messages
             (thread_id, sequence, role, message_json, provenance, created_at)
             SELECT thread_id, idx, role, content_json, 'legacy_snapshot', created_at
               FROM messages;`,
        );
      }
      if (versionRow.user_version < 4) {
        this.migrateToolExecutionPersistenceInTransaction();
        this.migrateExplicitSkillCheckpointPersistenceInTransaction();
      }
      if (versionRow.user_version < 6) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO tool_execution_context_coverage
               (thread_id, execution_id, representation, transcript_sequence, created_at)
             SELECT thread_id, id, ?, NULL, created_at
               FROM tool_executions`,
          )
          .run(LEGACY_TOOL_EXECUTION_CONTEXT_REPRESENTATION);
      }
      this.initializeMissingRuntimeEventStatesInTransaction();
      const retentionNow = this.now().toISOString();
      this.enforceAllToolExecutionRetentionInTransaction(retentionNow);
      this.enforceAllRuntimeEventRetentionInTransaction(retentionNow);
      this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)};`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateToolExecutionPersistenceInTransaction(): void {
    const selectBatch = this.db.prepare(
      `SELECT rowid AS storage_rowid, record_json
         FROM tool_executions
        WHERE rowid > ?
        ORDER BY rowid ASC
        LIMIT 100`,
    );
    const update = this.db.prepare(
      `UPDATE tool_executions
          SET tool_call_id = ?, agent_name = ?, tool_name = ?, record_json = ?, created_at = ?
        WHERE rowid = ?`,
    );
    let afterRowId = 0;
    while (true) {
      const rows = selectBatch.all(afterRowId) as unknown as StoredToolExecutionMigrationRow[];
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const persisted = parsePersistedToolExecutionRecord(JSON.parse(row.record_json));
        update.run(
          persisted.toolCallId,
          persisted.agentName,
          persisted.toolName,
          JSON.stringify(persisted),
          persisted.createdAt,
          row.storage_rowid,
        );
        afterRowId = row.storage_rowid;
      }
    }
  }

  private enforceAllToolExecutionRetentionInTransaction(now: string): void {
    const threadRows = this.db
      .prepare("SELECT DISTINCT thread_id AS id FROM tool_executions")
      .all() as unknown as ReadonlyArray<{ readonly id: string }>;
    for (const { id } of threadRows) {
      this.enforceToolExecutionRetentionInTransaction(id, now);
    }
  }

  private migrateExplicitSkillCheckpointPersistenceInTransaction(): void {
    const targets = [
      { table: "messages", column: "content_json" },
      { table: "transcript_messages", column: "message_json" },
    ] as const;
    for (const target of targets) {
      const rows = this.db
        .prepare(
          `SELECT rowid AS storage_rowid, ${target.column} AS message_json
             FROM ${target.table}
            WHERE ${target.column} LIKE '%"modelUserContent"%'`,
        )
        .all() as unknown as StoredMessageMigrationRow[];
      const update = this.db.prepare(
        `UPDATE ${target.table} SET ${target.column} = ? WHERE rowid = ?`,
      );
      for (const row of rows) {
        const message = modelMessageSchema.parse(JSON.parse(row.message_json));
        const sanitized = sanitizePersistedExplicitSkillCheckpoint(message);
        update.run(JSON.stringify(sanitized), row.storage_rowid);
      }
    }
  }

  private initializeMissingRuntimeEventStatesInTransaction(): void {
    const rows = this.db
      .prepare(
        `SELECT threads.id
           FROM threads
           LEFT JOIN thread_runtime_event_state
             ON thread_runtime_event_state.thread_id = threads.id
          WHERE thread_runtime_event_state.thread_id IS NULL`,
      )
      .all() as unknown as ReadonlyArray<{ readonly id: string }>;
    const insert = this.db.prepare(
      `INSERT INTO thread_runtime_event_state
         (thread_id, event_log_id, next_sequence, retained_from_sequence,
          retained_predecessor_event_id, latest_event_id, retained_count, retained_bytes)
       VALUES (?, ?, 0, 0, NULL, NULL, 0, 0)`,
    );
    for (const row of rows) {
      insert.run(row.id, randomUUID());
    }
  }

  private enforceAllRuntimeEventRetentionInTransaction(now: string): void {
    const rows = this.db
      .prepare("SELECT thread_id AS id FROM thread_runtime_event_state")
      .all() as unknown as ReadonlyArray<{ readonly id: string }>;
    for (const row of rows) {
      this.enforceRuntimeEventRetentionInTransaction(row.id, now);
    }
  }

  createThread(input: CreateThreadInput = {}): string {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO threads (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, input.title ?? null, input.model ?? null, now, now);
      this.db
        .prepare("INSERT INTO thread_transcript_state (thread_id, completeness) VALUES (?, ?)")
        .run(id, COMPACTION_TRANSCRIPT_COMPLETENESS[0]);
      this.db
        .prepare("INSERT INTO thread_tool_execution_state (thread_id, next_sequence) VALUES (?, 0)")
        .run(id);
      this.db
        .prepare(
          `INSERT INTO thread_runtime_event_state
             (thread_id, event_log_id, next_sequence, retained_from_sequence,
              retained_predecessor_event_id, latest_event_id, retained_count, retained_bytes)
           VALUES (?, ?, 0, 0, NULL, NULL, 0, 0)`,
        )
        .run(id, randomUUID());
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasThread(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(id) !== undefined;
  }

  getThread(id: string): ThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  listThreads(): ThreadRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM threads ORDER BY updated_at DESC, rowid DESC")
      .all() as unknown as ThreadRow[];
    return rows.map(toRecord);
  }

  countMessages(threadId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
      .get(threadId) as { readonly n: number };
    return row.n;
  }

  countTranscriptMessages(threadId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM transcript_messages WHERE thread_id = ?")
      .get(threadId) as { readonly n: number };
    return row.n;
  }

  updateTitle(threadId: string, title: string): void {
    this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, threadId);
  }

  updateModel(threadId: string, model: string): void {
    this.db.prepare("UPDATE threads SET model = ? WHERE id = ?").run(model, threadId);
  }

  deleteThread(threadId: string): void {
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  }

  appendRuntimeEvent(input: AppendRuntimeEventInput): StoredRuntimeEvent {
    const event = runtimeDurableEventV13Schema.parse(input.event);
    const eventJson = JSON.stringify(event);
    const timestamp = normalizeRuntimeEventTimestamp(input.timestamp);
    const sizeBytes =
      Buffer.byteLength(eventJson, "utf8") +
      Buffer.byteLength(timestamp, "utf8") +
      Buffer.byteLength(input.turnId ?? "", "utf8");
    if (sizeBytes > RUNTIME_EVENT_RETENTION_POLICY.maxBytesPerThread) {
      throw new Error("Runtime event exceeds the per-Thread retained byte limit");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.db
        .prepare(
          `SELECT event_log_id, next_sequence, retained_from_sequence,
                  retained_predecessor_event_id, latest_event_id,
                  retained_count, retained_bytes
             FROM thread_runtime_event_state
            WHERE thread_id = ?`,
        )
        .get(input.threadId) as RuntimeEventStateRow | undefined;
      if (state === undefined) {
        throw new Error(`Thread "${input.threadId}" 不存在或缺少 Runtime event state`);
      }
      const eventId = createStoredRuntimeEventId();
      const threadSequence = state.next_sequence;
      this.db
        .prepare(
          `INSERT INTO runtime_events
             (thread_id, thread_sequence, event_id, turn_id, event_timestamp,
              event_json, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.threadId,
          threadSequence,
          eventId,
          input.turnId ?? null,
          timestamp,
          eventJson,
          sizeBytes,
          timestamp,
        );
      this.db
        .prepare(
          `UPDATE thread_runtime_event_state
              SET next_sequence = ?, latest_event_id = ?,
                  retained_count = retained_count + 1,
                  retained_bytes = retained_bytes + ?
            WHERE thread_id = ?`,
        )
        .run(threadSequence + 1, eventId, sizeBytes, input.threadId);
      this.enforceRuntimeEventRetentionInTransaction(input.threadId, timestamp);
      this.db.exec("COMMIT");
      return {
        eventId,
        cursor: createStoredRuntimeEventCursor(state.event_log_id, threadSequence, eventId),
        threadSequence,
        threadId: input.threadId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        timestamp,
        event,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRuntimeEventCursor(threadId: string): RuntimeEventCursor | null {
    const state = this.db
      .prepare(
        `SELECT event_log_id, next_sequence, retained_from_sequence,
                retained_predecessor_event_id, latest_event_id,
                retained_count, retained_bytes
           FROM thread_runtime_event_state
          WHERE thread_id = ?`,
      )
      .get(threadId) as RuntimeEventStateRow | undefined;
    if (state === undefined) {
      throw new Error(`Thread "${threadId}" 不存在或缺少 Runtime event state`);
    }
    if (state.next_sequence === 0 || state.latest_event_id === null) {
      return null;
    }
    return createStoredRuntimeEventCursor(
      state.event_log_id,
      state.next_sequence - 1,
      runtimeEventIdSchema.parse(state.latest_event_id),
    );
  }

  resumeRuntimeEvents(
    threadId: string,
    afterCursor: RuntimeEventCursor | null,
  ): ResumeRuntimeEventsResult {
    const parsedCursor =
      afterCursor === null ? undefined : parseStoredRuntimeEventCursor(afterCursor);
    if (afterCursor !== null && parsedCursor === undefined) {
      throw new RuntimeEventCursorGapError(afterCursor);
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.enforceRuntimeEventRetentionInTransaction(threadId, this.now().toISOString());
      const state = this.db
        .prepare(
          `SELECT event_log_id, next_sequence, retained_from_sequence,
                  retained_predecessor_event_id, latest_event_id,
                  retained_count, retained_bytes
             FROM thread_runtime_event_state
            WHERE thread_id = ?`,
        )
        .get(threadId) as RuntimeEventStateRow | undefined;
      if (state === undefined) {
        throw new Error(`Thread "${threadId}" 不存在或缺少 Runtime event state`);
      }
      if (afterCursor === null && state.retained_from_sequence > 0) {
        throw new RuntimeEventCursorExpiredError(afterCursor);
      }
      if (afterCursor !== null && parsedCursor !== undefined) {
        this.validateRuntimeEventCursor(state, afterCursor, parsedCursor, threadId);
      }
      if (state.next_sequence === 0 || state.latest_event_id === null) {
        this.db.exec("COMMIT");
        return { events: [], throughCursor: null, replayedCount: 0 };
      }
      const throughSequence = state.next_sequence - 1;
      const afterSequence = parsedCursor?.threadSequence ?? -1;
      const rows = this.db
        .prepare(
          `SELECT thread_sequence, event_id, turn_id, event_timestamp, event_json
             FROM runtime_events
            WHERE thread_id = ?
              AND thread_sequence > ?
              AND thread_sequence <= ?
            ORDER BY thread_sequence ASC`,
        )
        .all(threadId, afterSequence, throughSequence) as unknown as RuntimeEventRow[];
      const events = rows.map((row) => parseRuntimeEventRow(state.event_log_id, threadId, row));
      const throughCursor = createStoredRuntimeEventCursor(
        state.event_log_id,
        throughSequence,
        runtimeEventIdSchema.parse(state.latest_event_id),
      );
      this.db.exec("COMMIT");
      return {
        events,
        throughCursor,
        replayedCount: events.length,
      };
    } catch (error) {
      if (
        error instanceof RuntimeEventCursorExpiredError ||
        error instanceof RuntimeEventCursorGapError
      ) {
        this.db.exec("COMMIT");
      } else {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  countRuntimeEvents(threadId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE thread_id = ?")
      .get(threadId) as { readonly count: number };
    return row.count;
  }

  private validateRuntimeEventCursor(
    state: RuntimeEventStateRow,
    cursor: RuntimeEventCursor,
    parsedCursor: ParsedRuntimeEventCursor,
    threadId: string,
  ): void {
    if (
      parsedCursor.eventLogId !== state.event_log_id ||
      parsedCursor.threadSequence >= state.next_sequence
    ) {
      throw new RuntimeEventCursorGapError(cursor);
    }
    const retainedPredecessorSequence = state.retained_from_sequence - 1;
    if (parsedCursor.threadSequence < retainedPredecessorSequence) {
      throw new RuntimeEventCursorExpiredError(cursor);
    }
    if (parsedCursor.threadSequence === retainedPredecessorSequence) {
      if (parsedCursor.eventId !== state.retained_predecessor_event_id) {
        throw new RuntimeEventCursorGapError(cursor);
      }
      return;
    }
    const row = this.db
      .prepare(
        `SELECT thread_sequence, event_id
           FROM runtime_events
          WHERE thread_id = ? AND thread_sequence = ?`,
      )
      .get(threadId, parsedCursor.threadSequence) as RuntimeEventSequenceRow | undefined;
    if (row === undefined || row.event_id !== parsedCursor.eventId) {
      throw new RuntimeEventCursorGapError(cursor);
    }
  }

  private enforceRuntimeEventRetentionInTransaction(threadId: string, now: string): void {
    const state = this.db
      .prepare(
        `SELECT event_log_id, next_sequence, retained_from_sequence,
                retained_predecessor_event_id, latest_event_id,
                retained_count, retained_bytes
           FROM thread_runtime_event_state
          WHERE thread_id = ?`,
      )
      .get(threadId) as RuntimeEventStateRow | undefined;
    if (state === undefined || state.retained_count === 0) {
      return;
    }

    let keepFrom = state.retained_from_sequence;
    if (state.retained_count > RUNTIME_EVENT_RETENTION_POLICY.maxRecordsPerThread) {
      const countBoundary = this.db
        .prepare(
          `SELECT thread_sequence AS keep_from
             FROM runtime_events
            WHERE thread_id = ?
            ORDER BY thread_sequence DESC
            LIMIT 1 OFFSET ?`,
        )
        .get(threadId, RUNTIME_EVENT_RETENTION_POLICY.maxRecordsPerThread - 1) as unknown as
        | RuntimeEventRetentionBoundaryRow
        | undefined;
      keepFrom = Math.max(keepFrom, countBoundary?.keep_from ?? state.next_sequence);
    }

    if (state.retained_bytes > RUNTIME_EVENT_RETENTION_POLICY.maxBytesPerThread) {
      const byteBoundary = this.db
        .prepare(
          `SELECT MIN(thread_sequence) AS keep_from
             FROM (
               SELECT thread_sequence,
                      SUM(size_bytes) OVER (
                        ORDER BY thread_sequence DESC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                      ) AS retained_bytes
                 FROM runtime_events
                WHERE thread_id = ?
             )
            WHERE retained_bytes <= ?`,
        )
        .get(
          threadId,
          RUNTIME_EVENT_RETENTION_POLICY.maxBytesPerThread,
        ) as unknown as RuntimeEventRetentionBoundaryRow;
      keepFrom = Math.max(keepFrom, byteBoundary.keep_from ?? state.next_sequence);
    }

    const cutoff = new Date(
      Date.parse(now) - RUNTIME_EVENT_RETENTION_POLICY.maxAgeMs,
    ).toISOString();
    const ageBoundary = this.db
      .prepare(
        `SELECT MIN(thread_sequence) AS keep_from
           FROM runtime_events
          WHERE thread_id = ? AND created_at >= ?`,
      )
      .get(threadId, cutoff) as unknown as RuntimeEventRetentionBoundaryRow;
    keepFrom = Math.max(keepFrom, ageBoundary.keep_from ?? state.next_sequence);

    if (keepFrom <= state.retained_from_sequence) {
      return;
    }
    const predecessor = this.db
      .prepare(
        `SELECT thread_sequence, event_id
           FROM runtime_events
          WHERE thread_id = ? AND thread_sequence = ?`,
      )
      .get(threadId, keepFrom - 1) as RuntimeEventSequenceRow | undefined;
    if (predecessor === undefined) {
      throw new Error("Runtime event retention boundary is not a continuous retained prefix");
    }
    const removed = this.db
      .prepare(
        `SELECT COUNT(*) AS removed_count, SUM(size_bytes) AS removed_bytes
           FROM runtime_events
          WHERE thread_id = ? AND thread_sequence < ?`,
      )
      .get(threadId, keepFrom) as unknown as RuntimeEventRetentionAggregateRow;
    this.db
      .prepare("DELETE FROM runtime_events WHERE thread_id = ? AND thread_sequence < ?")
      .run(threadId, keepFrom);
    this.db
      .prepare(
        `UPDATE thread_runtime_event_state
            SET retained_from_sequence = ?, retained_predecessor_event_id = ?,
                retained_count = retained_count - ?,
                retained_bytes = retained_bytes - ?
          WHERE thread_id = ?`,
      )
      .run(
        keepFrom,
        predecessor.event_id,
        removed.removed_count,
        removed.removed_bytes ?? 0,
        threadId,
      );
  }

  appendMessages(
    threadId: string,
    messages: readonly ModelMessage[],
    options: AppendMessagesOptions = {},
  ): void {
    const coverage = options.toolExecutionCoverage;
    if (messages.length === 0) {
      if (coverage !== undefined && coverage.executionIds.length > 0) {
        throw new Error("Tool execution coverage 必须与至少一条 transcript message 原子写入");
      }
      return;
    }
    if (!this.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    if (
      coverage !== undefined &&
      coverage.representation !== TOOL_EXECUTION_CONTEXT_REPRESENTATIONS.rawTranscript &&
      coverage.representation !== TOOL_EXECUTION_CONTEXT_REPRESENTATIONS.recoveryEvidence
    ) {
      throw new Error("Tool execution coverage representation 无效");
    }
    const coverageIds = coverage?.executionIds ?? [];
    const uniqueCoverageIds = new Set<string>();
    for (const executionId of coverageIds) {
      if (typeof executionId !== "string" || executionId.length === 0) {
        throw new Error("Tool execution coverage execution id 无效");
      }
      if (uniqueCoverageIds.has(executionId)) {
        throw new Error(`Tool execution coverage execution id 重复: ${executionId}`);
      }
      uniqueCoverageIds.add(executionId);
    }
    const parsedMessages = messages.map((message) =>
      sanitizePersistedExplicitSkillCheckpoint(modelMessageSchema.parse(message)),
    );
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.appendMessagesInTransaction(threadId, parsedMessages, now, coverage);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverUncoveredToolExecutions(
    threadId: string,
    createMessage: (records: readonly SequencedToolExecutionRecord[]) => ModelMessage,
  ): ModelMessage | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.hasThread(threadId)) {
        throw new Error(`Thread "${threadId}" 不存在`);
      }
      const records = this.uncoveredToolExecutionRecords(threadId, {
        afterSequence: -1,
        throughSequence: Number.MAX_SAFE_INTEGER,
        toolCallId: undefined,
        limit: Number.MAX_SAFE_INTEGER,
      });
      if (records.length === 0) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const message = sanitizePersistedExplicitSkillCheckpoint(
        modelMessageSchema.parse(createMessage(records)),
      );
      const coverage: ToolExecutionContextCoverageInput = {
        executionIds: records.map((record) => record.id),
        representation: TOOL_EXECUTION_CONTEXT_REPRESENTATIONS.recoveryEvidence,
      };
      this.appendMessagesInTransaction(threadId, [message], new Date().toISOString(), coverage);
      this.db.exec("COMMIT");
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendMessagesInTransaction(
    threadId: string,
    messages: readonly ModelMessage[],
    now: string,
    coverage: ToolExecutionContextCoverageInput | undefined,
  ): void {
    const insertActive = this.db.prepare(
      "INSERT INTO messages (thread_id, idx, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertTranscript = this.db.prepare(
      `INSERT INTO transcript_messages
         (thread_id, sequence, role, message_json, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertCoverage = this.db.prepare(
      `INSERT INTO tool_execution_context_coverage
         (thread_id, execution_id, representation, transcript_sequence, created_at)
       SELECT thread_id, id, ?, ?, ?
         FROM tool_executions
        WHERE thread_id = ?
          AND id = ?
          AND NOT EXISTS (
            SELECT 1
              FROM tool_execution_context_coverage
             WHERE thread_id = ? AND execution_id = ?
          )`,
    );
    const activeStartRow = this.db
      .prepare("SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM messages WHERE thread_id = ?")
      .get(threadId) as { readonly maxIdx: number };
    const transcriptStartRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), -1) AS maxSequence FROM transcript_messages WHERE thread_id = ?",
      )
      .get(threadId) as { readonly maxSequence: number };
    let idx = activeStartRow.maxIdx + 1;
    let sequence = transcriptStartRow.maxSequence + 1;
    for (const message of messages) {
      const serialized = JSON.stringify(message);
      insertActive.run(threadId, idx, message.role, serialized, now);
      insertTranscript.run(
        threadId,
        sequence,
        message.role,
        serialized,
        TRANSCRIPT_MESSAGE_PROVENANCES[0],
        now,
      );
      idx += 1;
      sequence += 1;
    }
    const transcriptSequence = sequence - 1;
    if (coverage !== undefined) {
      for (const executionId of coverage.executionIds) {
        const inserted = insertCoverage.run(
          coverage.representation,
          transcriptSequence,
          now,
          threadId,
          executionId,
          threadId,
          executionId,
        );
        if (Number(inserted.changes) !== 1) {
          throw new Error(
            `Tool execution "${executionId}" 不属于 Thread "${threadId}" 或已被 transcript 覆盖`,
          );
        }
      }
      this.enforceToolExecutionRetentionInTransaction(threadId, now);
    }
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
  }

  replaceMessages(threadId: string, messages: readonly ModelMessage[]): void {
    if (!this.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    const parsedMessages = messages.map((message) => modelMessageSchema.parse(message));
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.replaceMessagesInTransaction(threadId, parsedMessages, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMessages(threadId: string): ModelMessage[] {
    const rows = this.db
      .prepare("SELECT content_json FROM messages WHERE thread_id = ? ORDER BY idx ASC")
      .all(threadId) as unknown as ReadonlyArray<{ readonly content_json: string }>;
    return rows.map((row) => modelMessageSchema.parse(JSON.parse(row.content_json)));
  }

  private replaceMessagesInTransaction(
    threadId: string,
    messages: readonly ModelMessage[],
    now: string,
  ): void {
    const insert = this.db.prepare(
      "INSERT INTO messages (thread_id, idx, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.db.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
    messages.forEach((message, idx) => {
      const persistedMessage = sanitizePersistedExplicitSkillCheckpoint(message);
      insert.run(threadId, idx, persistedMessage.role, JSON.stringify(persistedMessage), now);
    });
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
  }

  appendToolExecution(threadId: string, record: ToolExecutionRecord): number {
    if (!this.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    const persisted = prepareToolExecutionRecordForPersistence(record);
    const recordJson = JSON.stringify(persisted);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sequenceState = this.db
        .prepare("SELECT next_sequence FROM thread_tool_execution_state WHERE thread_id = ?")
        .get(threadId) as ToolExecutionSequenceStateRow | undefined;
      if (sequenceState === undefined) {
        throw new Error(`Thread "${threadId}" 缺少 Tool execution sequence state`);
      }
      const sequence = sequenceState.next_sequence;
      this.db
        .prepare(
          `INSERT INTO tool_executions
             (thread_id, sequence, id, tool_call_id, agent_name, tool_name, record_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          sequence,
          persisted.id,
          persisted.toolCallId,
          persisted.agentName,
          persisted.toolName,
          recordJson,
          persisted.createdAt,
        );
      this.db
        .prepare("UPDATE thread_tool_execution_state SET next_sequence = ? WHERE thread_id = ?")
        .run(sequence + 1, threadId);
      this.enforceToolExecutionRetentionInTransaction(threadId, now);
      this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
      this.db.exec("COMMIT");
      return sequence;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private enforceToolExecutionRetentionInTransaction(threadId: string, now: string): void {
    const cutoff = new Date(
      Date.parse(now) - TOOL_EXECUTION_RETENTION_POLICY.maxAgeMs,
    ).toISOString();
    let pruned = false;
    const expired = this.db
      .prepare(
        `DELETE FROM tool_executions
          WHERE thread_id = ?
            AND created_at < ?
            AND EXISTS (
              SELECT 1
                FROM tool_execution_context_coverage
               WHERE tool_execution_context_coverage.thread_id = tool_executions.thread_id
                 AND tool_execution_context_coverage.execution_id = tool_executions.id
            )`,
      )
      .run(threadId, cutoff);
    pruned = Number(expired.changes) > 0;

    const overflowRows = this.db
      .prepare(
        `SELECT sequence
           FROM (
             SELECT sequence,
                    ROW_NUMBER() OVER (ORDER BY sequence DESC) AS retained_rank,
                    SUM(length(CAST(record_json AS BLOB))) OVER (
                      ORDER BY sequence DESC
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS retained_bytes
               FROM tool_executions
              WHERE thread_id = ?
           )
          WHERE retained_rank > ? OR retained_bytes > ?`,
      )
      .all(
        threadId,
        TOOL_EXECUTION_RETENTION_POLICY.maxRecordsPerThread,
        TOOL_EXECUTION_RETENTION_POLICY.maxBytesPerThread,
      ) as unknown as ToolExecutionRetentionRow[];
    if (overflowRows.length > 0) {
      const remove = this.db.prepare(
        `DELETE FROM tool_executions
          WHERE thread_id = ?
            AND sequence = ?
            AND EXISTS (
              SELECT 1
                FROM tool_execution_context_coverage
               WHERE tool_execution_context_coverage.thread_id = tool_executions.thread_id
                 AND tool_execution_context_coverage.execution_id = tool_executions.id
            )`,
      );
      for (const row of overflowRows) {
        const removed = remove.run(threadId, row.sequence);
        pruned = Number(removed.changes) > 0 || pruned;
      }
    }

    if (pruned) {
      // Checkpoint readers must not mistake a retained suffix for a complete execution transcript.
      this.db
        .prepare(
          `INSERT INTO thread_transcript_state (thread_id, completeness)
           VALUES (?, 'legacy_snapshot')
           ON CONFLICT(thread_id) DO UPDATE SET completeness = 'legacy_snapshot'`,
        )
        .run(threadId);
    }
  }

  listToolExecutions(
    threadId: string,
    options: ListToolExecutionsOptions = {},
  ): SequencedToolExecutionRecord[] {
    const { afterSequence, throughSequence, limit } = this.resolveToolExecutionListRange(options);
    if (throughSequence <= afterSequence) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT sequence, record_json
           FROM tool_executions
          WHERE thread_id = ?
            AND sequence > ?
            AND sequence <= ?
            AND (? IS NULL OR tool_call_id = ?)
          ORDER BY sequence ASC
          LIMIT ?`,
      )
      .all(
        threadId,
        afterSequence,
        throughSequence,
        options.toolCallId ?? null,
        options.toolCallId ?? null,
        limit,
      ) as unknown as ToolExecutionRow[];
    return rows.map((row) => ({
      ...parsePersistedToolExecutionRecord(JSON.parse(row.record_json)),
      sequence: row.sequence,
    }));
  }

  listUncoveredToolExecutions(
    threadId: string,
    options: ListToolExecutionsOptions = {},
  ): SequencedToolExecutionRecord[] {
    const { afterSequence, throughSequence, limit } = this.resolveToolExecutionListRange(options);
    if (throughSequence <= afterSequence) {
      return [];
    }
    return this.uncoveredToolExecutionRecords(threadId, {
      afterSequence,
      throughSequence,
      toolCallId: options.toolCallId,
      limit,
    });
  }

  private resolveToolExecutionListRange(options: ListToolExecutionsOptions): {
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  } {
    const afterSequence = options.afterSequence ?? -1;
    const throughSequence = options.throughSequence ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? DEFAULT_TOOL_EXECUTION_LIMIT;
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      throw new Error("afterSequence 必须是大于等于 -1 的整数");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOOL_EXECUTION_LIMIT) {
      throw new Error(`limit 必须是 1-${String(MAX_TOOL_EXECUTION_LIMIT)} 之间的整数`);
    }
    if (!Number.isInteger(throughSequence) || throughSequence < -1) {
      throw new Error("throughSequence 必须是大于等于 -1 的整数");
    }
    return { afterSequence, throughSequence, limit };
  }

  private uncoveredToolExecutionRecords(
    threadId: string,
    query: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly toolCallId: string | undefined;
      readonly limit: number;
    },
  ): SequencedToolExecutionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT tool_executions.sequence, tool_executions.record_json
           FROM tool_executions
           LEFT JOIN tool_execution_context_coverage
             ON tool_execution_context_coverage.thread_id = tool_executions.thread_id
            AND tool_execution_context_coverage.execution_id = tool_executions.id
          WHERE tool_executions.thread_id = ?
            AND tool_executions.sequence > ?
            AND tool_executions.sequence <= ?
            AND (? IS NULL OR tool_executions.tool_call_id = ?)
            AND tool_execution_context_coverage.execution_id IS NULL
          ORDER BY tool_executions.sequence ASC
          LIMIT ?`,
      )
      .all(
        threadId,
        query.afterSequence,
        query.throughSequence,
        query.toolCallId ?? null,
        query.toolCallId ?? null,
        query.limit,
      ) as unknown as ToolExecutionRow[];
    return rows.map((row) => ({
      ...parsePersistedToolExecutionRecord(JSON.parse(row.record_json)),
      sequence: row.sequence,
    }));
  }

  listRecentToolExecutions(
    threadId: string,
    options: ListRecentEntriesOptions = {},
  ): RecentToolExecutionPage {
    const beforeSequence = options.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? DEFAULT_TOOL_EXECUTION_LIMIT;
    this.validateRecentPage(beforeSequence, limit, MAX_TOOL_EXECUTION_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT sequence, record_json
           FROM tool_executions
          WHERE thread_id = ?
            AND sequence < ?
          ORDER BY sequence DESC
          LIMIT ?`,
      )
      .all(threadId, beforeSequence, limit + 1) as unknown as ToolExecutionRow[];
    const hasMore = rows.length > limit;
    const entries = rows
      .slice(0, limit)
      .map((row) => ({
        ...parsePersistedToolExecutionRecord(JSON.parse(row.record_json)),
        sequence: row.sequence,
      }))
      .reverse();
    return {
      entries,
      nextBeforeSequence: hasMore ? entries[0]?.sequence : undefined,
    };
  }

  getToolExecution(
    threadId: string,
    executionId: string,
  ): SequencedToolExecutionRecord | undefined {
    const row = this.db
      .prepare("SELECT sequence, record_json FROM tool_executions WHERE thread_id = ? AND id = ?")
      .get(threadId, executionId) as ToolExecutionRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      ...parsePersistedToolExecutionRecord(JSON.parse(row.record_json)),
      sequence: row.sequence,
    };
  }

  getTranscriptCompleteness(threadId: string): TranscriptCompleteness {
    const row = this.db
      .prepare("SELECT completeness FROM thread_transcript_state WHERE thread_id = ?")
      .get(threadId) as TranscriptCompletenessRow | undefined;
    if (row?.completeness === COMPACTION_TRANSCRIPT_COMPLETENESS[0]) {
      return COMPACTION_TRANSCRIPT_COMPLETENESS[0];
    }
    return COMPACTION_TRANSCRIPT_COMPLETENESS[1];
  }

  listTranscriptMessages(
    threadId: string,
    options: ListTranscriptMessagesOptions = {},
  ): ArchivedTranscriptMessage[] {
    const afterSequence = options.afterSequence ?? -1;
    const throughSequence = options.throughSequence ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? DEFAULT_TRANSCRIPT_LIMIT;
    this.validateTranscriptRange(afterSequence, throughSequence, limit, MAX_TRANSCRIPT_LIST_LIMIT);
    if (throughSequence <= afterSequence) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT sequence, provenance, created_at, message_json
           FROM transcript_messages
          WHERE thread_id = ?
            AND sequence > ?
            AND sequence <= ?
          ORDER BY sequence ASC
          LIMIT ?`,
      )
      .all(threadId, afterSequence, throughSequence, limit) as unknown as TranscriptMessageRow[];
    return rows.map((row) =>
      archivedTranscriptMessageSchema.parse({
        sequence: row.sequence,
        provenance: row.provenance,
        createdAt: row.created_at,
        message: JSON.parse(row.message_json),
      }),
    );
  }

  listRecentTranscriptMessages(
    threadId: string,
    options: ListRecentEntriesOptions = {},
  ): RecentTranscriptMessagePage {
    const beforeSequence = options.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? DEFAULT_TRANSCRIPT_LIMIT;
    this.validateRecentPage(beforeSequence, limit, MAX_TRANSCRIPT_LIST_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT sequence, provenance, created_at, message_json
           FROM transcript_messages
          WHERE thread_id = ?
            AND sequence < ?
          ORDER BY sequence DESC
          LIMIT ?`,
      )
      .all(threadId, beforeSequence, limit + 1) as unknown as TranscriptMessageRow[];
    const hasMore = rows.length > limit;
    const entries = rows
      .slice(0, limit)
      .map((row) =>
        archivedTranscriptMessageSchema.parse({
          sequence: row.sequence,
          provenance: row.provenance,
          createdAt: row.created_at,
          message: JSON.parse(row.message_json),
        }),
      )
      .reverse();
    return {
      entries,
      nextBeforeSequence: hasMore ? entries[0]?.sequence : undefined,
    };
  }

  getLatestCheckpoint(threadId: string): CompactionCheckpoint | undefined {
    const rows = this.db
      .prepare(
        `SELECT schema_version, checkpoint_json
           FROM compaction_checkpoints
          WHERE thread_id = ?
          ORDER BY generation DESC`,
      )
      .all(threadId) as unknown as CompactionCheckpointRow[];
    for (const row of rows) {
      try {
        return this.withCurrentTranscriptCompleteness(threadId, parseCompactionCheckpointRow(row));
      } catch (error) {
        if (error instanceof UnsupportedCompactionCheckpointVersionError) {
          throw error;
        }
        // A corrupt row must not hide the previous valid checkpoint.
      }
    }
    return undefined;
  }

  getLatestSummaryCheckpoint(threadId: string): CompactionCheckpoint | undefined {
    const rows = this.db
      .prepare(
        `SELECT schema_version, checkpoint_json
           FROM compaction_checkpoints
          WHERE thread_id = ?
          ORDER BY generation DESC`,
      )
      .all(threadId) as unknown as CompactionCheckpointRow[];
    for (const row of rows) {
      try {
        const checkpoint = parseCompactionCheckpointRow(row);
        if (checkpoint.summary.status === "valid") {
          return this.withCurrentTranscriptCompleteness(threadId, checkpoint);
        }
      } catch (error) {
        if (error instanceof UnsupportedCompactionCheckpointVersionError) {
          throw error;
        }
        // Invalid rows are never eligible as the semantic-summary recovery point.
      }
    }
    return undefined;
  }

  getCheckpoint(threadId: string, checkpointId: string): CompactionCheckpoint | undefined {
    const row = this.db
      .prepare(
        `SELECT schema_version, checkpoint_json
           FROM compaction_checkpoints
          WHERE thread_id = ? AND id = ?`,
      )
      .get(threadId, checkpointId) as CompactionCheckpointRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    try {
      return this.withCurrentTranscriptCompleteness(threadId, parseCompactionCheckpointRow(row));
    } catch (error) {
      if (error instanceof UnsupportedCompactionCheckpointVersionError) {
        throw error;
      }
      return undefined;
    }
  }

  loadSessionState(threadId: string): ThreadSessionState {
    if (!this.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    const activeProjection = repairActiveToolProtocol(this.getMessages(threadId));
    return {
      messages: activeProjection.messages,
      checkpoint: this.getLatestCheckpoint(threadId),
      transcriptCompleteness: this.getTranscriptCompleteness(threadId),
    };
  }

  commitCompaction(threadId: string, input: CommitCompactionInput): CompactionCheckpoint {
    if (!this.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    const messages = input.messages.map((message) => modelMessageSchema.parse(message));
    const expectedActiveMessages = input.expectedActiveMessages.map((message) =>
      modelMessageSchema.parse(message),
    );
    const activeProjection = repairActiveToolProtocol(messages);
    if (activeProjection.status !== ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS.valid) {
      const malformedIds = [
        ...activeProjection.removedToolCallIds,
        ...activeProjection.removedToolResultIds,
      ]
        .filter((toolCallId, index, all) => all.indexOf(toolCallId) === index)
        .sort((left, right) => left.localeCompare(right));
      throw new Error(
        `Compaction active projection contains malformed Tool protocol: ${malformedIds.join(", ")}`,
      );
    }
    const parsedDraft = createCompactionCheckpointDraft(input.draft);
    const legacySnapshotTranscriptFragments = legacyCompactionTranscriptFragmentsSchema.parse(
      input.legacySnapshotTranscriptFragments ?? [],
    );
    const legacySnapshotTranscriptMessages = legacyCompactionTranscriptFragmentsSchema
      .parse(legacySnapshotTranscriptFragments.map((fragment) => redactSecretText(fragment)))
      .map((fragment) =>
        modelMessageSchema.parse(createLegacyCompactionTranscriptMessage(fragment)),
      );
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentActiveMessages = repairActiveToolProtocol(this.getMessages(threadId)).messages;
      if (JSON.stringify(currentActiveMessages) !== JSON.stringify(expectedActiveMessages)) {
        throw new Error(
          "Compaction active projection changed after the draft snapshot was captured",
        );
      }
      const previous = this.getLatestCheckpoint(threadId);
      if (previous?.id !== input.expectedLatestCheckpointId) {
        throw new Error(
          "Compaction checkpoint ancestry changed after the draft snapshot was captured",
        );
      }
      const lastValidSummaryCheckpoint = this.getLatestSummaryCheckpoint(threadId);
      const summary = linkLastValidSummaryCheckpoint(
        parsedDraft.summary,
        lastValidSummaryCheckpoint,
      );
      const transcriptCompleteness = this.getTranscriptCompleteness(threadId);
      const draft = createCompactionCheckpointDraft({
        ...parsedDraft,
        summary,
        ...(transcriptCompleteness === COMPACTION_TRANSCRIPT_COMPLETENESS[1] &&
        parsedDraft.toolState.integrityStatus === "valid"
          ? {
              toolState: {
                ...parsedDraft.toolState,
                integrityStatus: "sanitized" as const,
              },
            }
          : {}),
      });
      const generationRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(generation), 0) AS maxGeneration
             FROM compaction_checkpoints
            WHERE thread_id = ?`,
        )
        .get(threadId) as { readonly maxGeneration: number };
      const currentMessageHighWatermark = this.maxTranscriptMessageSequence(threadId);
      const currentToolHighWatermark = this.maxToolExecutionSequence(threadId);
      const messageHighWatermark = input.evidenceWatermarks.transcriptMessagesThroughSequence;
      const toolHighWatermark = input.evidenceWatermarks.toolExecutionsThroughSequence;
      const previousMessageHighWatermark = previous?.transcript.messages.throughSequence ?? -1;
      const previousToolHighWatermark = previous?.transcript.toolExecutions.throughSequence ?? -1;
      const previousSemanticMessageHighWatermark =
        previous?.version === 2 ? previous.semanticEvidence.messagesThroughSequence : -1;
      const previousSemanticToolHighWatermark =
        previous?.version === 2 ? previous.semanticEvidence.toolExecutionsThroughSequence : -1;
      if (legacySnapshotTranscriptMessages.length > 0 && previous?.version !== 1) {
        throw new Error("Legacy snapshot transcript archive requires a V1 parent checkpoint");
      }
      if (
        !Number.isInteger(messageHighWatermark) ||
        messageHighWatermark < previousMessageHighWatermark ||
        messageHighWatermark > currentMessageHighWatermark
      ) {
        throw new Error(
          `Compaction transcript message watermark ${String(messageHighWatermark)} is outside the available range ${String(previousMessageHighWatermark)}-${String(currentMessageHighWatermark)}`,
        );
      }
      if (
        !Number.isInteger(input.semanticEvidenceWatermarks.messagesThroughSequence) ||
        input.semanticEvidenceWatermarks.messagesThroughSequence <
          previousSemanticMessageHighWatermark ||
        input.semanticEvidenceWatermarks.messagesThroughSequence > messageHighWatermark
      ) {
        throw new Error(
          `Compaction semantic message watermark ${String(input.semanticEvidenceWatermarks.messagesThroughSequence)} is outside the available range ${String(previousSemanticMessageHighWatermark)}-${String(messageHighWatermark)}`,
        );
      }
      if (
        !Number.isInteger(input.semanticEvidenceWatermarks.toolExecutionsThroughSequence) ||
        input.semanticEvidenceWatermarks.toolExecutionsThroughSequence <
          previousSemanticToolHighWatermark ||
        input.semanticEvidenceWatermarks.toolExecutionsThroughSequence > toolHighWatermark
      ) {
        throw new Error(
          `Compaction semantic Tool watermark ${String(input.semanticEvidenceWatermarks.toolExecutionsThroughSequence)} is outside the available range ${String(previousSemanticToolHighWatermark)}-${String(toolHighWatermark)}`,
        );
      }
      if (
        !Number.isInteger(toolHighWatermark) ||
        toolHighWatermark < previousToolHighWatermark ||
        toolHighWatermark > currentToolHighWatermark
      ) {
        throw new Error(
          `Compaction tool execution watermark ${String(toolHighWatermark)} is outside the available range ${String(previousToolHighWatermark)}-${String(currentToolHighWatermark)}`,
        );
      }
      let effectiveMessageHighWatermark = messageHighWatermark;
      if (legacySnapshotTranscriptMessages.length > 0) {
        if (messageHighWatermark !== currentMessageHighWatermark) {
          throw new Error(
            "Legacy snapshot transcript archive requires the latest message watermark",
          );
        }
        const insertLegacySnapshot = this.db.prepare(
          `INSERT INTO transcript_messages
             (thread_id, sequence, role, message_json, provenance, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        let sequence = currentMessageHighWatermark + 1;
        for (const message of legacySnapshotTranscriptMessages) {
          insertLegacySnapshot.run(
            threadId,
            sequence,
            message.role,
            JSON.stringify(message),
            TRANSCRIPT_MESSAGE_PROVENANCES[1],
            now,
          );
          sequence += 1;
        }
        effectiveMessageHighWatermark = sequence - 1;
      }
      const transcript: CompactionTranscript = {
        messages: {
          fromSequenceExclusive: previousMessageHighWatermark,
          throughSequence: effectiveMessageHighWatermark,
        },
        toolExecutions: {
          fromSequenceExclusive: previousToolHighWatermark,
          throughSequence: toolHighWatermark,
        },
        completeness: transcriptCompleteness,
      };
      const checkpoint = createCompactionCheckpoint({
        draft,
        semanticState: input.semanticState,
        semanticEvidence: input.semanticEvidenceWatermarks,
        generation: generationRow.maxGeneration + 1,
        transcript,
        ...(previous !== undefined ? { previousCheckpointId: previous.id } : {}),
        createdAt: now,
      });
      this.db
        .prepare(
          `INSERT INTO compaction_checkpoints
             (id, thread_id, generation, schema_version,
              message_from_sequence, message_through_sequence,
              tool_from_sequence, tool_through_sequence,
              checkpoint_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checkpoint.id,
          threadId,
          checkpoint.generation,
          checkpoint.version,
          checkpoint.transcript.messages.fromSequenceExclusive,
          checkpoint.transcript.messages.throughSequence,
          checkpoint.transcript.toolExecutions.fromSequenceExclusive,
          checkpoint.transcript.toolExecutions.throughSequence,
          JSON.stringify(checkpoint),
          checkpoint.createdAt,
        );
      this.replaceMessagesInTransaction(threadId, messages, now);
      this.db.exec("COMMIT");
      return checkpoint;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readCheckpointTranscript(
    threadId: string,
    options: ReadCheckpointTranscriptOptions,
  ): CheckpointTranscriptPage {
    if (options.kind !== "message" && options.kind !== "tool_execution") {
      throw new Error("kind 必须是 message 或 tool_execution");
    }
    const checkpoint = this.getCheckpoint(threadId, options.checkpointId);
    if (checkpoint === undefined) {
      throw new Error("checkpoint 不存在、已损坏或不属于当前 thread");
    }
    const limit = options.limit ?? DEFAULT_TRANSCRIPT_LIMIT;
    const range =
      options.kind === "message"
        ? checkpoint.transcript.messages
        : checkpoint.transcript.toolExecutions;
    const afterSequence = Math.max(
      options.afterSequence ?? range.fromSequenceExclusive,
      range.fromSequenceExclusive,
    );
    this.validateTranscriptRange(
      afterSequence,
      range.throughSequence,
      limit,
      MAX_TRANSCRIPT_PAGE_LIMIT,
    );

    const candidates: CheckpointTranscriptEntry[] =
      options.kind === "message"
        ? this.listTranscriptMessages(threadId, {
            afterSequence,
            throughSequence: range.throughSequence,
            limit: limit + 1,
          }).map((entry) => ({ kind: "message" as const, ...entry }))
        : this.listToolExecutions(threadId, {
            afterSequence,
            throughSequence: range.throughSequence,
            limit: Math.min(limit + 1, MAX_TOOL_EXECUTION_LIMIT),
          }).map((entry) => ({ kind: "tool_execution" as const, ...entry }));
    const hasMore = candidates.length > limit;
    const entries = hasMore ? candidates.slice(0, limit) : candidates;
    const lastSequence = entries.at(-1)?.sequence;
    return {
      checkpointId: checkpoint.id,
      kind: options.kind,
      entries,
      ...(hasMore && lastSequence !== undefined ? { nextAfterSequence: lastSequence } : {}),
      ...(checkpoint.previousCheckpointId !== undefined
        ? { previousCheckpointId: checkpoint.previousCheckpointId }
        : {}),
      completeness: checkpoint.transcript.completeness,
    };
  }

  private maxTranscriptMessageSequence(threadId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), -1) AS maxSequence FROM transcript_messages WHERE thread_id = ?",
      )
      .get(threadId) as { readonly maxSequence: number };
    return row.maxSequence;
  }

  private maxToolExecutionSequence(threadId: string): number {
    const row = this.db
      .prepare("SELECT next_sequence FROM thread_tool_execution_state WHERE thread_id = ?")
      .get(threadId) as ToolExecutionSequenceStateRow | undefined;
    return (row?.next_sequence ?? 0) - 1;
  }

  private withCurrentTranscriptCompleteness(
    threadId: string,
    checkpoint: CompactionCheckpoint,
  ): CompactionCheckpoint {
    const legacy = COMPACTION_TRANSCRIPT_COMPLETENESS[1];
    const completeness =
      checkpoint.transcript.completeness === legacy ||
      this.getTranscriptCompleteness(threadId) === legacy
        ? legacy
        : COMPACTION_TRANSCRIPT_COMPLETENESS[0];
    const toolState =
      completeness === legacy && checkpoint.toolState.integrityStatus === "valid"
        ? { ...checkpoint.toolState, integrityStatus: "sanitized" as const }
        : checkpoint.toolState;
    if (checkpoint.transcript.completeness === completeness && checkpoint.toolState === toolState) {
      return checkpoint;
    }
    return {
      ...checkpoint,
      toolState,
      transcript: {
        ...checkpoint.transcript,
        completeness,
      },
    };
  }

  private validateTranscriptRange(
    afterSequence: number,
    throughSequence: number,
    limit: number,
    maxLimit: number,
  ): void {
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      throw new Error("afterSequence 必须是大于等于 -1 的整数");
    }
    if (!Number.isInteger(throughSequence) || throughSequence < -1) {
      throw new Error("throughSequence 必须是大于等于 -1 的整数");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      throw new Error(`limit 必须是 1-${String(maxLimit)} 之间的整数`);
    }
  }

  private validateRecentPage(beforeSequence: number, limit: number, maxLimit: number): void {
    if (
      !Number.isSafeInteger(beforeSequence) ||
      beforeSequence < 0 ||
      beforeSequence > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("beforeSequence 必须是非负安全整数");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      throw new Error(`limit 必须是 1-${String(maxLimit)} 之间的整数`);
    }
  }

  close(): void {
    this.db.close();
  }
}
