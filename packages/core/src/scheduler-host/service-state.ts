import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { schedulerConfigSchema } from "../config/schema.ts";
import { WINDOWS_SCHEDULER_TASK_NAME } from "./paths.ts";

export const SCHEDULER_SERVICE_STATE_SCHEMA_VERSION = 1 as const;
export const SCHEDULER_SERVICE_STATE_PHASES = {
  installing: "installing",
  installed: "installed",
} as const;
export type SchedulerServiceStatePhase =
  (typeof SCHEDULER_SERVICE_STATE_PHASES)[keyof typeof SCHEDULER_SERVICE_STATE_PHASES];

export interface SchedulerServiceBinary {
  readonly command: string;
  readonly cliEntrypoint: string;
  readonly rollVersion: string;
}

export interface SchedulerServiceStateSnapshot {
  readonly schemaVersion: typeof SCHEDULER_SERVICE_STATE_SCHEMA_VERSION;
  readonly phase: SchedulerServiceStatePhase;
  readonly dataDir: string;
  readonly maxConcurrentRuns: number;
  readonly generation?: string;
  readonly binary?: SchedulerServiceBinary;
}

export interface SchedulerServiceState extends SchedulerServiceStateSnapshot {
  readonly replacementFrom?: SchedulerServiceStateSnapshot;
}

export type SchedulerServiceStateInspection =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly state: SchedulerServiceState }
  | { readonly status: "invalid"; readonly error: string };

