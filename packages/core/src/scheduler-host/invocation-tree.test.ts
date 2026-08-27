import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProcessGroupLedger,
  collectTreeMembers,
  invocationMarker,
  parseProcStat,
  parsePsSnapshot,
  type ProcessSnapshot,
} from "./invocation-tree.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const MARKER = invocationMarker(ID);

test("parsePsSnapshot 解析 pid/pgid/stat/command 并按边界匹配标记、排除指定 pid", () => {
  const output = [
    "  100   100 Ss   /bin/bash -c sleep",
    `  101   100 S    /opt/homebrew/bin/node -e x PATH=/usr/bin ${MARKER} HOME=/Users/x`,
    `  102   102 Z    (node) ${MARKER}`,
    `  103   103 S    /usr/bin/python3 ${MARKER}0`,
    "  104   104 R+   /bin/ps -A -ww -o pid=,pgid=,stat=,command= -E",
    "garbage line",
  ].join("\n");
  assert.deepEqual(parsePsSnapshot(output, MARKER, 104), [
    { pid: 100, pgid: 100, zombie: false, marked: false },
    { pid: 101, pgid: 100, zombie: false, marked: true },
    { pid: 102, pgid: 102, zombie: true, marked: true },
    { pid: 103, pgid: 103, zombie: false, marked: false },
  ]);
});

test("parseProcStat 取 ')' 之后的 state 与 pgrp，comm 含空格和括号也不受影响", () => {
  assert.deepEqual(parseProcStat("101 (node (x) y) S 1 100 100 0 -1 4194560 0"), {
    pgid: 100,
    zombie: false,
  });
  assert.deepEqual(parseProcStat("102 (sleep) Z 1 102 102 0"), { pgid: 102, zombie: true });
  assert.equal(parseProcStat("broken"), undefined);
});

test("invocationMarker 形如 ROLL_SCHEDULE_INVOCATION=<id>", () => {
  assert.equal(MARKER, `ROLL_SCHEDULE_INVOCATION=${ID}`);
});

function snapshot(
  entries: readonly (readonly [number, number, boolean?, boolean?])[],
): ProcessSnapshot {
  return entries.map(([pid, pgid, marked = false, zombie = false]) => ({
    pid,
    pgid,
    marked,
    zombie,
  }));
}

test("collectTreeMembers：标记进程无论在哪个组都算成员，自身与僵尸排除", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500, true],
      [501, 501, true],
      [502, 900, true],
      [503, 903, true, true],
      [504, 904],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [] },
  );
  assert.deepEqual(members, { pids: [501, 502], skippedReusedGroups: [] });
});

test("collectTreeMembers：exec 是组首领时同组成员算成员；不是首领时不启用组判据", () => {
  const leader = collectTreeMembers(
    snapshot([
      [500, 500],
      [510, 500],
      [511, 500, false, true],
      [520, 520],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [] },
  );
  assert.deepEqual(leader.pids, [510]);
  const notLeader = collectTreeMembers(
    snapshot([
      [500, 1],
      [510, 1],
      [520, 520],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [] },
  );
  assert.deepEqual(notLeader.pids, []);
});

test("collectTreeMembers：登记组首领存活或已退出且 pid 未复用时整组算成员；pid 已被复用则跳过", () => {
  const alive = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => false }] },
  );
  assert.deepEqual(alive.pids, [600, 601]);
  const orphaned = collectTreeMembers(
    snapshot([
      [500, 500],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
  );
  assert.deepEqual(orphaned, { pids: [601], skippedReusedGroups: [] });
  const reused = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
  );
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [600] });
  const zombieLeader = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600, false, true],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
  );
  assert.deepEqual(zombieLeader.pids, [601]);
});

test("collectTreeMembers：上一任 executor pid 当作已退出的登记组处理", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500],
      [701, 700],
      [702, 700, true],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [], previousExecutorPid: 700 },
  );
  assert.deepEqual(members.pids, [701, 702]);
  const reused = collectTreeMembers(
    snapshot([
      [500, 500],
      [700, 700],
      [701, 700],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [], previousExecutorPid: 700 },
  );
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [700] });
});

test("ProcessGroupLedger 只登记拿到 pid 的子进程，leaderExited 跟随 exitCode/signalCode", () => {
  const ledger = new ProcessGroupLedger();
  const child = {
    pid: 800,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  };
  ledger.track({ pid: undefined, exitCode: null, signalCode: null });
  ledger.track(child);
  assert.equal(ledger.groups().length, 1);
  assert.equal(ledger.groups()[0]?.pgid, 800);
  assert.equal(ledger.groups()[0]?.leaderExited(), false);
  child.exitCode = 0;
  assert.equal(ledger.groups()[0]?.leaderExited(), true);
});
