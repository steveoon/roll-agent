import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  COMPACTION_SEMANTIC_ITEM_KINDS,
  semanticArchiveItemSchema,
  type SemanticArchiveItem,
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
export const contextRecoveryNoteSchema = z.object({
  checkpointId: z.string().uuid(),
  notes: z.string(),
});
export type ContextRecoveryNote = z.infer<typeof contextRecoveryNoteSchema>;
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
const sequencedLedgerRowSchema = ledgerRowSchema.extend({
  sequence: z.number().int().positive().safe(),
});

/** Compatibility reader/importer for historical V2 records. New checkpoints never append here. */
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

  /** Stable ordinals within an immutable checkpoint generation; fetch only the requested page. */
  page(threadId: string, generation: number, afterSequence: number, limit: number) {
    return this.db
      .prepare(
        `WITH versions AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY generation DESC) AS rank
          FROM compaction_semantic_items WHERE thread_id = ? AND generation <= ?
        ), items AS (
          SELECT *, ROW_NUMBER() OVER (ORDER BY item_id) AS sequence FROM versions WHERE rank = 1
        )
        SELECT sequence,item_id,generation,scope,category,status,first_tool_sequence,item_json,resolution_json
        FROM items WHERE sequence > ? ORDER BY sequence LIMIT ?`,
      )
      .all(threadId, generation, afterSequence, limit)
      .map((row) => sequencedLedgerRowSchema.parse(row));
  }

  notes(threadId: string): ContextRecoveryNote[] {
    return this.db
      .prepare(
        "SELECT checkpoint_id AS checkpointId, notes FROM compaction_recovery_notes WHERE thread_id=? ORDER BY checkpoint_id",
      )
      .all(threadId)
      .map((row) => contextRecoveryNoteSchema.parse(row));
  }
  append(
    threadId: string,
    generation: number,
    scope: string,
    toolWatermark: number,
    items: readonly SemanticArchiveItem[],
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
}
