import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { modelMessageSchema, type ModelMessage } from "ai";
import {
  parseToolExecutionRecord,
  type ToolExecutionRecord,
} from "../tool-bridge/tool-execution-record.ts";
import {
  COMPACTION_TRANSCRIPT_COMPLETENESS,
  TRANSCRIPT_MESSAGE_PROVENANCES,
  archivedTranscriptMessageSchema,
  createCompactionCheckpoint,
  createCompactionCheckpointDraft,
  parseCompactionCheckpoint,
  type ArchivedTranscriptMessage,
  type CompactionCheckpoint,
  type CompactionCheckpointDraftInput,
  type CompactionSummary,
  type CompactionTranscript,
} from "../engine/compaction-checkpoint.ts";
import {
  ACTIVE_TOOL_PROTOCOL_REPAIR_STATUS,
  repairActiveToolProtocol,
} from "../engine/tool-protocol-repair.ts";

const SCHEMA_VERSION = 3;
const DEFAULT_TOOL_EXECUTION_LIMIT = 100;
const MAX_TOOL_EXECUTION_LIMIT = 500;
const DEFAULT_TRANSCRIPT_LIMIT = 50;
const MAX_TRANSCRIPT_LIST_LIMIT = 500;
const MAX_TRANSCRIPT_PAGE_LIMIT = 100;

export const TRANSCRIPT_ENTRY_KINDS = ["message", "tool_execution"] as const;
export type TranscriptEntryKind = (typeof TRANSCRIPT_ENTRY_KINDS)[number];
export type TranscriptCompleteness = (typeof COMPACTION_TRANSCRIPT_COMPLETENESS)[number];

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

interface TranscriptMessageRow {
  readonly sequence: number;
  readonly provenance: string;
  readonly created_at: string;
  readonly message_json: string;
}

interface CompactionCheckpointRow {
  readonly checkpoint_json: string;
}

interface TranscriptCompletenessRow {
  readonly completeness: string;
}

export type SequencedToolExecutionRecord = ToolExecutionRecord & {
  readonly sequence: number;
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
  readonly evidenceWatermarks: CompactionEvidenceWatermarks;
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

function toRecord(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    title: row.title ?? undefined,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ThreadStore {
  private readonly db: DatabaseSync;

  constructor(dir: string = defaultThreadsDir()) {
    const resolved = expandTilde(dir);
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") {
      // ToolExecutionRecord intentionally retains raw protocol evidence. Keep both an existing
      // configured directory and newly created stores private instead of relying on the host umask.
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
    this.db.exec("PRAGMA foreign_keys = ON;");
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
             ON compaction_checkpoints(thread_id, generation DESC);`,
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
      this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)};`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
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

  updateTitle(threadId: string, title: string): void {
    this.db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, threadId);
  }

  deleteThread(threadId: string): void {
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  }

  appendMessages(threadId: string, messages: readonly ModelMessage[]): void {
    if (messages.length === 0) {
      return;
    }
    if (!this.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    const parsedMessages = messages.map((message) => modelMessageSchema.parse(message));
    const now = new Date().toISOString();
    const insertActive = this.db.prepare(
      "INSERT INTO messages (thread_id, idx, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertTranscript = this.db.prepare(
      `INSERT INTO transcript_messages
         (thread_id, sequence, role, message_json, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
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
      for (const message of parsedMessages) {
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
      this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
      insert.run(threadId, idx, message.role, JSON.stringify(message), now);
    });
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
  }

  appendToolExecution(threadId: string, record: ToolExecutionRecord): number {
    if (!this.hasThread(threadId)) {
      throw new Error(`Thread "${threadId}" 不存在`);
    }
    const parsed = parseToolExecutionRecord(record);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sequenceRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), -1) AS maxSequence FROM tool_executions WHERE thread_id = ?",
        )
        .get(threadId) as { readonly maxSequence: number };
      const sequence = sequenceRow.maxSequence + 1;
      this.db
        .prepare(
          `INSERT INTO tool_executions
             (thread_id, sequence, id, tool_call_id, agent_name, tool_name, record_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          sequence,
          parsed.id,
          parsed.toolCallId,
          parsed.agentName,
          parsed.toolName,
          JSON.stringify(parsed),
          parsed.createdAt,
        );
      this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
      this.db.exec("COMMIT");
      return sequence;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listToolExecutions(
    threadId: string,
    options: ListToolExecutionsOptions = {},
  ): SequencedToolExecutionRecord[] {
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
      ...parseToolExecutionRecord(JSON.parse(row.record_json)),
      sequence: row.sequence,
    }));
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
      ...parseToolExecutionRecord(JSON.parse(row.record_json)),
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

  getLatestCheckpoint(threadId: string): CompactionCheckpoint | undefined {
    const rows = this.db
      .prepare(
        `SELECT checkpoint_json
           FROM compaction_checkpoints
          WHERE thread_id = ?
          ORDER BY generation DESC`,
      )
      .all(threadId) as unknown as CompactionCheckpointRow[];
    for (const row of rows) {
      try {
        return parseCompactionCheckpoint(JSON.parse(row.checkpoint_json));
      } catch {
        // A corrupt or unsupported newest row must not hide the previous valid checkpoint.
      }
    }
    return undefined;
  }

  getLatestSummaryCheckpoint(threadId: string): CompactionCheckpoint | undefined {
    const rows = this.db
      .prepare(
        `SELECT checkpoint_json
           FROM compaction_checkpoints
          WHERE thread_id = ?
          ORDER BY generation DESC`,
      )
      .all(threadId) as unknown as CompactionCheckpointRow[];
    for (const row of rows) {
      try {
        const checkpoint = parseCompactionCheckpoint(JSON.parse(row.checkpoint_json));
        if (checkpoint.summary.status === "valid") {
          return checkpoint;
        }
      } catch {
        // Invalid rows are never eligible as the semantic-summary recovery point.
      }
    }
    return undefined;
  }

  getCheckpoint(threadId: string, checkpointId: string): CompactionCheckpoint | undefined {
    const row = this.db
      .prepare(
        `SELECT checkpoint_json
           FROM compaction_checkpoints
          WHERE thread_id = ? AND id = ?`,
      )
      .get(threadId, checkpointId) as CompactionCheckpointRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    try {
      return parseCompactionCheckpoint(JSON.parse(row.checkpoint_json));
    } catch {
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
      const draft = createCompactionCheckpointDraft({ ...parsedDraft, summary });
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
        !Number.isInteger(toolHighWatermark) ||
        toolHighWatermark < previousToolHighWatermark ||
        toolHighWatermark > currentToolHighWatermark
      ) {
        throw new Error(
          `Compaction tool execution watermark ${String(toolHighWatermark)} is outside the available range ${String(previousToolHighWatermark)}-${String(currentToolHighWatermark)}`,
        );
      }
      const transcript: CompactionTranscript = {
        messages: {
          fromSequenceExclusive: previousMessageHighWatermark,
          throughSequence: messageHighWatermark,
        },
        toolExecutions: {
          fromSequenceExclusive: previousToolHighWatermark,
          throughSequence: toolHighWatermark,
        },
        completeness: this.getTranscriptCompleteness(threadId),
      };
      const checkpoint = createCompactionCheckpoint({
        draft,
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
      .prepare(
        "SELECT COALESCE(MAX(sequence), -1) AS maxSequence FROM tool_executions WHERE thread_id = ?",
      )
      .get(threadId) as { readonly maxSequence: number };
    return row.maxSequence;
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

  close(): void {
    this.db.close();
  }
}
