import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawnSession } from "./session-exec.ts";
import { pollUntilDeadline, SessionPollInProgressError } from "./yield-loop.ts";
import { killProcessGroup } from "../kill.ts";
import { SESSION_STATES, type ManagedSession } from "./types.ts";
import type { ShellProfile } from "../profile.ts";

const skip = process.platform === "win32";

function profile(file: string): ShellProfile {
  return {
    id: "posix",
    toolName: "bash",
    supportsSessionExec: true,
    supportsSafeCommandClassification: true,
    buildSpawn: (command, workdir, env) => ({
      file,
      args: ["-c", command],
      options: { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
    }),
    classify: () => "unknown",
    killTree: async (pid, intent) => {
      killProcessGroup(pid, intent === "interrupt" ? "SIGINT" : "SIGKILL");
    },
    systemPromptHints: () => [],
  };
}

function make(command: string): ManagedSession {
  return spawnSession({
    id: 4_242,
    command,
    workdir: process.cwd(),
    profile: profile("/bin/sh"),
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
  assert.equal(session.state, SESSION_STATES.completed);

  const repeated = await pollUntilDeadline(session, performance.now() + 100, 10_000);
  assert.deepEqual(repeated, result, "terminal snapshot 应可重复 poll");
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
    profile: profile("/nonexistent-shell-roll-test"),
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

test("abort 立即结束 poll 且不消费已缓冲输出", { skip }, async () => {
  const session = make("printf buffered; sleep 5");
  const controller = new AbortController();
  const polling = pollUntilDeadline(session, performance.now() + 5_000, 10_000, {
    abortSignal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("test abort")), 50);

  try {
    const startedAt = performance.now();
    await assert.rejects(polling, /test abort/u);
    assert.ok(performance.now() - startedAt < 1_000);

    const next = await pollUntilDeadline(session, performance.now() + 50, 10_000);
    assert.equal(next.kind, "running");
    assert.ok(next.output.includes("buffered"), "abort 不应 drain 输出");
  } finally {
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});

test("同一 session 禁止并发 poll", { skip }, async () => {
  const session = make("sleep 5");
  const controller = new AbortController();
  const first = pollUntilDeadline(session, performance.now() + 5_000, 10_000, {
    abortSignal: controller.signal,
  });

  try {
    await assert.rejects(
      pollUntilDeadline(session, performance.now() + 10, 10_000),
      SessionPollInProgressError,
    );
  } finally {
    controller.abort(new Error("finish concurrent poll test"));
    await assert.rejects(first, /finish concurrent poll test/u);
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});

test("poll 结束后解绑 delta handler，后续输出只进 buffer", { skip }, async () => {
  const deltas: string[] = [];
  const session = spawnSession({
    id: 8_888,
    command: "printf first; sleep 0.2; printf second; sleep 5",
    workdir: process.cwd(),
    profile: profile("/bin/sh"),
    env: process.env,
    bufferCapacity: 100_000,
    onDelta: (_stream, delta) => deltas.push(delta),
  });

  try {
    const first = await pollUntilDeadline(session, performance.now() + 100, 10_000);
    assert.equal(first.kind, "running");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(deltas.join("").includes("second"), false);

    const second = await pollUntilDeadline(session, performance.now() + 20, 10_000);
    assert.ok(second.output.includes("second"));
  } finally {
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});

test("根进程 exit 但 stdio 未 close 时仍是 draining，不返回 exited", { skip }, async () => {
  const childScript = [
    'const { spawn } = require("node:child_process")',
    'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: ["ignore", 1, 2] })',
    "console.log(child.pid)",
    "child.unref()",
  ].join(";");
  const session = make(`${shellQuote(process.execPath)} -e ${shellQuote(childScript)}`);

  try {
    await session.waitExit();
    assert.equal(session.state, SESSION_STATES.draining);
    assert.equal(session.closeObserved, false);

    const result = await pollUntilDeadline(session, performance.now() + 50, 10_000);
    assert.equal(result.kind, "running");
  } finally {
    killProcessGroup(session.child.pid, "SIGKILL");
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
