import type { DatabaseSync } from "node:sqlite";

export const SCHEDULER_SCHEMA_VERSION = 9;
const WRITER_MARKER = `roll_scheduler_writer_v${String(SCHEDULER_SCHEMA_VERSION)}`;

/** Connection-local compatibility marker, not an authorization or security boundary. */
export function registerSchedulerWriter(db: DatabaseSync): void {
  // ATTACH works on Node 22.6; DatabaseSync.function was only added in 22.13.
  // The empty attached database is connection-local and contains no durable state.
  db.exec(`ATTACH DATABASE ':memory:' AS ${WRITER_MARKER}`);
}

/** user_version cannot fence a pre-upgrade connection; persisted triggers can. */
export function installSchedulerWriterGuards(db: DatabaseSync): void {
  for (const table of ["schedules", "invocations", "schedule_thread_refs", "schedule_extensions"]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const name = `scheduler_writer_${table}_${operation.toLowerCase()}`;
      const sql =
        `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} ` +
        `WHEN NOT EXISTS (SELECT 1 FROM pragma_database_list WHERE name = '${WRITER_MARKER}') ` +
        "BEGIN SELECT RAISE(ABORT, 'scheduler writer version mismatch: restart Roll scheduler'); END";
      const existing = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get(name);
      if (existing?.sql === sql) continue;
      if (existing !== undefined) db.exec(`DROP TRIGGER ${name}`);
      db.exec(sql);
    }
  }
}
