import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  INVOCATION_TREE_TEARDOWN_OUTCOMES,
  ProcessGroupLedger,
  collectTreeMembers,
  invocationMarker,
  mergeTrackedGroups,
  parseProcStat,
  parsePsSnapshot,
  probeInvocationTreeSettled,
  resolveStartTokenReader,
  snapshotProcesses,
  terminateInvocationTree,
  trackedGroupsFromPersisted,
  trackedGroupsFromPersistedPgids,
  type ProcessSnapshot,
} from "./invocation-tree.ts";
import { omitScheduleInvocationEnv } from "./paths.ts";
import { readProcessStartToken } from "../registry/process-identity.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const MARKER = invocationMarker(ID);

test("parsePsSnapshot 只解析 pid/pgid/stat，ps 输出里不再有 command / env，永不标记", () => {
  const output = [
    "  100   100 Ss",
    "  101   100 S  ",
    "  102   102 Z",
    `  103   103 S    /usr/bin/python3 ${MARKER}`,
    "  104   104 R+",
    "garbage line",
  ].join("\n");
  assert.deepEqual(parsePsSnapshot(output, 104), [
    { pid: 100, pgid: 100, zombie: false, marked: false },
    { pid: 101, pgid: 100, zombie: false, marked: false },
    { pid: 102, pgid: 102, zombie: true, marked: false },
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
  assert.deepEqual(members, { pids: [501, 502], skippedReusedGroups: [], unverifiableGroups: [] });
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
  assert.deepEqual(orphaned, { pids: [601], skippedReusedGroups: [], unverifiableGroups: [] });
  const reused = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
  );
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [600], unverifiableGroups: [] });
  const zombieLeader = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600, false, true],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
  );
  assert.deepEqual(zombieLeader, { pids: [], skippedReusedGroups: [600], unverifiableGroups: [] });
});

test("collectTreeMembers：已退出组的同号 PID 仅在 start token 不匹配时跳过", () => {
  const group = {
    pgid: 600,
    leaderExited: () => true,
    startToken: "pst-v2:old",
  };
  const reused = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [group] },
    { matchStartToken: () => "mismatch" },
  );
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [600], unverifiableGroups: [] });
  const stillOurs = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [group] },
    { matchStartToken: () => "match" },
  );
  assert.deepEqual(stillOurs, {
    pids: [600, 601],
    skippedReusedGroups: [],
    unverifiableGroups: [],
  });
});

test("collectTreeMembers：未退出组的同号 PID 仅在 start token 不匹配时跳过", () => {
  const group = {
    pgid: 600,
    leaderExited: () => false,
    startToken: "pst-v2:live",
  };
  const live = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [group] },
    { matchStartToken: () => "match" },
  );
  assert.deepEqual(live, { pids: [600, 601], skippedReusedGroups: [], unverifiableGroups: [] });
  const reusedWhileLive = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [group] },
    { matchStartToken: () => "mismatch" },
  );
  assert.deepEqual(reusedWhileLive, {
    pids: [],
    skippedReusedGroups: [600],
    unverifiableGroups: [],
  });
});

test("collectTreeMembers：恢复组缺少 start token 时不把 live leader 当 owned", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    {
      invocationId: ID,
      selfPid: 500,
      trackedGroups: trackedGroupsFromPersisted([{ pgid: 600, leaderState: "alive" }]),
    },
  );
  assert.deepEqual(members.pids, []);
  assert.deepEqual(members.skippedReusedGroups, []);
  assert.deepEqual(members.unverifiableGroups, [600]);
});

test("collectTreeMembers：恢复组 start token 验证 unavailable 时不把 live leader 当 owned", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    {
      invocationId: ID,
      selfPid: 500,
      trackedGroups: trackedGroupsFromPersisted([
        { pgid: 600, leaderState: "alive", startToken: "pst-v2:live" },
      ]),
    },
    { matchStartToken: () => "unavailable" },
  );
  assert.deepEqual(members.pids, []);
  assert.deepEqual(members.skippedReusedGroups, []);
  assert.deepEqual(members.unverifiableGroups, [600]);
});

