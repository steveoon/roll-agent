import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  INVOCATION_TREE_LIVENESS,
  TRACKED_LEADER_STATES,
  type InvocationTreeLiveness,
  type PersistedTrackedGroup,
  type TrackedLeaderState,
} from "@roll-agent/runtime";
import {
  PROCESS_START_TOKEN_VERIFICATION_STATUSES,
  isProcessStartToken,
  readProcessStartToken,
  verifyProcessStartToken,
} from "../registry/process-identity.ts";
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
  matchCommandAsEnv = false,
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
      marked: matchCommandAsEnv && containsMarker(match[4] ?? "", marker),
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

function hasLiveThreads(name: string): boolean {
  try {
    return readdirSync(`/proc/${name}/task`).length > 1;
  } catch {
    return false;
  }
}

function snapshotFromProc(marker: string): ProcessSnapshot | undefined {
  let names: readonly string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const entries: ProcessSnapshotEntry[] = [];
  for (const name of names) {
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
      zombie: parsed.zombie && !hasLiveThreads(name),
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

export const TRACKED_GROUP_ORIGINS = {
  live: "live",
  restored: "restored",
} as const;
export type TrackedGroupOrigin = (typeof TRACKED_GROUP_ORIGINS)[keyof typeof TRACKED_GROUP_ORIGINS];

export interface TrackedProcessGroup {
  readonly pgid: number;
  readonly leaderExited: () => boolean;
  readonly startToken?: string;
  readonly origin?: TrackedGroupOrigin;
  readonly leaderState?: TrackedLeaderState;
}

export class ProcessGroupLedger {
  private readonly tracked: TrackedProcessGroup[] = [];
  private readonly readStartToken: (pid: number) => string | undefined;

  constructor(readStartToken: (pid: number) => string | undefined = readProcessStartToken) {
    this.readStartToken = readStartToken;
  }

  track(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">): void {
    const pgid = child.pid;
    if (pgid === undefined) {
      return;
    }
    const startToken = this.readStartToken(pgid);
    this.tracked.push({
      pgid,
      leaderExited: () => child.exitCode !== null || child.signalCode !== null,
      origin: TRACKED_GROUP_ORIGINS.live,
      ...(startToken !== undefined ? { startToken } : {}),
    });
  }

  groups(): readonly TrackedProcessGroup[] {
    return [...this.tracked];
  }

  persisted(): readonly PersistedTrackedGroup[] {
    return persistTrackedGroups(this.tracked);
  }
}

export function persistTrackedGroups(
  groups: readonly TrackedProcessGroup[],
): PersistedTrackedGroup[] {
  const byPgid = new Map<number, PersistedTrackedGroup>();
  for (const group of groups) {
    const leaderState = persistLeaderState(group);
    byPgid.set(
      group.pgid,
      group.startToken !== undefined
        ? { pgid: group.pgid, leaderState, startToken: group.startToken }
        : { pgid: group.pgid, leaderState },
    );
  }
  return [...byPgid.values()];
}

function persistLeaderState(group: TrackedProcessGroup): TrackedLeaderState {
  return group.leaderState !== undefined
    ? group.leaderState
    : group.leaderExited()
      ? TRACKED_LEADER_STATES.exited
      : TRACKED_LEADER_STATES.alive;
}

export function trackedGroupsFromPersisted(
  groups: readonly PersistedTrackedGroup[],
): TrackedProcessGroup[] {
  return groups
    .filter((group) => Number.isInteger(group.pgid) && group.pgid > 0)
    .map((group) => ({
      pgid: group.pgid,
      leaderExited: () => group.leaderState === TRACKED_LEADER_STATES.exited,
      origin: TRACKED_GROUP_ORIGINS.restored,
      leaderState: group.leaderState,
      ...(group.startToken !== undefined ? { startToken: group.startToken } : {}),
    }));
}

export function trackedGroupsFromPersistedPgids(pgids: readonly number[]): TrackedProcessGroup[] {
  return trackedGroupsFromPersisted(
    [...new Set(pgids.filter((pgid) => Number.isInteger(pgid) && pgid > 0))].map((pgid) => ({
      pgid,
      leaderState: TRACKED_LEADER_STATES.unknown,
    })),
  );
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
  readonly unverifiableGroups: readonly number[];
}

export const START_TOKEN_MATCH_RESULTS = {
  match: "match",
  mismatch: "mismatch",
  unavailable: "unavailable",
} as const;
export type StartTokenMatchResult =
  (typeof START_TOKEN_MATCH_RESULTS)[keyof typeof START_TOKEN_MATCH_RESULTS];

export interface CollectTreeMembersDeps {
  readonly matchStartToken?: (pid: number, startToken: string) => StartTokenMatchResult;
  readonly quarantinedGroups?: ReadonlySet<number>;
}

const RESTORED_LIVE_LEADER_BY_VERDICT = {
  [START_TOKEN_MATCH_RESULTS.match]: "own",
  [START_TOKEN_MATCH_RESULTS.mismatch]: "skip",
  [START_TOKEN_MATCH_RESULTS.unavailable]: "unverifiable",
} as const;

function restoredLiveLeaderDisposition(
  verdict: StartTokenMatchResult | undefined,
): (typeof RESTORED_LIVE_LEADER_BY_VERDICT)[StartTokenMatchResult] {
  return verdict === undefined
    ? RESTORED_LIVE_LEADER_BY_VERDICT[START_TOKEN_MATCH_RESULTS.unavailable]
    : RESTORED_LIVE_LEADER_BY_VERDICT[verdict];
}

function shouldSkipReusedGroup(
  pgid: number,
  leaderExited: boolean,
  live: boolean,
  startToken: string | undefined,
  matchStartToken: CollectTreeMembersDeps["matchStartToken"],
): boolean {
  if (!live) {
    return false;
  }
  const verdict =
    startToken !== undefined && matchStartToken !== undefined
      ? matchStartToken(pgid, startToken)
      : undefined;
  if (!leaderExited) {
    return verdict === START_TOKEN_MATCH_RESULTS.mismatch;
  }
  return verdict !== START_TOKEN_MATCH_RESULTS.match;
}

function matchPersistedStartToken(pid: number, startToken: string): StartTokenMatchResult {
  if (!isProcessStartToken(startToken)) {
    return START_TOKEN_MATCH_RESULTS.unavailable;
  }
  const result = verifyProcessStartToken(pid, startToken);
  if (result.status === PROCESS_START_TOKEN_VERIFICATION_STATUSES.MATCH) {
    return START_TOKEN_MATCH_RESULTS.match;
  }
  if (result.status === PROCESS_START_TOKEN_VERIFICATION_STATUSES.MISMATCH) {
    return START_TOKEN_MATCH_RESULTS.mismatch;
  }
  return START_TOKEN_MATCH_RESULTS.unavailable;
}

export function collectTreeMembers(
  snapshot: ProcessSnapshot,
  scope: InvocationTreeScope,
  deps: CollectTreeMembersDeps = {},
): TreeMembers {
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry] as const));
  const groups = new Set<number>();
  const skipped: number[] = [];
  const unverifiable: number[] = [];
  const self = byPid.get(scope.selfPid);
  if (self !== undefined && self.pgid === scope.selfPid) {
    groups.add(scope.selfPid);
  }
  const consider = (
    pgid: number,
    leaderExited: boolean,
    startToken: string | undefined,
    origin: TrackedGroupOrigin | undefined,
    leaderState: TrackedLeaderState | undefined,
  ): void => {
    if (deps.quarantinedGroups?.has(pgid) === true) {
      skipped.push(pgid);
      return;
    }
    const live = byPid.has(pgid);
    const state =
      leaderState ?? (leaderExited ? TRACKED_LEADER_STATES.exited : TRACKED_LEADER_STATES.alive);
    if (
      origin === TRACKED_GROUP_ORIGINS.restored &&
      live &&
      state === TRACKED_LEADER_STATES.unknown
    ) {
      unverifiable.push(pgid);
      return;
    }
    if (
      origin === TRACKED_GROUP_ORIGINS.restored &&
      state === TRACKED_LEADER_STATES.alive &&
      live
    ) {
      const verdict =
        startToken !== undefined && deps.matchStartToken !== undefined
          ? deps.matchStartToken(pgid, startToken)
          : undefined;
      const disposition = restoredLiveLeaderDisposition(verdict);
      if (disposition === "own") {
        groups.add(pgid);
        return;
      }
      if (disposition === "skip") {
        skipped.push(pgid);
        return;
      }
      unverifiable.push(pgid);
      return;
    }
    if (shouldSkipReusedGroup(pgid, leaderExited, live, startToken, deps.matchStartToken)) {
      skipped.push(pgid);
      return;
    }
    groups.add(pgid);
  };
  for (const group of scope.trackedGroups) {
    consider(group.pgid, group.leaderExited(), group.startToken, group.origin, group.leaderState);
  }
  if (scope.previousExecutorPid !== undefined && scope.previousExecutorPid !== scope.selfPid) {
    consider(
      scope.previousExecutorPid,
      true,
      undefined,
      TRACKED_GROUP_ORIGINS.live,
      TRACKED_LEADER_STATES.exited,
    );
  }
  const pids = snapshot
    .filter((entry) => entry.pid !== scope.selfPid && !entry.zombie)
    .filter((entry) => entry.marked || groups.has(entry.pgid))
    .map((entry) => entry.pid);
  const skippedReusedGroups = [...new Set(skipped)].filter((pgid) => !groups.has(pgid));
  return { pids, skippedReusedGroups, unverifiableGroups: unverifiable };
}

