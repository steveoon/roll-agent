import type { DatabaseSync } from "node:sqlite";
import type { ContextRecoveryView } from "@roll-agent/protocol";
import { z } from "zod";
import {
  COMPACTION_SEMANTIC_ITEM_KINDS,
  CONTEXT_READ_CHUNK_CHARS,
  semanticArchiveItemSchema,
  type SemanticArchiveItem,
  type CompactionSemanticResolution,
} from "../engine/compaction-semantic-state.ts";

export const SEMANTIC_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS compaction_semantic_items (
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL, generation INTEGER NOT NULL, scope TEXT NOT NULL,
 category TEXT NOT NULL, status TEXT NOT NULL, first_tool_sequence INTEGER NOT NULL,
 item_json TEXT NOT NULL, resolution_json TEXT,
 PRIMARY KEY (thread_id, item_id, generation)
);
CREATE INDEX IF NOT EXISTS idx_semantic_scope ON compaction_semantic_items(thread_id, scope, generation);
CREATE TABLE IF NOT EXISTS compaction_recovery (
 thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
 checkpoint_id TEXT NOT NULL, required INTEGER NOT NULL, unextracted INTEGER NOT NULL,
 memo TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS compaction_recovery_reads (
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 checkpoint_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL,
 version INTEGER NOT NULL, offset INTEGER NOT NULL, finished INTEGER NOT NULL,
 PRIMARY KEY (thread_id, checkpoint_id, kind, item_id, version, offset)
);
CREATE TABLE IF NOT EXISTS compaction_recovery_notes (
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 checkpoint_id TEXT NOT NULL,
 notes TEXT NOT NULL,
 PRIMARY KEY (thread_id, checkpoint_id)
);`;

export const contextReadInputSchema = z
  .object({
    checkpointId: z.string().uuid(),
    kind: z.enum(["semantic", "message", "tool_execution"]).default("semantic"),
    category: z.enum(COMPACTION_SEMANTIC_ITEM_KINDS).optional(),
    scope: z.string().max(128).optional(),
    version: z.number().int().min(1).optional(),
    itemId: z.string().max(128).optional(),
    query: z.string().min(1).max(256).optional(),
    cursor: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(20).default(10),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ContextReadInput = z.infer<typeof contextReadInputSchema>;
export interface ContextReadEntry {
  readonly id: string;
  readonly content: string;
  readonly version: number;
}
export const contextSourceStatusSchema = z.object({
  archivedThrough: z.number().int(),
  semanticallyExtractedThrough: z.number().int(),
  archivedToolsThrough: z.number().int(),
  semanticallyExtractedToolsThrough: z.number().int(),
  completeness: z.enum(["complete", "legacy_snapshot"]),
});
export interface ContextReadPage {
  readonly sourceStatus: z.infer<typeof contextSourceStatusSchema>;
  readonly checkpointId: string;
  readonly entries: readonly ContextReadEntry[];
  readonly nextCursor?: string;
  readonly nextOffset?: number;
  readonly notice: string;
}
export type ContextReader = (input: ContextReadInput) => ContextReadPage;
export { CONTEXT_READ_CHUNK_CHARS };
/**
 * One recovery read returns and records this many unread goal/constraint items.
 * 27 items then take 3 steps, leaving the reserved ready and follow-up steps
 * inside a 24-step turn.
 */
export const RECOVERY_PAGE_ITEMS = 9;
export const RECOVERY_READY_STEPS = 1;
export const RECOVERY_WORK_STEPS = 4;
export const RECOVERY_RESERVED_STEPS = RECOVERY_READY_STEPS + RECOVERY_WORK_STEPS;
export const RECOVERY_NOTES_MAX_CHARS = 3_800;
export const recoveryReadSegmentSchema = z.object({
  checkpointId: z.string().uuid(),
  kind: z.enum(["semantic", "message", "tool_execution"]),
  itemId: z.string().min(1).max(128),
  version: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  finished: z.boolean(),
});
export type RecoveryReadSegment = z.infer<typeof recoveryReadSegmentSchema>;

/** A finished offset counts only when every earlier page of that item was stored. */
export function readSegmentCovered(
  segments: readonly RecoveryReadSegment[],
  itemId: string,
  version: number,
  kind: RecoveryReadSegment["kind"] = "semantic",
): boolean {
  const rows = segments.filter(
    (segment) => segment.kind === kind && segment.itemId === itemId && segment.version === version,
  );
  const finished = rows.filter((segment) => segment.finished).map((segment) => segment.offset);
  if (finished.length === 0) return false;
  const end = Math.max(...finished);
  for (let offset = 0; offset <= end; offset += CONTEXT_READ_CHUNK_CHARS) {
    if (!rows.some((segment) => segment.offset === offset)) return false;
  }
  return true;
}
export const contextRecoveryItemSchema = z.object({
  itemId: z.string(),
  version: z.number().int().positive(),
  category: z.enum(["goal", "constraint"]),
});
export const recoveryStateSchema = z.object({
  checkpointId: z.string().uuid(),
  required: z.boolean(),
  unextracted: z.boolean(),
  memo: z.string(),
  // Derived from the immutable checkpoint generation and its durable ledger.
  requiredItems: z.array(contextRecoveryItemSchema).default([]),
});
export type ContextRecoveryState = z.infer<typeof recoveryStateSchema>;
export function projectContextRecovery(
  state: ContextRecoveryState | undefined,
): ContextRecoveryView | null {
  return state
    ? {
        checkpointId: state.checkpointId,
        required: state.required,
        unextracted: state.unextracted,
        requiredItemCount: state.requiredItems.length,
      }
    : null;
}
export const ledgerRowSchema = z.object({
  item_id: z.string(),
  generation: z.number(),
  scope: z.string(),
  category: z.enum(COMPACTION_SEMANTIC_ITEM_KINDS),
  status: z.string(),
  resolution_json: z.string().nullable().optional(),
  first_tool_sequence: z.number(),
  item_json: z.string(),
});
export type SemanticLedgerRow = z.infer<typeof ledgerRowSchema>;

/** The caller owns the transaction: never retire sources before this append succeeds. */
export class SemanticLedger {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  rows(threadId: string, generation: number, itemId?: string): SemanticLedgerRow[] {
    return this.db
      .prepare(
        `SELECT item_id, generation, scope, category, status, first_tool_sequence, item_json, resolution_json
      FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY generation DESC) AS rank
        FROM compaction_semantic_items WHERE thread_id = ? AND generation <= ? ${itemId ? "AND item_id = ?" : ""})
      WHERE rank = 1 ORDER BY item_id`,
      )
      .all(threadId, generation, ...(itemId ? [itemId] : []))
      .map((row) => ledgerRowSchema.parse(row));
  }
  append(
    threadId: string,
    generation: number,
    scope: string,
    toolWatermark: number,
    items: readonly SemanticArchiveItem[],
    resolutions: readonly CompactionSemanticResolution[] = [],
    historical = false,
  ): void {
    const previous = new Map(this.rows(threadId, generation).map((row) => [row.item_id, row]));
    const write = this.db.prepare(`INSERT INTO compaction_semantic_items
      (thread_id,item_id,generation,scope,category,status,first_tool_sequence,item_json)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,item_id,generation) DO UPDATE SET
      item_json=excluded.item_json,status=excluded.status,category=excluded.category`);
    for (const raw of items) {
      const { category, item } = semanticArchiveItemSchema.parse(raw);
      const old = previous.get(item.id);
      const json = JSON.stringify(item);
      if (old?.item_json === json && !(old.status === "historical_unknown" && !historical)) {
        continue;
      }
      write.run(
        threadId,
        item.id,
        generation,
        scope,
        category,
        historical ? "historical_unknown" : category === "completed_work" ? "completed" : "active",
        old?.first_tool_sequence ?? toolWatermark,
        json,
      );
    }
    for (const resolution of resolutions) {
      const old = previous.get(resolution.targetItemId);
      if (!old) continue;
      write.run(
        threadId,
        old.item_id,
        generation,
        old.scope,
        old.category,
        resolution.action,
        old.first_tool_sequence,
        old.item_json,
      );
      this.db
        .prepare(
          "UPDATE compaction_semantic_items SET resolution_json=? WHERE thread_id=? AND item_id=? AND generation=?",
        )
        .run(JSON.stringify(resolution), threadId, old.item_id, generation);
    }
  }
  clearRecovery(threadId: string): void {
    this.db.prepare("DELETE FROM compaction_recovery WHERE thread_id=?").run(threadId);
  }
  versions(threadId: string, itemId?: string): SemanticLedgerRow[] {
    return this.db
      .prepare(
        `SELECT item_id,generation,scope,category,status,first_tool_sequence,item_json,resolution_json
      FROM compaction_semantic_items WHERE thread_id=? ${itemId ? "AND item_id=?" : ""} ORDER BY generation,item_id`,
      )
      .all(threadId, ...(itemId ? [itemId] : []))
      .map((row) => ledgerRowSchema.parse(row));
  }
  restore(threadId: string, rows: readonly SemanticLedgerRow[]): void {
    const write = this.db.prepare(`INSERT INTO compaction_semantic_items
      (thread_id,item_id,generation,scope,category,status,first_tool_sequence,item_json,resolution_json) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const raw of rows) {
      const row = ledgerRowSchema.parse(raw);
      semanticArchiveItemSchema.parse({ category: row.category, item: JSON.parse(row.item_json) });
      write.run(
        threadId,
        row.item_id,
        row.generation,
        row.scope,
        row.category,
        row.status,
        row.first_tool_sequence,
        row.item_json,
        row.resolution_json ?? null,
      );
    }
  }
  recovery(threadId: string): ContextRecoveryState | undefined {
    const raw = this.db
      .prepare(
        `SELECT checkpoint_id,required,unextracted,memo FROM compaction_recovery WHERE thread_id=?`,
      )
      .get(threadId);
    if (!raw) return undefined;
    return recoveryStateSchema.parse({
      checkpointId: raw.checkpoint_id,
      required: raw.required === 1,
      unextracted: raw.unextracted === 1,
      memo: raw.memo,
    });
  }
  requireRecovery(threadId: string, checkpointId: string, unextracted: boolean): void {
    this.db
      .prepare(
        `INSERT INTO compaction_recovery(thread_id,checkpoint_id,required,unextracted,memo)
      VALUES (?,?,1,?,'') ON CONFLICT(thread_id) DO UPDATE SET checkpoint_id=excluded.checkpoint_id,
      required=1,unextracted=excluded.unextracted,memo=''`,
      )
      .run(threadId, checkpointId, Number(unextracted));
  }
  ready(threadId: string, checkpointId: string, memo: string): void {
    const result = this.db
      .prepare(
        `UPDATE compaction_recovery SET required=0,memo=?
      WHERE thread_id=? AND checkpoint_id=? AND required=1`,
      )
      .run(memo, threadId, checkpointId);
    if (result.changes !== 1) {
      throw new Error("Recovery checkpoint changed; read the current checkpoint again");
    }
  }
  recordSegment(threadId: string, segment: RecoveryReadSegment): void {
    const row = recoveryReadSegmentSchema.parse(segment);
    this.db
      .prepare(
        `INSERT INTO compaction_recovery_reads
          (thread_id, checkpoint_id, kind, item_id, version, offset, finished)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, checkpoint_id, kind, item_id, version, offset)
         DO UPDATE SET finished = excluded.finished`,
      )
      .run(
        threadId,
        row.checkpointId,
        row.kind,
        row.itemId,
        row.version,
        row.offset,
        Number(row.finished),
      );
  }
  notes(threadId: string, checkpointId: string): string {
    const raw = this.db
      .prepare(
        `SELECT notes FROM compaction_recovery_notes WHERE thread_id = ? AND checkpoint_id = ?`,
      )
      .get(threadId, checkpointId);
    return typeof raw?.notes === "string" ? raw.notes : "";
  }
  saveNotes(threadId: string, checkpointId: string, notes: string): void {
    const bounded = notes.slice(0, RECOVERY_NOTES_MAX_CHARS);
    this.db
      .prepare(
        `INSERT INTO compaction_recovery_notes (thread_id, checkpoint_id, notes)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_id, checkpoint_id) DO UPDATE SET notes = excluded.notes`,
      )
      .run(threadId, checkpointId, bounded);
  }
  segments(threadId: string, checkpointId: string): RecoveryReadSegment[] {
    return this.db
      .prepare(
        `SELECT checkpoint_id, kind, item_id, version, offset, finished
           FROM compaction_recovery_reads
          WHERE thread_id = ? AND checkpoint_id = ?
          ORDER BY kind, item_id, version, offset`,
      )
      .all(threadId, checkpointId)
      .map((row) =>
        recoveryReadSegmentSchema.parse({
          checkpointId: row.checkpoint_id,
          kind: row.kind,
          itemId: row.item_id,
          version: row.version,
          offset: row.offset,
          finished: row.finished === 1,
        }),
      );
  }
}

/** Match transcript-tool disclosure rules without clipping the durable source. */
export function safeContextText(value: unknown): string {
  const hidden = new Set(["_meta", "providerOptions", "providerMetadata", "raw", "input"]);
  return JSON.stringify(value, (key: string, item: unknown): unknown => {
    if (hidden.has(key)) return "[redacted]";
    if (key === "data") return "[binary data omitted]";
    return item;
  });
}