test("collectTreeMembers：恢复组 live leader 在快照后刚退出（gone）时整组仍算成员，不进隔离", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    {
      invocationId: ID,
      selfPid: 500,
      trackedGroups: trackedGroupsFromPersisted([
        { pgid: 600, leaderState: "alive", startToken: "pst-v2:live" },
      ]),
    },
    { matchStartToken: () => "gone" },
  );
  assert.deepEqual(members.pids, [600, 601]);
  assert.deepEqual(members.skippedReusedGroups, []);
  assert.deepEqual(members.unverifiableGroups, []);
});

test("collectTreeMembers：恢复组 leader 已退出而同号 pid 刚消失（gone）仍按复用跳过", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    {
      invocationId: ID,
      selfPid: 500,
      trackedGroups: trackedGroupsFromPersisted([
        { pgid: 600, leaderState: "exited", startToken: "pst-v2:old" },
      ]),
    },
    { matchStartToken: () => "gone" },
  );
  assert.deepEqual(members, { pids: [], skippedReusedGroups: [600], unverifiableGroups: [] });
});

test("trackedGroupsFromPersisted 保留 leaderState；纯 pgid 视为身份未知", () => {
  const live = trackedGroupsFromPersisted([
    { pgid: 600, leaderState: "alive", startToken: "pst-v2:live" },
  ]);
  assert.equal(live[0]?.leaderExited(), false);
  assert.equal(live[0]?.leaderState, "alive");
  assert.equal(live[0]?.startToken, "pst-v2:live");
  assert.equal(live[0]?.origin, "restored");
  const legacy = trackedGroupsFromPersistedPgids([600]);
  assert.equal(legacy[0]?.leaderExited(), false);
  assert.equal(legacy[0]?.leaderState, "unknown");
  assert.equal(legacy[0]?.origin, "restored");
});

test("collectTreeMembers：selfPid 为 0 时不把快照里的 pid 0 / pgid 0 行当成自己的组", () => {
  const members = collectTreeMembers(
    snapshot([
      [0, 0],
      [5, 0],
      [900, 900],
    ]),
    { invocationId: ID, selfPid: 0, trackedGroups: [] },
  );
  assert.deepEqual(members, { pids: [], skippedReusedGroups: [], unverifiableGroups: [] });
});

test("mergeTrackedGroups：live 登记组覆盖同号持久化组，已判复用的组不再带走", () => {
  const merged = mergeTrackedGroups(
    [
      { pgid: 600, leaderState: "alive", startToken: "pst-v2:old" },
      { pgid: 700, leaderState: "alive", startToken: "pst-v2:reused" },
    ],
    [{ pgid: 600, leaderState: "exited", startToken: "pst-v2:old" }],
    [700],
  );
  assert.deepEqual(merged, [{ pgid: 600, leaderState: "exited", startToken: "pst-v2:old" }]);
  assert.deepEqual(mergeTrackedGroups([], [{ pgid: 800, leaderState: "alive" }]), [
    { pgid: 800, leaderState: "alive" },
  ]);
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
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [700], unverifiableGroups: [] });
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
  assert.equal(ledger.groups()[0]?.origin, "live");
  assert.equal(ledger.groups()[0]?.leaderExited(), false);
  child.exitCode = 0;
  assert.equal(ledger.groups()[0]?.leaderExited(), true);
});

test("resolveStartTokenReader：win32 不读 OS 启动身份（teardown/probe 在 win32 永不消费），POSIX 用真实读取器", () => {
  assert.equal(resolveStartTokenReader("win32")(process.pid), undefined);
  assert.equal(resolveStartTokenReader("darwin"), readProcessStartToken);
  assert.equal(resolveStartTokenReader("linux"), readProcessStartToken);
});

function scriptedDeps(
  frames: readonly ProcessSnapshot[],
  killed: Array<[number, string]>,
  extra: {
    readonly graceMs?: number;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
) {
  let index = 0;
  let clock = 0;
  return {
    platform: "darwin" as const,
    snapshot: () => frames[Math.min(index++, frames.length - 1)],
    kill:
      extra.kill ??
      ((pid: number, signal: NodeJS.Signals) => {
        killed.push([pid, signal]);
      }),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    graceMs: extra.graceMs ?? 0,
    pollMs: 10,
  };
}

const SCOPE = { invocationId: ID, selfPid: 500, trackedGroups: [] as const };

test("terminateInvocationTree：没有成员直接 clean，不发信号", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([snapshot([[500, 500]])], killed),
  );
  assert.deepEqual(report, {
    outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.clean,
    terminatedPids: [],
    survivorPids: [],
    skippedReusedGroups: [],
  });
  assert.deepEqual(killed, []);
});

