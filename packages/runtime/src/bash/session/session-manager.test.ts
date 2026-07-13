import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { SessionManager, SessionCapError } from "./session-manager.ts";
import { pollUntilDeadline } from "./yield-loop.ts";
import { killProcessGroup } from "../kill.ts";
import { SESSION_STATES, type ManagedSession, type SessionState } from "./types.ts";
import type { ShellProfile } from "../profile.ts";

const skip = process.platform === "win32";

const profile: ShellProfile = {
  id: "posix",
  toolName: "bash",
  supportsSessionExec: true,
  supportsSafeCommandClassification: true,
  buildSpawn: (command, workdir, env) => ({
    file: "/bin/sh",
    args: ["-c", command],
    options: { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
  }),
  classify: () => "unknown",
  killTree: async (pid, intent) => {
    killProcessGroup(pid, intent === "interrupt" ? "SIGINT" : "SIGKILL");
  },
  systemPromptHints: () => [],
};

function manager(maxSessions: number, ids?: number[]): SessionManager {
  let cursor = 0;
  return new SessionManager({
    maxSessions,
    profile,
    env: process.env,
    bufferCapacity: 100_000,
    ...(ids ? { generateId: () => ids[cursor++ % ids.length] ?? 1 } : {}),
  });
}

test("满且全活时 spawn 抛 SessionCapError", { skip }, async () => {
  const mgr = manager(1, [11, 22]);
  const first = mgr.spawn({ command: "sleep 5", workdir: process.cwd() });
  try {
    assert.throws(() => mgr.spawn({ command: "sleep 5", workdir: process.cwd() }), SessionCapError);
    assert.equal(mgr.size(), 1);
  } finally {
    await mgr.terminateAll();
    await pollUntilDeadline(first, performance.now() + 500, 100);
  }
});

test("已退出 tombstone 不占 active cap，且 id 不复用", { skip }, async () => {
  const mgr = manager(1, [11, 22]);
  const first = mgr.spawn({ command: "exit 0", workdir: process.cwd() });
  await pollUntilDeadline(first, performance.now() + 2_000, 100);
  assert.notEqual(first.exitCode, undefined);
  assert.equal(mgr.size(), 0);
  assert.equal(mgr.get(11), first);
  const second = mgr.spawn({ command: "sleep 5", workdir: process.cwd() });
  assert.equal(second.id, 22);
  assert.equal(mgr.size(), 1);
  await mgr.terminateAll();
  await pollUntilDeadline(second, performance.now() + 500, 100);
});

test("terminateAll 等待活进程清理完成", { skip }, async () => {
  const mgr = manager(4);
  const session = mgr.spawn({ command: "sleep 30", workdir: process.cwd() });
  assert.equal(mgr.size(), 1);
  await mgr.terminateAll();
  assert.equal(mgr.size(), 0);
  const result = await pollUntilDeadline(session, performance.now() + 3_000, 100);
  assert.equal(result.kind, "exited");
  assert.equal(result.kind === "exited" ? result.terminationCause : undefined, "terminate");
});

test("close 等待清理并永久拒绝新 session", { skip }, async () => {
  const mgr = manager(1);
  const session = mgr.spawn({ command: "sleep 30", workdir: process.cwd() });

  await mgr.close();

  assert.equal(session.state, SESSION_STATES.completed);
  assert.equal(mgr.size(), 0);
  assert.throws(
    () => mgr.spawn({ command: "printf late", workdir: process.cwd() }),
    /会话管理器已关闭/u,
  );
});

test("interruptAll 等待中断活进程", { skip }, async () => {
  const mgr = manager(4);
  const session = await spawnReadySession(mgr);
  assert.equal(mgr.size(), 1);
  await mgr.interruptAll();
  assert.equal(mgr.size(), 0);
  const result = await pollUntilDeadline(session, performance.now() + 3_000, 100);
  assert.equal(result.kind, "exited");
  assert.equal(result.kind === "exited" ? result.terminationCause : undefined, "interrupt");
});

test("interruptAll 在 grace 后升级 terminate，避免遗留失联进程", { skip }, async () => {
  const intents: Array<"interrupt" | "terminate"> = [];
  const escalationProfile: ShellProfile = {
    ...profile,
    killTree: async (pid, intent) => {
      intents.push(intent);
      if (intent === "terminate") {
        killProcessGroup(pid, "SIGKILL");
      }
    },
  };
  const mgr = new SessionManager({
    maxSessions: 4,
    profile: escalationProfile,
    env: process.env,
    bufferCapacity: 100_000,
    interruptGraceMs: 10,
  });
  const session = await spawnReadySession(mgr);

  await mgr.interruptAll();

  const result = await pollUntilDeadline(session, performance.now() + 3_000, 100);
  assert.equal(result.kind, "exited");
  assert.deepEqual(intents, ["interrupt", "terminate"]);
});

test("Windows 语义下 interrupt 已让根进程退出时不对旧 PID 重复 taskkill", { skip }, async () => {
  const intents: Array<"interrupt" | "terminate"> = [];
  const childScript = [
    'const { spawn } = require("node:child_process")',
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { stdio: ["ignore", 1, 2] })',
    'console.log("ready")',
    "setInterval(() => {}, 1000)",
  ].join(";");
  const rootExitSensitiveProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    buildSpawn: (_command, workdir, env) => ({
      file: process.execPath,
      args: ["-e", childScript],
      options: { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
    }),
    killTree: async (pid, intent) => {
      intents.push(intent);
      if (pid === undefined) {
        throw new Error("test process did not expose a PID");
      }
      process.kill(pid, "SIGTERM");
    },
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    profile: rootExitSensitiveProfile,
    env: process.env,
    bufferCapacity: 1_000,
    interruptGraceMs: 20,
    rootSettleTimeoutMs: 100,
    closeDrainTimeoutMs: 500,
  });
  const session = await spawnReadySession(mgr);

  await mgr.interrupt(session.id);

  assert.deepEqual(intents, ["interrupt"]);
  assert.equal(session.exitObserved, true);
  assert.equal(session.closeObserved, true);
  assert.equal(session.state, SESSION_STATES.completed);
});

