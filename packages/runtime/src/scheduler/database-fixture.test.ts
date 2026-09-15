import { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import { registerSchedulerWriter } from "./database-version.ts";

/** Raw SQL for deliberate test fixture mutation, using the current writer contract. */
export class DatabaseSync extends NativeDatabaseSync {
  constructor(...args: ConstructorParameters<typeof NativeDatabaseSync>) {
    super(...args);
    registerSchedulerWriter(this);
  }
}