test("terminateInvocationTree：SIGTERM 后成员消失即 clean，不再 SIGKILL", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps(
      [
        snapshot([
          [500, 500],
          [501, 501, true],
        ]),
        snapshot([[500, 500]]),
      ],
      killed,
    ),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [501]);
  assert.deepEqual(killed, [[501, "SIGTERM"]]);
});

test("terminateInvocationTree：grace 后仍在则 SIGKILL，随后消失为 clean", async () => {
  const killed: Array<[number, string]> = [];
  const alive = snapshot([
    [500, 500],
    [501, 501, true],
  ]);
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([alive, alive, snapshot([[500, 500]])], killed),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(killed, [
    [501, "SIGTERM"],
    [501, "SIGKILL"],
  ]);
});

test("terminateInvocationTree：SIGKILL 后仍在的进程记为 survivors，EPERM 的进程以最终快照为准", async () => {
  const killed: Array<[number, string]> = [];
  const stuck = snapshot([
    [500, 500],
    [501, 501, true],
    [502, 500],
  ]);
  const epermKill = (pid: number, signal: NodeJS.Signals) => {
    killed.push([pid, signal]);
    if (pid === 502) {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }
  };
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([stuck, stuck, stuck], killed, { kill: epermKill }),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors);
  assert.deepEqual(report.survivorPids, [501, 502]);
  assert.deepEqual(report.terminatedPids, []);
  const gone = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([stuck, snapshot([[500, 500]])], [], { kill: epermKill }),
  );
  assert.equal(gone.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(gone.terminatedPids, [501, 502]);
});

test("terminateInvocationTree：kill 抛出 ESRCH/EPERM 之外的错误会向上抛", async () => {
  await assert.rejects(
    terminateInvocationTree(
      SCOPE,
      scriptedDeps(
        [
          snapshot([
            [500, 500],
            [501, 501, true],
          ]),
        ],
        [],
        {
          kill: () => {
            throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
          },
        },
      ),
    ),
    /EINVAL/u,
  );
});

test("terminateInvocationTree：ESRCH 忽略；快照不可用返回 unavailable；win32 返回 unsupported", async () => {
  const killed: Array<[number, string]> = [];
  const esrch = await terminateInvocationTree(
    SCOPE,
    scriptedDeps(
      [
        snapshot([
          [500, 500],
          [501, 501, true],
        ]),
        snapshot([[500, 500]]),
      ],
      killed,
      {
        kill: () => {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        },
      },
    ),
  );
  assert.equal(esrch.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  const unavailable = await terminateInvocationTree(SCOPE, {
    ...scriptedDeps([], killed),
    snapshot: () => undefined,
  });
  assert.equal(unavailable.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  const selfMissing = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([snapshot([[501, 501, true]])], killed),
  );
  assert.equal(selfMissing.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  const selfVanishes = await terminateInvocationTree(
    SCOPE,
    scriptedDeps(
      [
        snapshot([
          [500, 500],
          [501, 501, true],
        ]),
        snapshot([]),
      ],
      killed,
    ),
  );
  assert.equal(selfVanishes.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  const unsupported = await terminateInvocationTree(SCOPE, { platform: "win32" });
  assert.equal(unsupported.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unsupported);
});

test("terminateInvocationTree：selfPid<=0 时不要求快照含自身，仍能清登记组", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    { invocationId: ID, selfPid: 0, trackedGroups: [{ pgid: 600, leaderExited: () => true }] },
    scriptedDeps([snapshot([[601, 600]]), snapshot([])], killed),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [601]);
  assert.deepEqual(killed, [[601, "SIGTERM"]]);
});

test("terminateInvocationTree：清场途中新出现的成员也会被处理并计入 terminatedPids", async () => {
  const killed: Array<[number, string]> = [];
  const frames = [
    snapshot([
      [500, 500],
      [501, 501, true],
    ]),
    snapshot([
      [500, 500],
      [503, 503, true],
    ]),
    snapshot([[500, 500]]),
  ];
  const report = await terminateInvocationTree(SCOPE, scriptedDeps(frames, killed));
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [501, 503]);
  assert.deepEqual(killed, [
    [501, "SIGTERM"],
    [503, "SIGKILL"],
  ]);
});

