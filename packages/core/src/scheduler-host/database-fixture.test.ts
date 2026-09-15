import { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import { SCHEDULER_SCHEMA_VERSION } from "@roll-agent/runtime";

/** Test fixtures deliberately write raw SQL using the current scheduler writer contract. */
export class DatabaseSync extends NativeDatabaseSync {
  constructor(...args: ConstructorParameters<typeof NativeDatabaseSync>) {
    super(...args);
    this.exec(
      `ATTACH DATABASE ':memory:' AS roll_scheduler_writer_v${String(SCHEDULER_SCHEMA_VERSION)}`,
    );
  }
}
