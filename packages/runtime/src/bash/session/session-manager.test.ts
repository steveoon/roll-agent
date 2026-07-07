import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { SessionManager, SessionCapError } from "./session-manager.ts";
import { pollUntilDeadline } from "./yield-loop.ts";

const skip = process.platform === "win32";

function manager(maxSessions: number, ids?: number[]): SessionManager {
  let cursor = 0;
  return new SessionManager({
    maxSessions,
    shell: "/bin/sh",
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

test("get 命中已注册会话", { skip }, async () => {
  const mgr = manager(4, [777]);
  const session = mgr.spawn({ command: "sleep 5", workdir: process.cwd() });
  assert.equal(mgr.get(777)?.id, session.id);
  assert.equal(mgr.get(9999), undefined);
  mgr.terminateAll();
  await pollUntilDeadline(session, performance.now() + 500, 100);
});