test("terminateInvocationTree：恢复组缺少 start token 时不发信号，返回 unavailable", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    {
      invocationId: ID,
      selfPid: 0,
      trackedGroups: trackedGroupsFromPersisted([{ pgid: 600, leaderState: "alive" }]),
    },
    scriptedDeps(
      [
        snapshot([
          [600, 600],
          [601, 600],
        ]),
      ],
      killed,
    ),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  assert.deepEqual(report.terminatedPids, []);
  assert.deepEqual(report.survivorPids, []);
  assert.deepEqual(killed, []);
});

test("terminateInvocationTree：恢复组 start token 验证 unavailable 时不发信号，返回 unavailable", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    {
      invocationId: ID,
      selfPid: 0,
      trackedGroups: trackedGroupsFromPersisted([
        { pgid: 600, leaderState: "alive", startToken: "pst-v2:live" },
      ]),
    },
    {
      ...scriptedDeps(
        [
          snapshot([
            [600, 600],
            [601, 600],
          ]),
        ],
        killed,
      ),
      matchStartToken: () => "unavailable",
    },
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  assert.deepEqual(report.terminatedPids, []);
  assert.deepEqual(report.survivorPids, []);
  assert.deepEqual(killed, []);
});

test("terminateInvocationTree：轮询中 token 从 match 变为 unavailable 时不得报 clean，也不升级 SIGKILL", async () => {
  const killed: Array<[number, string]> = [];
  const alive = snapshot([
    [600, 600],
    [601, 600],
  ]);
  let checks = 0;
  const report = await terminateInvocationTree(
    {
      invocationId: ID,
      selfPid: 0,
      trackedGroups: trackedGroupsFromPersisted([
        { pgid: 600, leaderState: "alive", startToken: "pst-v2:live" },
      ]),
    },
    {
      ...scriptedDeps([alive, alive], killed),
      matchStartToken: () => {
        checks += 1;
        return checks === 1 ? "match" : "unavailable";
      },
    },
  );
  assert.equal(checks >= 2, true);
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  assert.deepEqual(report.terminatedPids, []);
  assert.deepEqual(report.survivorPids, []);
  assert.deepEqual(
    killed.filter(([, signal]) => signal === "SIGKILL"),
    [],
  );
});

test("terminateInvocationTree：首帧 mismatch 的组在 leader 退出后仍保持隔离", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    {
      invocationId: ID,
      selfPid: 0,
      trackedGroups: trackedGroupsFromPersisted([
        { pgid: 600, leaderState: "alive", startToken: "pst-v2:owned" },
        { pgid: 700, leaderState: "alive", startToken: "pst-v2:reused" },
      ]),
    },
    {
      ...scriptedDeps(
        [
          snapshot([
            [600, 600],
            [601, 600],
            [700, 700],
            [701, 700],
          ]),
          snapshot([
            [600, 600],
            [601, 600],
            [701, 700],
          ]),
          snapshot([]),
        ],
        killed,
      ),
      matchStartToken: (pid: number) => (pid === 600 ? "match" : "mismatch"),
    },
  );

  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [600, 601]);
  assert.deepEqual(report.skippedReusedGroups, [700]);
  assert.equal(
    killed.some(([pid]) => pid === 701),
    false,
    "已确认复用的进程组不能在后续帧重新进入 signal 集合",
  );
});

test("terminateInvocationTree：首帧 leader 刚退出（gone）不得隔离整组，孤儿在后续帧被终止", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    {
      invocationId: ID,
      selfPid: 0,
      trackedGroups: trackedGroupsFromPersisted([
        { pgid: 600, leaderState: "alive", startToken: "pst-v2:owned" },
      ]),
    },
    {
      ...scriptedDeps(
        [
          snapshot([
            [600, 600],
            [601, 600],
          ]),
          snapshot([[601, 600]]),
          snapshot([]),
        ],
        killed,
      ),
      matchStartToken: () => "gone",
    },
  );

  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [600, 601]);
  assert.deepEqual(report.skippedReusedGroups, []);
  assert.equal(
    killed.some(([pid]) => pid === 601),
    true,
    "leader 在快照后退出的组仍是本次运行的组，孤儿必须收到信号",
  );
});

