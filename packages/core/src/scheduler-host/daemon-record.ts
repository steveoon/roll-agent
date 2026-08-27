import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isProcessStartToken,
  readProcessStartToken,
  verifyProcessStartToken,
  type ProcessStartToken,
} from "../registry/process-identity.ts";

export interface SchedulerDaemonRecord {
  readonly pid: number;
  readonly processStartToken: ProcessStartToken;
  readonly startedAt: string;
  readonly workerId: string;
}

export const DAEMON_LIVENESS = {
  running: "running",
  stopped: "stopped",
  unverifiable: "unverifiable",
} as const;
export type DaemonLiveness = (typeof DAEMON_LIVENESS)[keyof typeof DAEMON_LIVENESS];

export interface DaemonInspection {
  readonly liveness: DaemonLiveness;
  readonly record: SchedulerDaemonRecord | undefined;
}

export type DaemonWorkerId = `daemon-${string}`;
export type InlineWorkerId = `inline-${string}`;
const DAEMON_WORKER_ID_PATTERN =
  /^daemon-[1-9]\d*(?:-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})?$/u;
const INLINE_WORKER_ID_PATTERN = /^inline-[1-9]\d*$/u;

export function createDaemonWorkerId(pid: number = process.pid): DaemonWorkerId {
  return `daemon-${String(pid)}-${randomUUID()}`;
}

export function isDaemonWorkerId(value: string | undefined): value is DaemonWorkerId {
  if (value === undefined) {
    return false;
  }
  const match = DAEMON_WORKER_ID_PATTERN.exec(value);
  return match?.[0] === value;
}

export function isInlineWorkerId(value: string | undefined): value is InlineWorkerId {
  if (value === undefined) {
    return false;
  }
  const match = INLINE_WORKER_ID_PATTERN.exec(value);
  return match?.[0] === value;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDaemonRecord(workerId: string): SchedulerDaemonRecord {
  const processStartToken = readProcessStartToken(process.pid);
  if (processStartToken === undefined) {
    throw new Error(
      `无法验证当前 Roll 进程 (PID: ${String(process.pid)}) 的 OS 启动身份，拒绝启动 scheduler daemon。`,
    );
  }
  return { pid: process.pid, processStartToken, startedAt: new Date().toISOString(), workerId };
}

export function writeDaemonRecord(path: string, record: SchedulerDaemonRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function readDaemonRecord(path: string): SchedulerDaemonRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecordObject(value) ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    !isProcessStartToken(value.processStartToken) ||
    typeof value.startedAt !== "string" ||
    typeof value.workerId !== "string"
  ) {
    return undefined;
  }
  return {
    pid: value.pid,
    processStartToken: value.processStartToken,
    startedAt: value.startedAt,
    workerId: value.workerId,
  };
}

export function removeDaemonRecord(path: string, expected: SchedulerDaemonRecord): void {
  const current = readDaemonRecord(path);
  if (
    current === undefined ||
    current.pid !== expected.pid ||
    current.processStartToken !== expected.processStartToken
  ) {
    return;
  }
  rmSync(path, { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function inspectDaemon(path: string): DaemonInspection {
  const record = readDaemonRecord(path);
  if (record === undefined) {
    return { liveness: DAEMON_LIVENESS.stopped, record: undefined };
  }
  if (!isPidAlive(record.pid)) {
    return { liveness: DAEMON_LIVENESS.stopped, record };
  }
  const verification = verifyProcessStartToken(record.pid, record.processStartToken);
  if (verification.status === "match") {
    return { liveness: DAEMON_LIVENESS.running, record };
  }
  if (verification.status === "mismatch") {
    return { liveness: DAEMON_LIVENESS.stopped, record };
  }
  return { liveness: DAEMON_LIVENESS.unverifiable, record };
}
