import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { SessionManager, SessionCapError } from "./session-manager.ts";
import { pollUntilDeadline } from "./yield-loop.ts";
import { killProcessGroup } from "../kill.ts";
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
    mgr.terminateAll();
    await pollUntilDeadline(first, performance.now() + 500, 100);
  }
});

test("已退出会话被回收后可 spawn 新会话", { skip }, async () => {
  const mgr = manager(1, [11, 22]);
  const first = mgr.spawn({ command: "exit 0", workdir: process.cwd() });
  await pollUntilDeadline(first, performance.now() + 2_000, 100);
  assert.notEqual(first.exitCode, undefined);
  const second = mgr.spawn({ command: "sleep 5", workdir: process.cwd() });
  assert.equal(second.id, 22);
  assert.equal(mgr.size(), 1);
  mgr.terminateAll();
  await pollUntilDeadline(second, performance.now() + 500, 100);
});

test("terminateAll 杀掉活进程并清空", { skip }, async () => {
  const mgr = manager(4);
  const session = mgr.spawn({ command: "sleep 30", workdir: process.cwd() });
  assert.equal(mgr.size(), 1);
  mgr.terminateAll();
  assert.equal(mgr.size(), 0);
  const result = await pollUntilDeadline(session, performance.now() + 3_000, 100);
  assert.equal(result.kind, "exited");
});

test("interruptAll 中断活进程并清空", { skip }, async () => {
  const mgr = manager(4);
  const session = await spawnReadySession(mgr);
  assert.equal(mgr.size(), 1);
  mgr.interruptAll();
  assert.equal(mgr.size(), 0);
  const result = await pollUntilDeadline(session, performance.now() + 3_000, 100);
  assert.equal(result.kind, "exited");
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

  mgr.interruptAll();

  const result = await pollUntilDeadline(session, performance.now() + 3_000, 100);
  assert.equal(result.kind, "exited");
  assert.deepEqual(intents, ["interrupt", "terminate"]);
});

test("get 命中已注册会话", { skip }, async () => {
  const mgr = manager(4, [777]);
  const session = mgr.spawn({ command: "sleep 5", workdir: process.cwd() });
  assert.equal(mgr.get(777)?.id, session.id);
  assert.equal(mgr.get(9999), undefined);
  mgr.terminateAll();
  await pollUntilDeadline(session, performance.now() + 500, 100);
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