test("terminateInvocationTree：当前 live 登记组与 previous executor 同号时以当前所有权为准", async () => {
  const ledger = new ProcessGroupLedger(() => undefined);
  ledger.track({ pid: 700, exitCode: null, signalCode: null });
  const killed: Array<[number, string]> = [];
  const alive = snapshot([
    [700, 700],
    [701, 700],
  ]);
  const report = await terminateInvocationTree(
    {
      invocationId: ID,
      selfPid: 0,
      trackedGroups: ledger.groups(),
      previousExecutorPid: 700,
    },
    scriptedDeps([alive, alive, snapshot([])], killed),
  );

  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [700, 701]);
  assert.deepEqual(report.skippedReusedGroups, []);
  assert.deepEqual(killed, [
    [700, "SIGTERM"],
    [701, "SIGTERM"],
    [700, "SIGKILL"],
    [701, "SIGKILL"],
  ]);
});

test("collectTreeMembers：旧数字 PGID 的 live leader 视为身份未知，不得 skip 复用", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500],
      [600, 600],
      [601, 600],
    ]),
    {
      invocationId: ID,
      selfPid: 500,
      trackedGroups: trackedGroupsFromPersistedPgids([600]),
    },
  );
  assert.deepEqual(members.pids, []);
  assert.deepEqual(members.skippedReusedGroups, []);
  assert.deepEqual(members.unverifiableGroups, [600]);
});

test("probeInvocationTreeSettled：旧数字 PGID 的 live leader 返回 unavailable", () => {
  assert.equal(
    probeInvocationTreeSettled(
      {
        invocationId: ID,
        selfPid: 0,
        trackedGroups: trackedGroupsFromPersistedPgids([700]),
      },
      {
        platform: "darwin",
        snapshot: () =>
          snapshot([
            [700, 700],
            [701, 700],
          ]),
      },
    ),
    "unavailable",
  );
});

test("probeInvocationTreeSettled：注入 snapshot 返回 undefined 不得回退真实快照", () => {
  assert.equal(
    probeInvocationTreeSettled(SCOPE, { platform: "darwin", snapshot: () => undefined }),
    "unavailable",
  );
});

test("probeInvocationTreeSettled：恢复组身份不可验证时返回 unavailable", () => {
  const restored = trackedGroupsFromPersisted([{ pgid: 600, leaderState: "alive" }]);
  const snap = snapshot([
    [600, 600],
    [601, 600],
  ]);
  assert.equal(
    probeInvocationTreeSettled(
      { invocationId: ID, selfPid: 0, trackedGroups: restored },
      { platform: "darwin", snapshot: () => snap },
    ),
    "unavailable",
  );
  assert.equal(
    probeInvocationTreeSettled(
      {
        invocationId: ID,
        selfPid: 0,
        trackedGroups: trackedGroupsFromPersisted([
          { pgid: 600, leaderState: "alive", startToken: "pst-v2:live" },
        ]),
      },
      { platform: "darwin", snapshot: () => snap, matchStartToken: () => "unavailable" },
    ),
    "unavailable",
  );
});

test("trackedGroupsFromPersistedPgids 身份未知；leader 不在时仍可枚举孤儿，probe 只快照不发信号", () => {
  const groups = trackedGroupsFromPersistedPgids([600, 600, 0, -1]);
  assert.deepEqual(
    groups.map((group) => group.pgid),
    [600],
  );
  assert.equal(groups[0]?.leaderExited(), false);
  assert.equal(groups[0]?.leaderState, "unknown");
  const liveness = probeInvocationTreeSettled(
    { invocationId: ID, selfPid: 0, trackedGroups: groups },
    {
      platform: "darwin",
      snapshot: () =>
        snapshot([
          [601, 600],
          [700, 700],
        ]),
    },
  );
  assert.equal(liveness, "unsettled");
  assert.equal(
    probeInvocationTreeSettled(
      { invocationId: ID, selfPid: 0, trackedGroups: groups },
      { platform: "darwin", snapshot: () => snapshot([[700, 700]]) },
    ),
    "settled",
  );
  assert.equal(probeInvocationTreeSettled(SCOPE, { platform: "win32" }), "settled");
  assert.equal(
    probeInvocationTreeSettled(SCOPE, { platform: "linux", snapshot: () => undefined }),
    "unavailable",
  );
});

