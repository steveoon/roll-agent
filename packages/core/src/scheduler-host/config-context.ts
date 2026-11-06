import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  scheduleHostContextSchema,
  type ScheduleHostContext,
} from "@roll-agent/runtime/host-contracts";
import { loadConfig } from "../config/loader.ts";
import {
  loadRuntimeConfig,
  runtimeConfigContextSchema,
  type RuntimeConfigContext,
} from "../config/runtime-context.ts";

export function encodeScheduleHostContext(context: RuntimeConfigContext): ScheduleHostContext {
  return scheduleHostContextSchema.parse(JSON.stringify(runtimeConfigContextSchema.parse(context)));
}
export function decodeScheduleHostContext(value: ScheduleHostContext): RuntimeConfigContext {
  try {
    return runtimeConfigContextSchema.parse(JSON.parse(scheduleHostContextSchema.parse(value)));
  } catch (cause) {
    throw new Error("Invalid scheduled configuration context; refusing cwd fallback", { cause });
  }
}
export function loadScheduleConfig(schedule: {
  readonly cwd: string;
  readonly hostContext?: ScheduleHostContext;
}) {
  return schedule.hostContext === undefined
    ? loadConfig({ cwd: schedule.cwd })
    : loadRuntimeConfig(decodeScheduleHostContext(schedule.hostContext));
}

/** Process-private approval identity, never stored in the ledger or returned as tool output. */
export function scheduleConfigRevision(
  cwd: string,
  hostContext: ScheduleHostContext,
  key: Uint8Array,
): string {
  const context = decodeScheduleHostContext(hostContext);
  const loaded = loadScheduleConfig({ cwd, hostContext });
  return createHmac("sha256", key)
    .update(JSON.stringify([readFileSync(context.configPath, "utf8"), loaded.config]))
    .digest("hex");
}