export function schedulerServiceStatePath(homeDir: string = homedir()): string {
  return resolve(homeDir, ".roll-agent", "scheduler-service.json");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseSchedulerServiceBinary(
  value: unknown,
): { readonly binary?: SchedulerServiceBinary } | undefined {
  if (value === undefined) {
    return {};
  }
  if (
    !isRecordObject(value) ||
    !isNonEmptyString(value.command) ||
    !isNonEmptyString(value.cliEntrypoint) ||
    !isNonEmptyString(value.rollVersion) ||
    !isAbsolute(value.command) ||
    !isAbsolute(value.cliEntrypoint)
  ) {
    return undefined;
  }
  return {
    binary: {
      command: value.command.trim(),
      cliEntrypoint: value.cliEntrypoint.trim(),
      rollVersion: value.rollVersion.trim(),
    },
  };
}

function parseSchedulerServiceStateSnapshot(
  value: unknown,
): SchedulerServiceStateSnapshot | undefined {
  if (!isRecordObject(value)) {
    return undefined;
  }
  const binary = parseSchedulerServiceBinary(value.binary);
  const generation = value.generation;
  const maxConcurrentRuns = schedulerConfigSchema.shape.maxConcurrentRuns.safeParse(
    value.maxConcurrentRuns,
  );
  return value.schemaVersion === SCHEDULER_SERVICE_STATE_SCHEMA_VERSION &&
    (value.phase === SCHEDULER_SERVICE_STATE_PHASES.installing ||
      value.phase === SCHEDULER_SERVICE_STATE_PHASES.installed) &&
    typeof value.dataDir === "string" &&
    isAbsolute(value.dataDir) &&
    maxConcurrentRuns.success &&
    (generation === undefined || isNonEmptyString(generation)) &&
    binary !== undefined
    ? {
        schemaVersion: SCHEDULER_SERVICE_STATE_SCHEMA_VERSION,
        phase: value.phase,
        dataDir: resolve(value.dataDir),
        maxConcurrentRuns: maxConcurrentRuns.data,
        ...(generation === undefined ? {} : { generation }),
        ...binary,
      }
    : undefined;
}

function parseSchedulerServiceState(value: unknown): SchedulerServiceState | undefined {
  const snapshot = parseSchedulerServiceStateSnapshot(value);
  if (snapshot === undefined || !isRecordObject(value)) {
    return undefined;
  }
  if (!("replacementFrom" in value) || value.replacementFrom === undefined) {
    return snapshot;
  }
  if (snapshot.phase !== SCHEDULER_SERVICE_STATE_PHASES.installing) {
    return undefined;
  }
  const replacementFrom = parseSchedulerServiceStateSnapshot(value.replacementFrom);
  return replacementFrom === undefined ? undefined : { ...snapshot, replacementFrom };
}

export function windowsSchedulerServiceRecoveryHint(statePath: string): string {
  return `Scheduled Task 已保留为 disabled，因为无法证明它使用的 data-dir。人工恢复：确认没有 roll schedule daemon / exec 进程存活后，执行 schtasks /Delete /F /TN "${WINDOWS_SCHEDULER_TASK_NAME}" 删除任务，删除 ${statePath}，再重新执行 roll schedule service install`;
}

export function describeSchedulerServiceStateProblem(
  inspection: SchedulerServiceStateInspection,
  hint?: string,
): string {
  const problem =
    inspection.status === "valid"
      ? "scheduler service metadata is present; nothing to recover"
      : inspection.status === "missing"
        ? "scheduler service metadata is missing"
        : `scheduler service metadata is invalid: ${inspection.error}`;
  return hint === undefined ? problem : `${problem}；${hint}`;
}

export function throwSchedulerServiceStateProblem(
  inspection: SchedulerServiceStateInspection,
  hint?: string,
): never {
  throw new Error(describeSchedulerServiceStateProblem(inspection, hint));
}

export function requireSchedulerServiceState(
  inspection: SchedulerServiceStateInspection,
  hint?: string,
): SchedulerServiceState {
  if (inspection.status === "valid") {
    return inspection.state;
  }
  return throwSchedulerServiceStateProblem(inspection, hint);
}

export function inspectSchedulerServiceState(path: string): SchedulerServiceStateInspection {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    return isFileSystemError(error, "ENOENT")
      ? { status: "missing" }
      : { status: "invalid", error: `unable to read service state: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: "invalid", error: "service state contains invalid JSON" };
  }
  const state = parseSchedulerServiceState(parsed);
  return state === undefined
    ? { status: "invalid", error: "service state has an invalid schema" }
    : { status: "valid", state };
}

export function writeSchedulerServiceState(path: string, state: SchedulerServiceState): void {
  const valid = parseSchedulerServiceState(state);
  if (valid === undefined) {
    throw new Error("Refusing to write an invalid scheduler service state");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(valid)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export async function installSchedulerServiceWithState(
  path: string,
  state: Omit<SchedulerServiceStateSnapshot, "phase" | "generation">,
  install: (installing: SchedulerServiceState) => Promise<void>,
  options: { readonly replacementFrom?: SchedulerServiceStateSnapshot } = {},
): Promise<SchedulerServiceState> {
  const generation = randomUUID();
  const installing = {
    ...state,
    phase: SCHEDULER_SERVICE_STATE_PHASES.installing,
    generation,
    ...(options.replacementFrom === undefined ? {} : { replacementFrom: options.replacementFrom }),
  } as const;
  writeSchedulerServiceState(path, installing);
  await install(installing);
  const installed = {
    ...state,
    phase: SCHEDULER_SERVICE_STATE_PHASES.installed,
    generation,
  } as const;
  writeSchedulerServiceState(path, installed);
  return installed;
}

export function removeSchedulerServiceState(
  path: string,
  expected: SchedulerServiceState,
): boolean {
  const current = inspectSchedulerServiceState(path);
  if (
    current.status !== "valid" ||
    current.state.schemaVersion !== expected.schemaVersion ||
    current.state.phase !== expected.phase ||
    current.state.dataDir !== resolve(expected.dataDir) ||
    current.state.maxConcurrentRuns !== expected.maxConcurrentRuns ||
    current.state.generation !== expected.generation ||
    current.state.binary?.command !== expected.binary?.command ||
    current.state.binary?.cliEntrypoint !== expected.binary?.cliEntrypoint ||
    current.state.binary?.rollVersion !== expected.binary?.rollVersion ||
    current.state.replacementFrom?.generation !== expected.replacementFrom?.generation
  ) {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

export function removeInvalidSchedulerServiceState(path: string): boolean {
  if (inspectSchedulerServiceState(path).status !== "invalid") {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}