const posixOnly = { skip: process.platform === "win32" };
const linuxOnly = {
  skip: process.platform !== "linux" && process.platform !== "android",
};

test(
  "真实进程：Linux 带 environ 标记的 detached 子进程被找到并终止，不同标记的对照进程不受影响",
  linuxOnly,
  async () => {
    const otherId = "99999999-8888-4777-8666-555555555555";
    const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ROLL_SCHEDULE_INVOCATION: ID },
    });
    const control = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ROLL_SCHEDULE_INVOCATION: otherId },
    });
    try {
      await Promise.all([once(target, "spawn"), once(control, "spawn")]);
      const targetExit = once(target, "exit");
      const report = await terminateInvocationTree({
        invocationId: ID,
        selfPid: process.pid,
        trackedGroups: [],
      });
      await targetExit;
      assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
      assert.ok(report.terminatedPids.includes(target.pid ?? -1));
      assert.equal(control.exitCode, null);
      assert.equal(control.signalCode, null);
    } finally {
      control.kill("SIGKILL");
      await once(control, "exit").catch(() => undefined);
      if (target.exitCode === null && target.signalCode === null) {
        target.kill("SIGKILL");
      }
    }
  },
);

test(
  "真实进程：bash 工具形状的孤儿（sh 退出后留在其进程组的 /bin/sleep）经登记组被找到并终止",
  posixOnly,
  async () => {
    const ledger = new ProcessGroupLedger();
    const shell = spawn("/bin/sh", ["-c", "/bin/sleep 60 & exit 0"], {
      detached: true,
      stdio: "ignore",
    });
    ledger.track(shell);
    await once(shell, "exit");
    const scope = { invocationId: ID, selfPid: process.pid, trackedGroups: ledger.groups() };
    const before = collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope);
    assert.equal(before.pids.length, 1, "sh 退出后应留下一个孤儿 sleep");
    const report = await terminateInvocationTree(scope);
    assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
    assert.deepEqual(report.terminatedPids, before.pids);
    const after = collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope);
    assert.deepEqual(after.pids, []);
  },
);

test("真实进程：测试进程不是组首领时不会误杀同组进程", posixOnly, async () => {
  const sibling = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  try {
    await once(sibling, "spawn");
    const snap = snapshotProcesses(invocationMarker(ID));
    assert.ok(snap);
    const self = snap.find((entry) => entry.pid === process.pid);
    assert.ok(self);
    if (self.pgid === process.pid) {
      return;
    }
    const report = await terminateInvocationTree({
      invocationId: ID,
      selfPid: process.pid,
      trackedGroups: [],
    });
    assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
    assert.equal(report.terminatedPids.includes(sibling.pid ?? -1), false);
    assert.equal(sibling.exitCode, null);
  } finally {
    sibling.kill("SIGKILL");
    await once(sibling, "exit").catch(() => undefined);
  }
});

test(
  "真实进程：快照里 Linux environ 标记只命中那个子进程，不含做快照的 ps，测试进程自身在快照里",
  linuxOnly,
  async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ROLL_SCHEDULE_INVOCATION: ID },
    });
    try {
      await once(child, "spawn");
      const snap = snapshotProcesses(invocationMarker(ID));
      assert.ok(snap);
      assert.deepEqual(
        snap.filter((entry) => entry.marked).map((entry) => entry.pid),
        [child.pid],
      );
      assert.equal(
        snap.some((entry) => entry.pid === process.pid),
        true,
      );
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
  },
);

test("真实进程：持久化 live leader 不得当成 PID 复用；token 不匹配才跳过", posixOnly, async () => {
  const child = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    await once(child, "spawn");
    const pid = child.pid;
    assert.ok(pid);
    const snap = () => snapshotProcesses(invocationMarker(ID)) ?? [];
    const unknownIdentity = collectTreeMembers(snap(), {
      invocationId: ID,
      selfPid: 0,
      trackedGroups: trackedGroupsFromPersistedPgids([pid]),
    });
    assert.deepEqual(unknownIdentity, {
      pids: [],
      skippedReusedGroups: [],
      unverifiableGroups: [pid],
    });
    const live = collectTreeMembers(
      snap(),
      {
        invocationId: ID,
        selfPid: 0,
        trackedGroups: trackedGroupsFromPersisted([
          { pgid: pid, leaderState: "alive", startToken: "pst-v2:keep" },
        ]),
      },
      { matchStartToken: () => "match" },
    );
    assert.equal(live.pids.includes(pid), true);
    assert.deepEqual(live.skippedReusedGroups, []);
    const reused = collectTreeMembers(
      snap(),
      {
        invocationId: ID,
        selfPid: 0,
        trackedGroups: trackedGroupsFromPersisted([
          { pgid: pid, leaderState: "alive", startToken: "pst-v2:old" },
        ]),
      },
      { matchStartToken: () => "mismatch" },
    );
    assert.deepEqual(reused, { pids: [], skippedReusedGroups: [pid], unverifiableGroups: [] });
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
});