export function probeInvocationTreeSettled(
  scope: InvocationTreeScope,
  deps: {
    readonly platform?: NodeJS.Platform;
    readonly snapshot?: (marker: string) => ProcessSnapshot | undefined;
    readonly matchStartToken?: CollectTreeMembersDeps["matchStartToken"];
  } = {},
): InvocationTreeLiveness {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return INVOCATION_TREE_LIVENESS.settled;
  }
  const marker = invocationMarker(scope.invocationId);
  const takeSnapshot = deps.snapshot ?? ((value: string) => snapshotProcesses(value, platform));
  const snapshot = takeSnapshot(marker);
  if (snapshot === undefined) {
    return INVOCATION_TREE_LIVENESS.unavailable;
  }
  const members = collectTreeMembers(snapshot, scope, {
    matchStartToken: deps.matchStartToken ?? matchPersistedStartToken,
  });
  if (members.unverifiableGroups.length > 0) {
    return INVOCATION_TREE_LIVENESS.unavailable;
  }
  return members.pids.length === 0
    ? INVOCATION_TREE_LIVENESS.settled
    : INVOCATION_TREE_LIVENESS.unsettled;
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
  readonly error?: string;
}

export interface TerminateInvocationTreeDeps {
  readonly platform?: NodeJS.Platform;
  readonly snapshot?: (marker: string) => ProcessSnapshot | undefined;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly graceMs?: number;
  readonly pollMs?: number;
  readonly matchStartToken?: CollectTreeMembersDeps["matchStartToken"];
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

function unverifiableTeardown(
  groups: readonly number[],
  skipped: readonly number[] = [],
): InvocationTreeTeardown {
  return {
    outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable,
    terminatedPids: [],
    survivorPids: [],
    skippedReusedGroups: skipped,
    error: `无法验证登记进程组 ${groups.join(",")} 的 OS 启动身份`,
  };
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
  const rawSnapshot = deps.snapshot ?? ((value: string) => snapshotProcesses(value, platform));
  const requireSelfInSnapshot = scope.selfPid > 0;
  const snapshot = (value: string): ProcessSnapshot | undefined => {
    const current = rawSnapshot(value);
    if (current === undefined) {
      return undefined;
    }
    return requireSelfInSnapshot && !current.some((entry) => entry.pid === scope.selfPid)
      ? undefined
      : current;
  };
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const wait = deps.sleep ?? ((ms: number) => sleep(ms));
  const now = deps.now ?? (() => performance.now());
  const graceMs = deps.graceMs ?? TEARDOWN_GRACE_MS;
  const pollMs = deps.pollMs ?? TEARDOWN_POLL_MS;
  const quarantinedGroups = new Set<number>();
  const memberDeps: CollectTreeMembersDeps = {
    matchStartToken: deps.matchStartToken ?? matchPersistedStartToken,
    quarantinedGroups,
  };
  const collectMembers = (current: ProcessSnapshot): TreeMembers => {
    const members = collectTreeMembers(current, scope, memberDeps);
    for (const pgid of members.skippedReusedGroups) {
      quarantinedGroups.add(pgid);
    }
    return members;
  };
  const first = snapshot(marker);
  if (first === undefined) {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  }
  const initial = collectMembers(first);
  if (initial.unverifiableGroups.length > 0) {
    return unverifiableTeardown(initial.unverifiableGroups, ascending(quarantinedGroups));
  }
  if (initial.pids.length === 0) {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.clean, ascending(quarantinedGroups));
  }
  const seen = new Set<number>(initial.pids);
  const signalAll = (pids: readonly number[], signal: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        kill(pid, signal);
      } catch (error) {
        if (!isErrnoCode(error, "ESRCH") && !isErrnoCode(error, "EPERM")) {
          throw error;
        }
      }
    }
  };
  const maxPolls = Math.max(1, Math.ceil(graceMs / pollMs));
  const settle = async (): Promise<TreeMembers | undefined> => {
    const deadline = now() + graceMs;
    for (let poll = 1; ; poll += 1) {
      await wait(pollMs);
      const current = snapshot(marker);
      if (current === undefined) {
        return undefined;
      }
      const members = collectMembers(current);
      if (members.unverifiableGroups.length > 0) {
        return members;
      }
      for (const pid of members.pids) {
        seen.add(pid);
      }
      if (members.pids.length === 0 || now() >= deadline || poll >= maxPolls) {
        return members;
      }
    }
  };
  signalAll(initial.pids, "SIGTERM");
  let remaining = await settle();
  if (remaining === undefined) {
    return emptyTeardown(
      INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable,
      ascending(quarantinedGroups),
    );
  }
  if (remaining.unverifiableGroups.length > 0) {
    return unverifiableTeardown(remaining.unverifiableGroups, ascending(quarantinedGroups));
  }
  if (remaining.pids.length > 0) {
    signalAll(remaining.pids, "SIGKILL");
    remaining = await settle();
    if (remaining === undefined) {
      return emptyTeardown(
        INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable,
        ascending(quarantinedGroups),
      );
    }
    if (remaining.unverifiableGroups.length > 0) {
      return unverifiableTeardown(remaining.unverifiableGroups, ascending(quarantinedGroups));
    }
  }
  const survivors = new Set<number>(remaining.pids);
  const terminated = ascending([...seen].filter((pid) => !survivors.has(pid)));
  return {
    outcome:
      survivors.size === 0
        ? INVOCATION_TREE_TEARDOWN_OUTCOMES.clean
        : INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors,
    terminatedPids: terminated,
    survivorPids: ascending(survivors),
    skippedReusedGroups: ascending(quarantinedGroups),
  };
}