test("interrupt killTree 失败后仍升级 terminate，不吞并发升级", { skip }, async () => {
  const intents: Array<"interrupt" | "terminate"> = [];
  const escalationProfile: ShellProfile = {
    ...profile,
    killTree: async (pid, intent) => {
      intents.push(intent);
      if (intent === "interrupt") {
        throw new Error("interrupt failed");
      }
      killProcessGroup(pid, "SIGKILL");
    },
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    profile: escalationProfile,
    env: process.env,
    bufferCapacity: 1_000,
    interruptGraceMs: 10,
  });
  const session = await spawnReadySession(mgr);

  const interrupt = mgr.interrupt(session.id);
  const terminate = mgr.terminate(session.id);
  await Promise.all([interrupt, terminate]);

  assert.deepEqual(intents, ["interrupt", "terminate"]);
  assert.equal(session.state, SESSION_STATES.cleanupFailed);
  assert.match(session.cleanupError ?? "", /interrupt failed/u);
  assert.equal(session.exitObserved, true);
  assert.equal(mgr.delete(session.id), true);
});

test("get 命中已注册会话", { skip }, async () => {
  const mgr = manager(4, [777]);
  const session = mgr.spawn({ command: "sleep 5", workdir: process.cwd() });
  assert.equal(mgr.get(777)?.id, session.id);
  assert.equal(mgr.get(9999), undefined);
  await mgr.terminateAll();
  await pollUntilDeadline(session, performance.now() + 500, 100);
});

test("仅保留最近 maxSessions 个 terminal tombstone", { skip }, async () => {
  const mgr = manager(1, [11, 22]);
  const first = mgr.spawn({ command: "printf first", workdir: process.cwd() });
  await pollUntilDeadline(first, performance.now() + 2_000, 1_000);

  const second = mgr.spawn({ command: "printf second", workdir: process.cwd() });
  await pollUntilDeadline(second, performance.now() + 2_000, 1_000);
  await Promise.resolve();

  assert.equal(mgr.get(11), undefined);
  assert.equal(mgr.get(22), second);
  const repeated = await pollUntilDeadline(second, performance.now() + 10, 1_000);
  assert.equal(repeated.kind, "exited");
  assert.ok(repeated.output.includes("second"));
});

test("interrupt/terminate 共用 single-flight，killTree 不并发", { skip }, async () => {
  const intents: Array<"interrupt" | "terminate"> = [];
  let activeKills = 0;
  let maxActiveKills = 0;
  const sequentialProfile: ShellProfile = {
    ...profile,
    killTree: async (pid, intent) => {
      intents.push(intent);
      activeKills += 1;
      maxActiveKills = Math.max(maxActiveKills, activeKills);
      await new Promise((resolve) => setTimeout(resolve, 30));
      activeKills -= 1;
      if (intent === "terminate") {
        killProcessGroup(pid, "SIGKILL");
      }
    },
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    profile: sequentialProfile,
    env: process.env,
    bufferCapacity: 1_000,
    interruptGraceMs: 10,
  });
  const session = await spawnReadySession(mgr);

  const first = mgr.interrupt(session.id);
  const second = mgr.terminate(session.id);
  await Promise.all([first, second]);

  assert.deepEqual(intents, ["interrupt", "terminate"]);
  assert.equal(maxActiveKills, 1);
  assert.equal(session.state, SESSION_STATES.completed);
});

test("killTree 卡住时有界收口并标记 cleanup-failed", { skip }, async () => {
  const hangingProfile: ShellProfile = {
    ...profile,
    killTree: () => new Promise<void>(() => {}),
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    profile: hangingProfile,
    env: process.env,
    bufferCapacity: 1_000,
    killTreeTimeoutMs: 20,
    closeDrainTimeoutMs: 20,
    rootSettleTimeoutMs: 20,
  });
  const session = mgr.spawn({ command: "sleep 30", workdir: process.cwd() });

  try {
    const startedAt = performance.now();
    await mgr.terminate(session.id);
    assert.ok(performance.now() - startedAt < 500);
    assert.equal(session.state, SESSION_STATES.cleanupFailed);
    assert.match(session.cleanupError ?? "", /进程树终止/u);
    assert.equal(mgr.size(), 1);
    assert.throws(
      () => mgr.spawn({ command: "printf blocked", workdir: process.cwd() }),
      SessionCapError,
    );
    const terminal = await pollUntilDeadline(session, performance.now() + 10, 100);
    assert.equal(terminal.kind, "exited");
    assert.equal(mgr.delete(session.id), true);
    assert.equal(mgr.size(), 0);
  } finally {
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});