test(
  "真实进程：恢复组 leader 在 ps 快照之后退出，孤儿仍被找到并终止（process-not-found 不算 PID 复用）",
  posixOnly,
  async () => {
    const leader = spawn("/bin/sh", ["-c", "/bin/sleep 60 & /bin/sleep 0.6; exit 0"], {
      detached: true,
      stdio: "ignore",
    });
    let orphan: number | undefined;
    try {
      await once(leader, "spawn");
      const pgid = leader.pid;
      assert.ok(pgid);
      const token = readProcessStartToken(pgid);
      assert.ok(token, "leader 存活时必须能读到 start token");
      let stale: ProcessSnapshot = [];
      for (let attempt = 0; attempt < 20 && orphan === undefined; attempt += 1) {
        stale = snapshotProcesses(MARKER) ?? [];
        orphan = stale.find((entry) => entry.pgid === pgid && entry.pid !== pgid)?.pid;
        if (orphan === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.ok(orphan, "过期快照里必须已经有 leader 组的孤儿");
      assert.ok(stale.some((entry) => entry.pid === pgid && !entry.zombie));
      await once(leader, "exit");
      let frames = 0;
      const report = await terminateInvocationTree(
        {
          invocationId: ID,
          selfPid: 0,
          trackedGroups: trackedGroupsFromPersisted([
            { pgid, leaderState: "alive", startToken: token },
          ]),
        },
        {
          snapshot: (marker) => (frames++ === 0 ? stale : snapshotProcesses(marker)),
        },
      );
      assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
      assert.ok(report.terminatedPids.includes(orphan), JSON.stringify(report));
      assert.deepEqual(report.skippedReusedGroups, []);
      const after = (snapshotProcesses(MARKER) ?? []).filter(
        (entry) => entry.pgid === pgid && !entry.zombie,
      );
      assert.deepEqual(after, []);
    } finally {
      if (orphan !== undefined) {
        try {
          process.kill(orphan, "SIGKILL");
        } catch {
          // already gone
        }
      }
      if (leader.exitCode === null && leader.signalCode === null) {
        leader.kill("SIGKILL");
      }
    }
  },
);

test("真实进程：argv 含标记但 env 无标记时不得进入 terminatedPids", posixOnly, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", MARKER], {
    detached: true,
    stdio: "ignore",
    env: omitScheduleInvocationEnv(process.env),
  });
  try {
    await once(child, "spawn");
    const report = await terminateInvocationTree({
      invocationId: ID,
      selfPid: process.pid,
      trackedGroups: [],
    });
    assert.equal(report.terminatedPids.includes(child.pid ?? -1), false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
});

test(
  "真实进程：持久化登记组未 teardown 时组外孤儿仍存活，probe 为 unsettled",
  posixOnly,
  async () => {
    const ledger = new ProcessGroupLedger();
    const shell = spawn("/bin/sh", ["-c", "/bin/sleep 60 & exit 0"], {
      detached: true,
      stdio: "ignore",
    });
    ledger.track(shell);
    await once(shell, "exit");
    const pgids = ledger.groups().map((group) => group.pgid);
    const scope = {
      invocationId: ID,
      selfPid: 0,
      trackedGroups: trackedGroupsFromPersistedPgids(pgids),
    };
    try {
      const members = collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope);
      assert.equal(members.pids.length, 1, "sh 退出后应留下一个孤儿 sleep");
      assert.equal(probeInvocationTreeSettled(scope), "unsettled");
      const still = collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope);
      assert.deepEqual(still.pids, members.pids);
    } finally {
      for (const pid of collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope)
        .pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  },
);
