import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawnSession } from "./session-exec.ts";
import { pollUntilDeadline } from "./yield-loop.ts";
import { killProcessGroup } from "../kill.ts";
import type { ManagedSession } from "./types.ts";

const skip = process.platform === "win32";

function make(command: string): ManagedSession {
  return spawnSession({
    id: 4_242,
    command,
    workdir: process.cwd(),
    shell: "/bin/sh",
    env: process.env,
    bufferCapacity: 100_000,
  });
}

test("短跑命令首窗即返回 exited + exitCode", { skip }, async () => {
  const session = make("printf done; exit 3");
  const result = await pollUntilDeadline(session, performance.now() + 3_000, 10_000);
  assert.equal(result.kind, "exited");
  assert.equal(result.kind === "exited" ? result.exitCode : -1, 3);
  assert.ok(result.output.includes("done"));
});

test("长跑命令首窗返回 running + sessionId + 部分输出", { skip }, async () => {
  const session = make("printf started; sleep 5");
  try {
    const result = await pollUntilDeadline(session, performance.now() + 400, 10_000);
    assert.equal(result.kind, "running");
    assert.equal(result.kind === "running" ? result.sessionId : -1, 4_242);
    assert.ok(result.output.includes("started"));
    assert.equal(session.exitCode, undefined);
  } finally {
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});

test("deadline 到点即返回，不等进程结束", { skip }, async () => {
  const session = make("sleep 5");
  try {
    const start = performance.now();
    const result = await pollUntilDeadline(session, performance.now() + 150, 10_000);
    const elapsed = performance.now() - start;
    assert.equal(result.kind, "running");
    assert.ok(elapsed < 2_000, `应在 deadline 附近返回，实际 ${String(elapsed)}ms`);
  } finally {
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});

test("进程在 deadline 前退出则提前返回 exited", { skip }, async () => {
  const session = make("sleep 0.1");
  const start = performance.now();
  const result = await pollUntilDeadline(session, performance.now() + 10_000, 10_000);
  const elapsed = performance.now() - start;
  assert.equal(result.kind, "exited");
  assert.ok(elapsed < 5_000, `应在进程退出后立刻返回，实际 ${String(elapsed)}ms`);
});

test("spawn 失败时错误信息进 buffer，poll 返回 exited", { skip }, async () => {
  const session = spawnSession({
    id: 1,
    command: "true",
    workdir: process.cwd(),
    shell: "/nonexistent-shell-roll-test",
    env: process.env,
    bufferCapacity: 10_000,
  });
  const result = await pollUntilDeadline(session, performance.now() + 3_000, 10_000);
  assert.equal(result.kind, "exited");
  assert.ok(result.output.includes("无法启动进程"));
});

test("续查同一 session：空轮询拿到后续输出直至退出", { skip }, async () => {
  const session = make("printf one; sleep 0.3; printf two; sleep 0.3");
  try {
    const first = await pollUntilDeadline(session, performance.now() + 150, 10_000);
    assert.equal(first.kind, "running");
    assert.ok(first.output.includes("one"));
    const second = await pollUntilDeadline(session, performance.now() + 2_000, 10_000);
    assert.equal(second.kind, "exited");
    assert.ok(second.output.includes("two"));
  } finally {
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});