test("killTree 失败时回退强杀根进程，但不伪报进程树已清理", { skip }, async () => {
  const failingProfile: ShellProfile = {
    ...profile,
    killTree: async () => {
      throw new Error("tree kill failed");
    },
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    profile: failingProfile,
    env: process.env,
    bufferCapacity: 1_000,
    rootSettleTimeoutMs: 20,
    closeDrainTimeoutMs: 100,
  });
  const session = await spawnReadySession(mgr);

  await mgr.terminate(session.id);

  assert.equal(session.exitObserved, true);
  assert.equal(session.state, SESSION_STATES.cleanupFailed);
  assert.match(session.cleanupError ?? "", /tree kill failed/u);
  assert.equal(mgr.delete(session.id), true);
});

test("根进程退出后 stdio 超时由 manager 回收进程树", { skip }, async () => {
  const mgr = new SessionManager({
    maxSessions: 1,
    profile,
    env: process.env,
    bufferCapacity: 1_000,
    closeDrainTimeoutMs: 20,
    rootSettleTimeoutMs: 100,
  });
  const childScript = [
    'const { spawn } = require("node:child_process")',
    'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: ["ignore", 1, 2] })',
    "console.log(child.pid)",
    "child.unref()",
  ].join(";");
  const session = mgr.spawn({
    command: `${shellQuote(process.execPath)} -e ${shellQuote(childScript)}`,
    workdir: process.cwd(),
  });

  await session.waitExit();
  assert.equal(session.state, SESSION_STATES.draining);
  await session.waitSettled();
  await waitForState(session, SESSION_STATES.cleanupFailed);

  assert.equal(session.state, SESSION_STATES.cleanupFailed);
  assert.match(session.cleanupError ?? "", /stdio/u);
  assert.equal(mgr.size(), 1);
  assert.equal(mgr.delete(session.id), true);
  assert.equal(mgr.size(), 0);
});

test("Windows 语义下根进程已退出时不对旧 PID 调 taskkill，保守标记清理失败", { skip }, async () => {
  let killTreeCalls = 0;
  const rootExitSensitiveProfile: ShellProfile = {
    ...profile,
    waitForTreeKillAfterRootExit: true,
    killTree: async () => {
      killTreeCalls += 1;
    },
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    profile: rootExitSensitiveProfile,
    env: process.env,
    bufferCapacity: 1_000,
    closeDrainTimeoutMs: 20,
    rootSettleTimeoutMs: 20,
  });
  const childScript = [
    'const { spawn } = require("node:child_process")',
    'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: ["ignore", 1, 2] })',
    "console.log(child.pid)",
    "child.unref()",
  ].join(";");
  const session = mgr.spawn({
    command: `${shellQuote(process.execPath)} -e ${shellQuote(childScript)}`,
    workdir: process.cwd(),
  });

  try {
    await session.waitExit();
    await session.waitSettled();

    assert.equal(killTreeCalls, 0);
    assert.equal(session.state, SESSION_STATES.cleanupFailed);
    assert.match(session.cleanupError ?? "", /旧 PID/u);
    assert.equal(mgr.size(), 1);
    assert.equal(mgr.delete(session.id), true);
    assert.equal(mgr.size(), 0);
  } finally {
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});

test("list 同时返回 active 与 terminal 元数据", { skip }, async () => {
  const mgr = manager(2, [101, 102]);
  const completed = mgr.spawn({
    command: "printf one\nprintf two\nexit 7",
    workdir: process.cwd(),
  });
  await pollUntilDeadline(completed, performance.now() + 2_000, 100);
  const running = mgr.spawn({ command: "sleep 30", workdir: process.cwd() });

  try {
    assert.deepEqual(
      mgr.list().map(({ sessionId, state, exitCode }) => ({ sessionId, state, exitCode })),
      [
        { sessionId: 101, state: "completed", exitCode: 7 },
        { sessionId: 102, state: "running", exitCode: undefined },
      ],
    );
    assert.equal(mgr.list()[0]?.commandPreview, "printf one printf two exit 7");
  } finally {
    await mgr.terminate(running.id);
  }
});

async function spawnReadySession(mgr: SessionManager) {
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const session = mgr.spawn({
    command: "printf 'ready\\n'; exec sleep 30",
    workdir: process.cwd(),
    onDelta: (_stream, delta) => {
      if (delta.includes("ready")) {
        markReady?.();
      }
    },
  });
  await ready;
  return session;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForState(
  session: ManagedSession,
  expected: SessionState,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (session.state !== expected && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(session.state, expected);
}
