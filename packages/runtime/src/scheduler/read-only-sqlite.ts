import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";

export function enableSchedulerQueryOnly(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 15000; PRAGMA query_only = ON;");
  if (db.prepare("PRAGMA query_only").get()?.query_only !== 1) {
    throw new Error("无法启用 scheduler SQL 只读保护");
  }
}

/** Native readOnly where supported, plus SQL-level protection on every supported Node. */
export function openReadOnlySchedulerDatabase(path: string): DatabaseSync {
  // On old Node, readOnly is ignored. Do not intentionally create an absent ledger.
  // query_only blocks SQL writes, but is not a file-level read-only/recovery guarantee.
  if (!statSync(path).isFile()) throw new Error("scheduler 账本路径不是文件");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    enableSchedulerQueryOnly(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
