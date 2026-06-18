import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { modelMessageSchema, type ModelMessage } from "ai";

const SCHEMA_VERSION = 1;

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

export function expandTilde(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

export function defaultThreadsDir(): string {
  return resolve(homedir(), ".roll-agent", "threads");
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
      mkdirSync(resolved, { recursive: true });
    }
    this.db = new DatabaseSync(resolve(resolved, "threads.db"));
    this.init();
  }

  private init(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
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
       );
       PRAGMA user_version = ${String(SCHEMA_VERSION)};`,
    );
  }

  createThread(input: CreateThreadInput = {}): string {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO threads (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.title ?? null, input.model ?? null, now, now);
    return id;
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
    const startRow = this.db
      .prepare("SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM messages WHERE thread_id = ?")
      .get(threadId) as { readonly maxIdx: number };
    let idx = startRow.maxIdx + 1;
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT INTO messages (thread_id, idx, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      for (const message of messages) {
        insert.run(threadId, idx, message.role, JSON.stringify(message), now);
        idx += 1;
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
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT INTO messages (thread_id, idx, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
      messages.forEach((message, idx) => {
        insert.run(threadId, idx, message.role, JSON.stringify(message), now);
      });
      this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
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

  close(): void {
    this.db.close();
  }
}
