import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { TRUSTED_PS_PATHS } from "./executor-liveness.ts";
import { SCHEDULE_INVOCATION_ENV } from "./paths.ts";

const SNAPSHOT_TIMEOUT_MS = 5_000;
const SNAPSHOT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const TEARDOWN_GRACE_MS = 2_000;
const TEARDOWN_POLL_MS = 250;
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

export const INVOCATION_TREE_TEARDOWN_OUTCOMES = {
  clean: "clean",
  survivors: "survivors",
  unavailable: "unavailable",
  unsupported: "unsupported",
} as const;

export type InvocationTreeTeardownOutcome =
  (typeof INVOCATION_TREE_TEARDOWN_OUTCOMES)[keyof typeof INVOCATION_TREE_TEARDOWN_OUTCOMES];

export interface InvocationTreeTeardown {
  readonly outcome: InvocationTreeTeardownOutcome;
  readonly terminatedPids: readonly number[];
  readonly survivorPids: readonly number[];
  readonly skippedReusedGroups: readonly number[];
}

export interface TerminateInvocationTreeDeps {
  readonly platform?: NodeJS.Platform;
  readonly snapshot?: (marker: string) => ProcessSnapshot | undefined;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly graceMs?: number;
  readonly pollMs?: number;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function emptyTeardown(
  outcome: InvocationTreeTeardownOutcome,
  skipped: readonly number[] = [],
): InvocationTreeTeardown {
  return { outcome, terminatedPids: [], survivorPids: [], skippedReusedGroups: skipped };
}

function ascending(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

export async function terminateInvocationTree(
  scope: InvocationTreeScope,
  deps: TerminateInvocationTreeDeps = {},
): Promise<InvocationTreeTeardown> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.unsupported);
  }
  const marker = invocationMarker(scope.invocationId);
  const snapshot = deps.snapshot ?? ((value: string) => snapshotProcesses(value, platform));
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const wait = deps.sleep ?? ((ms: number) => sleep(ms));
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? TEARDOWN_GRACE_MS;
  const pollMs = deps.pollMs ?? TEARDOWN_POLL_MS;
  const first = snapshot(marker);
  if (first === undefined) {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  }
  const initial = collectTreeMembers(first, scope);
  if (initial.pids.length === 0) {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.clean, initial.skippedReusedGroups);
  }
  const seen = new Set<number>(initial.pids);
  const unkillable = new Set<number>();
  const signalAll = (pids: readonly number[], signal: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        kill(pid, signal);
      } catch (error) {
        if (isErrnoCode(error, "EPERM")) {
          unkillable.add(pid);
        }
      }
    }
  };
  const settle = async (): Promise<readonly number[] | undefined> => {
    const deadline = now() + graceMs;
    for (;;) {
      await wait(pollMs);
      const current = snapshot(marker);
      if (current === undefined) {
        return undefined;
      }
      const members = collectTreeMembers(current, scope).pids;
      for (const pid of members) {
        seen.add(pid);
      }
      if (members.length === 0 || now() >= deadline) {
        return members;
      }
    }
  };
  signalAll(initial.pids, "SIGTERM");
  let remaining = await settle();
  if (remaining === undefined) {
    return emptyTeardown(
      INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable,
      initial.skippedReusedGroups,
    );
  }
  if (remaining.length > 0) {
    signalAll(remaining, "SIGKILL");
    remaining = await settle();
    if (remaining === undefined) {
      return emptyTeardown(
        INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable,
        initial.skippedReusedGroups,
      );
    }
  }
  const survivors = new Set<number>([...remaining, ...unkillable]);
  const terminated = ascending([...seen].filter((pid) => !survivors.has(pid)));
  return {
    outcome:
      survivors.size === 0
        ? INVOCATION_TREE_TEARDOWN_OUTCOMES.clean
        : INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors,
    terminatedPids: terminated,
    survivorPids: ascending(survivors),
    skippedReusedGroups: initial.skippedReusedGroups,
  };
}
