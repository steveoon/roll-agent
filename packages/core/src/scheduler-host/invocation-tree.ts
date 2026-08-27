import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { TRUSTED_PS_PATHS } from "./executor-liveness.ts";
import { SCHEDULE_INVOCATION_ENV } from "./paths.ts";

const SNAPSHOT_TIMEOUT_MS = 5_000;
const SNAPSHOT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u;

export interface ProcessSnapshotEntry {
  readonly pid: number;
  readonly pgid: number;
  readonly zombie: boolean;
  readonly marked: boolean;
}

export type ProcessSnapshot = readonly ProcessSnapshotEntry[];

export function invocationMarker(invocationId: string): string {
  return `${SCHEDULE_INVOCATION_ENV}=${invocationId}`;
}

function isBoundary(char: string): boolean {
  return char === "" || /\s/u.test(char);
}

function containsMarker(commandLine: string, marker: string): boolean {
  let from = 0;
  while (from <= commandLine.length) {
    const at = commandLine.indexOf(marker, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? "" : commandLine.charAt(at - 1);
    const after = commandLine.charAt(at + marker.length);
    if (isBoundary(before) && isBoundary(after)) {
      return true;
    }
    from = at + marker.length;
  }
  return false;
}

export function parsePsSnapshot(
  output: string,
  marker: string,
  excludePid?: number,
): ProcessSnapshot {
  const entries: ProcessSnapshotEntry[] = [];
  for (const line of output.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const pid = Number.parseInt(match[1] ?? "", 10);
    const pgid = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid) || pid === excludePid) {
      continue;
    }
    entries.push({
      pid,
      pgid,
      zombie: (match[3] ?? "").startsWith("Z"),
      marked: containsMarker(match[4] ?? "", marker),
    });
  }
  return entries;
}

export function parseProcStat(
  stat: string,
): { readonly pgid: number; readonly zombie: boolean } | undefined {
  const end = stat.lastIndexOf(")");
  if (end < 0) {
    return undefined;
  }
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/u);
  const pgid = Number.parseInt(fields[2] ?? "", 10);
  if (!Number.isInteger(pgid)) {
    return undefined;
  }
  return { pgid, zombie: (fields[0] ?? "").startsWith("Z") };
}

function snapshotFromProc(marker: string): ProcessSnapshot {
  const entries: ProcessSnapshotEntry[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) {
      continue;
    }
    let parsed: ReturnType<typeof parseProcStat>;
    try {
      parsed = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf-8"));
    } catch {
      continue;
    }
    if (parsed === undefined) {
      continue;
    }
    let marked = false;
    try {
      marked = readFileSync(`/proc/${name}/environ`, "utf-8").split("\0").includes(marker);
    } catch {
      marked = false;
    }
    entries.push({
      pid: Number.parseInt(name, 10),
      pgid: parsed.pgid,
      zombie: parsed.zombie,
      marked,
    });
  }
  return entries;
}

function snapshotFromPs(marker: string): ProcessSnapshot | undefined {
  const psExecutable = TRUSTED_PS_PATHS.find((candidate) => existsSync(candidate));
  if (psExecutable === undefined) {
    return undefined;
  }
  const result = spawnSync(psExecutable, ["-A", "-ww", "-o", "pid=,pgid=,stat=,command=", "-E"], {
    encoding: "utf-8",
    env: { LC_ALL: "C", LANG: "C" },
    timeout: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: SNAPSHOT_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error !== undefined) {
    return undefined;
  }
  return parsePsSnapshot(result.stdout, marker, result.pid);
}

export function snapshotProcesses(
  marker: string,
  platform: NodeJS.Platform = process.platform,
): ProcessSnapshot | undefined {
  if (platform === "win32") {
    return undefined;
  }
  if (platform === "linux" || platform === "android") {
    return snapshotFromProc(marker);
  }
  return snapshotFromPs(marker);
}

export interface TrackedProcessGroup {
  readonly pgid: number;
  readonly leaderExited: () => boolean;
}

export class ProcessGroupLedger {
  private readonly tracked: TrackedProcessGroup[] = [];

  track(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">): void {
    const pgid = child.pid;
    if (pgid === undefined) {
      return;
    }
    this.tracked.push({
      pgid,
      leaderExited: () => child.exitCode !== null || child.signalCode !== null,
    });
  }

  groups(): readonly TrackedProcessGroup[] {
    return [...this.tracked];
  }
}

export interface InvocationTreeScope {
  readonly invocationId: string;
  readonly selfPid: number;
  readonly trackedGroups: readonly TrackedProcessGroup[];
  readonly previousExecutorPid?: number;
}

export interface TreeMembers {
  readonly pids: readonly number[];
  readonly skippedReusedGroups: readonly number[];
}

export function collectTreeMembers(
  snapshot: ProcessSnapshot,
  scope: InvocationTreeScope,
): TreeMembers {
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry] as const));
  const groups = new Set<number>();
  const skipped: number[] = [];
  const self = byPid.get(scope.selfPid);
  if (self !== undefined && self.pgid === scope.selfPid) {
    groups.add(scope.selfPid);
  }
  const consider = (pgid: number, leaderExited: boolean): void => {
    const leader = byPid.get(pgid);
    if (leaderExited && leader !== undefined && !leader.zombie) {
      skipped.push(pgid);
      return;
    }
    groups.add(pgid);
  };
  for (const group of scope.trackedGroups) {
    consider(group.pgid, group.leaderExited());
  }
  if (scope.previousExecutorPid !== undefined && scope.previousExecutorPid !== scope.selfPid) {
    consider(scope.previousExecutorPid, true);
  }
  const pids = snapshot
    .filter((entry) => entry.pid !== scope.selfPid && !entry.zombie)
    .filter((entry) => entry.marked || groups.has(entry.pgid))
    .map((entry) => entry.pid);
  return { pids, skippedReusedGroups: skipped };
}
