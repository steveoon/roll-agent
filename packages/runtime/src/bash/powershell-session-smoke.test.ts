import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ToolExecutionOptions } from "ai";
import { resolveShellProfile, type ShellProfile } from "./profile.ts";
import { SessionCapError, SessionManager } from "./session/session-manager.ts";
import { isTerminalSessionState, type ManagedSession } from "./session/types.ts";
import { pollUntilDeadline } from "./session/yield-loop.ts";
import type { PolicyDecision, ToolPolicy } from "../types/policy.ts";
import {
  TURN_TIMEOUT_ABORT_REASON,
  USER_CANCELLATION_ABORT_REASON,
} from "../types/cancellation.ts";
import { ToolRegistry } from "../tool-bridge/naming.ts";
import type { NormalizedToolResult } from "../tool-bridge/normalize-result.ts";
import {
  buildSessionExecToolset,
  EXEC_COMMAND_ID,
  EXEC_LIST_ID,
  EXEC_POLL_ID,
  type ExecCommandInput,
  type ExecPollInput,
} from "../tool-bridge/session-exec-tool.ts";

const skip = process.platform !== "win32";
const TEST_TIMEOUT_MS = 45_000;
const POLL_OUTPUT_CHARS = 100_000;

let cachedPowerShellProfile: ShellProfile | undefined;

const allowPolicy: ToolPolicy = {
  check: (): PolicyDecision => ({ action: "allow" }),
};

function powerShellProfile(): ShellProfile {
  cachedPowerShellProfile ??= (() => {
    const result = resolveShellProfile({ platform: "win32", env: process.env });
    if (!result.supported) {
      assert.fail(`PowerShell profile unsupported: ${result.reason}`);
    }
    return result.profile;
  })();
  return cachedPowerShellProfile;
}

function manager(maxSessions = 4, generateId?: () => number): SessionManager {
  return new SessionManager({
    maxSessions,
    profile: powerShellProfile(),
    env: process.env,
    bufferCapacity: POLL_OUTPUT_CHARS,
    ...(generateId ? { generateId } : {}),
  });
}

function toolOptions(id: string, abortSignal?: AbortSignal): ToolExecutionOptions<unknown> {
  return {
    toolCallId: id,
    messages: [],
    context: undefined,
    ...(abortSignal ? { abortSignal } : {}),
  };
}

function sessionToolHarness(mgr: SessionManager): {
  execCommand: (
    input: ExecCommandInput,
    abortSignal?: AbortSignal,
  ) => Promise<NormalizedToolResult>;
  execPoll: (input: ExecPollInput) => Promise<NormalizedToolResult>;
  execList: () => Promise<NormalizedToolResult>;
} {
  const registry = new ToolRegistry();
  const toolset = buildSessionExecToolset(
    { workdir: tmpdir(), defaultYieldMs: 250, maxOutputTokens: 10_000 },
    mgr,
    registry,
    {
      policy: allowPolicy,
      requestApproval: async () => ({ approved: true }),
    },
  );
  const command = toolset[EXEC_COMMAND_ID];
  const poll = toolset[EXEC_POLL_ID];
  const list = toolset[EXEC_LIST_ID];
  assert.ok(command?.execute);
  assert.ok(poll?.execute);
  assert.ok(list?.execute);
  return {
    execCommand: (input, abortSignal) =>
      Promise.resolve(
        command.execute?.(
          input,
          toolOptions("windows-command", abortSignal),
        ) as Promise<NormalizedToolResult>,
      ),
    execPoll: (input) =>
      Promise.resolve(
        poll.execute?.(input, toolOptions("windows-poll")) as Promise<NormalizedToolResult>,
      ),
    execList: () =>
      Promise.resolve(
        list.execute?.({}, toolOptions("windows-list")) as Promise<NormalizedToolResult>,
      ),
  };
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  failureMessage: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true, failureMessage);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test(
  "PowerShell session: UTF-8 中文输出通过增量回调到达",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const mgr = manager(1);
    const deltas: string[] = [];
    let session: ManagedSession | undefined;
    let firstLineObservedBeforeExit = false;

    try {
      session = mgr.spawn({
        command: [
          "[Console]::Out.WriteLine('中文增量-第一段')",
          "[Console]::Out.Flush()",
          "Start-Sleep -Milliseconds 750",
          "[Console]::Out.WriteLine('中文增量-第二段')",
        ].join("; "),
        workdir: tmpdir(),
        onDelta: (_stream, delta) => {
          deltas.push(delta);
          if (deltas.join("").includes("中文增量-第一段") && session?.exitObserved === false) {
            firstLineObservedBeforeExit = true;
          }
        },
      });

      const result = await pollUntilDeadline(
        session,
        performance.now() + 10_000,
        POLL_OUTPUT_CHARS,
      );

      assert.equal(result.kind, "exited");
      assert.equal(result.kind === "exited" ? result.exitCode : -1, 0);
      assert.equal(firstLineObservedBeforeExit, true, "第一段中文应在进程退出前增量送达");
      assert.match(deltas.join(""), /中文增量-第一段/u);
      assert.match(deltas.join(""), /中文增量-第二段/u);
      assert.match(result.output, /中文增量-第一段/u);
      assert.match(result.output, /中文增量-第二段/u);
    } finally {
      await mgr.terminateAll();
    }
  },
);

test(
  "PowerShell session: 长命令首窗 running，续 poll 返回 Exit code 0",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const mgr = manager(1);
    const session = mgr.spawn({
      command:
        "[Console]::Out.WriteLine('long-command-started'); Start-Sleep -Seconds 2; [Console]::Out.WriteLine('long-command-finished')",
      workdir: tmpdir(),
    });

    try {
      const first = await pollUntilDeadline(session, performance.now() + 100, POLL_OUTPUT_CHARS);
      assert.equal(first.kind, "running");
      assert.equal(first.kind === "running" ? first.sessionId : -1, session.id);

      const completed = await pollUntilDeadline(
        session,
        performance.now() + 10_000,
        POLL_OUTPUT_CHARS,
      );
      assert.equal(completed.kind, "exited");
      assert.equal(completed.kind === "exited" ? completed.exitCode : -1, 0);
      assert.match(completed.output, /long-command-finished/u);
    } finally {
      await mgr.terminateAll();
    }
  },
);

for (const intent of ["interrupt", "terminate"] as const) {
  test(
    `PowerShell session: manager ${intent} 清理普通 PowerShell 到 Node 的进程树`,
    { skip, timeout: TEST_TIMEOUT_MS },
    async () => {
      const profile = powerShellProfile();
      const mgr = manager(1);
      const nodeScript =
        'console.log("ROLL_NODE_CHILD_PID=" + process.pid); setInterval(() => {}, 1_000)';
      let childPid: number | undefined;
      let output = "";
      let resolveChildPid: ((pid: number) => void) | undefined;
      const childPidPromise = new Promise<number>((resolve) => {
        resolveChildPid = resolve;
      });
      const session = mgr.spawn({
        command: `& ${psQuote(process.execPath)} -e ${psQuote(nodeScript)}`,
        workdir: tmpdir(),
        onDelta: (_stream, delta) => {
          output += delta;
          const match = /ROLL_NODE_CHILD_PID=(\d+)/u.exec(output);
          if (match?.[1] !== undefined) {
            resolveChildPid?.(Number.parseInt(match[1], 10));
            resolveChildPid = undefined;
          }
        },
      });

      try {
        childPid = await withTimeout(
          childPidPromise,
          5_000,
          `未收到 Node 子进程 PID，当前输出: ${output}`,
        );
        assert.equal(isProcessAlive(childPid), true, "manager 清理前 Node 子进程应存活");

        const cleanup =
          intent === "interrupt"
            ? await mgr.interrupt(session.id)
            : await mgr.terminate(session.id);
        assert.equal(cleanup.length, 1);
        assert.equal(cleanup[0]?.state, "completed");
        assert.equal(cleanup[0]?.cleanupError, undefined);

        const result = await pollUntilDeadline(
          session,
          performance.now() + 3_000,
          POLL_OUTPUT_CHARS,
        );
        assert.equal(result.kind, "exited");
        assert.equal(result.kind === "exited" ? result.terminationCause : undefined, intent);
        // taskkill /T /F 的 Windows 退出码并不稳定；这里只验证整个进程树已消失。
        await waitFor(
          () => childPid !== undefined && !isProcessAlive(childPid),
          5_000,
          `manager ${intent} 后 Node 子进程 ${String(childPid)} 仍存活`,
        );
      } finally {
        await mgr.terminateAll();
        if (childPid !== undefined && isProcessAlive(childPid)) {
          await profile.killTree(childPid, "terminate").catch(() => {});
        }
      }
    },
  );
}

test(
  "PowerShell session tools: user-cancel abort binding 杀掉 exec_command 进程树",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const profile = powerShellProfile();
    const mgr = manager(1);
    const tools = sessionToolHarness(mgr);
    const controller = new AbortController();
    const nodeScript =
      'console.log("ROLL_TOOL_CHILD_PID=" + process.pid); setInterval(() => {}, 1_000)';
    let childPid: number | undefined;
    let session: ManagedSession | undefined;
    const pending = tools.execCommand(
      {
        command: `& ${psQuote(process.execPath)} -e ${psQuote(nodeScript)}`,
        yield_time_ms: 30_000,
      },
      controller.signal,
    );

    try {
      await waitFor(() => mgr.list().length === 1, 5_000, "exec_command 未注册 Windows session");
      const sessionId = mgr.list()[0]?.sessionId;
      assert.ok(sessionId !== undefined);
      session = mgr.get(sessionId);
      assert.ok(session);
      await waitFor(
        () =>
          /ROLL_TOOL_CHILD_PID=\d+/u.test(session?.buffer.snapshot(POLL_OUTPUT_CHARS).text ?? ""),
        5_000,
        "未收到 exec_command Node 子进程 PID",
      );
      const output = session.buffer.snapshot(POLL_OUTPUT_CHARS).text;
      const match = /ROLL_TOOL_CHILD_PID=(\d+)/u.exec(output);
      assert.ok(match?.[1]);
      childPid = Number.parseInt(match[1], 10);
      assert.equal(isProcessAlive(childPid), true);

      controller.abort(USER_CANCELLATION_ABORT_REASON);
      await assert.rejects(pending, /roll:user-cancelled/u);
      await waitFor(
        () => session !== undefined && isTerminalSessionState(session.state),
        5_000,
        "user-cancel 后 session 未收口",
      );
      assert.equal(session.terminationCause, "interrupt");
      assert.equal(session.state, "completed");
      await waitFor(
        () => childPid !== undefined && !isProcessAlive(childPid),
        5_000,
        `user-cancel 后 Node 子进程 ${String(childPid)} 仍存活`,
      );
    } finally {
      controller.abort(USER_CANCELLATION_ABORT_REASON);
      await mgr.close();
      if (childPid !== undefined && isProcessAlive(childPid)) {
        await profile.killTree(childPid, "terminate").catch(() => {});
      }
    }
  },
);

test(
  "PowerShell session tools: TURN_TIMEOUT 不杀 exec_command，exec_list + exec_poll 可恢复",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const mgr = manager(1);
    const tools = sessionToolHarness(mgr);
    const controller = new AbortController();
    const pending = tools.execCommand(
      {
        command:
          "[Console]::Out.WriteLine('before-turn-timeout'); [Console]::Out.Flush(); Start-Sleep -Seconds 3; [Console]::Out.WriteLine('after-turn-timeout')",
        yield_time_ms: 30_000,
      },
      controller.signal,
    );

    try {
      await waitFor(() => mgr.size() === 1, 5_000, "exec_command 未启动 Windows session");
      controller.abort(TURN_TIMEOUT_ABORT_REASON);
      await assert.rejects(pending, /roll:turn-timeout/u);
      assert.equal(mgr.size(), 1, "turn timeout 不应中断后台会话");

      const listed = await tools.execList();
      const payload = JSON.parse(String(listed.output)) as {
        sessions: Array<{
          session_id: number;
          state: string;
          termination_cause?: string;
        }>;
      };
      const recovered = payload.sessions[0];
      assert.ok(recovered);
      assert.equal(recovered.termination_cause, undefined);
      assert.ok(
        recovered.state === "running" || recovered.state === "completed",
        `turn timeout 后的会话状态不应为 ${recovered.state}`,
      );

      const completed = await tools.execPoll({
        session_id: recovered.session_id,
        chars: "",
        yield_time_ms: 5_000,
      });
      assert.equal(completed.isError, false);
      assert.match(String(completed.output), /Exit code: 0/u);
      assert.match(String(completed.output), /after-turn-timeout/u);
      assert.equal(mgr.get(recovered.session_id), undefined);
    } finally {
      await mgr.close();
    }
  },
);

test(
  "PowerShell session: AbortSignal.timeout 只结束当前 poll，会话可继续轮询",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const mgr = manager(1);
    const session = mgr.spawn({
      command:
        "[Console]::Out.WriteLine('buffered-before-poll-timeout'); [Console]::Out.Flush(); Start-Sleep -Seconds 30",
      workdir: tmpdir(),
    });

    try {
      const startedAt = performance.now();
      await assert.rejects(
        pollUntilDeadline(session, performance.now() + 10_000, POLL_OUTPUT_CHARS, {
          abortSignal: AbortSignal.timeout(200),
        }),
        { name: "TimeoutError" },
      );
      assert.ok(performance.now() - startedAt < 2_000, "AbortSignal.timeout 后 poll 应快速返回");
      assert.equal(mgr.get(session.id), session);
      assert.equal(mgr.size(), 1, "poll timeout 不应终止或回收 session");

      await waitFor(
        () => session.buffer.hasPending(),
        5_000,
        "poll timeout 后 PowerShell 会话应继续产生输出",
      );
      const resumed = await pollUntilDeadline(session, performance.now() + 25, POLL_OUTPUT_CHARS);
      assert.equal(resumed.kind, "running");
      assert.match(resumed.output, /buffered-before-poll-timeout/u);
    } finally {
      await mgr.terminate(session.id);
    }
  },
);

test(
  "Windows taskkill profile: root 先退出时不对旧 PID taskkill，后代清理状态保守报错",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const baseProfile = powerShellProfile();
    let killTreeCalls = 0;
    const grandchildScript = "setInterval(() => {}, 1000)";
    const parentScript = [
      'const { spawn } = require("node:child_process")',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: ["ignore", 1, 2], windowsHide: true })`,
      'console.log("ROLL_ROOT_FIRST_CHILD_PID=" + child.pid)',
      "child.unref()",
    ].join(";");
    const observedProfile: ShellProfile = {
      ...baseProfile,
      // A native command launched through PowerShell does not reliably expose the same pipe handles
      // to its descendants. Spawn the fixture directly so the grandchild definitely keeps Roll's
      // stdout/stderr pipes open after the root exits, while retaining Windows taskkill semantics.
      buildSpawn: (_command, workdir, env) => ({
        file: process.execPath,
        args: ["-e", parentScript],
        options: {
          cwd: workdir,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
          env,
          windowsHide: true,
        },
      }),
      killTree: async (pid, intent, options) => {
        killTreeCalls += 1;
        await baseProfile.killTree(pid, intent, options);
      },
    };
    const mgr = new SessionManager({
      maxSessions: 1,
      profile: observedProfile,
      env: process.env,
      bufferCapacity: POLL_OUTPUT_CHARS,
      closeDrainTimeoutMs: 100,
      rootSettleTimeoutMs: 100,
    });
    let childPid: number | undefined;
    let output = "";
    let resolveChildPid: ((pid: number) => void) | undefined;
    const childPidPromise = new Promise<number>((resolve) => {
      resolveChildPid = resolve;
    });
    const session = mgr.spawn({
      command: "node-root-first-fixture",
      workdir: tmpdir(),
      onDelta: (_stream, delta) => {
        output += delta;
        const match = /ROLL_ROOT_FIRST_CHILD_PID=(\d+)/u.exec(output);
        if (match?.[1] !== undefined) {
          resolveChildPid?.(Number.parseInt(match[1], 10));
          resolveChildPid = undefined;
        }
      },
    });

    try {
      childPid = await withTimeout(
        childPidPromise,
        5_000,
        `未收到 root-first Node 后代 PID，当前输出: ${output}`,
      );
      await withTimeout(session.waitExit(), 5_000, "Node root 未按预期先退出");
      await withTimeout(session.waitSettled(), 5_000, "root-first 会话未有界收口");

      assert.equal(killTreeCalls, 0, "root 已退出后不得对可能复用的旧 PID 调 taskkill");
      assert.equal(session.state, "cleanup-failed");
      assert.match(session.cleanupError ?? "", /旧 PID/u);
      assert.equal(isProcessAlive(childPid), true, "未跟踪的后代不能被伪报为已清理");
      assert.equal(mgr.size(), 1, "cleanup-failed 在读取前应继续占用 session 名额");
      assert.equal(mgr.delete(session.id), true);
      assert.equal(mgr.size(), 0);
    } finally {
      await mgr.terminateAll();
      if (childPid !== undefined && isProcessAlive(childPid)) {
        await baseProfile.killTree(childPid, "terminate").catch(() => {});
      }
    }
  },
);

test(
  "PowerShell session: maxSessions 拒绝第二个活会话并回收旧 terminal tombstone",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    let nextId = 41_001;
    const mgr = manager(1, () => nextId++);
    const first = mgr.spawn({ command: "Start-Sleep -Seconds 30", workdir: tmpdir() });

    try {
      assert.throws(
        () => mgr.spawn({ command: "Write-Output 'must-not-start'", workdir: tmpdir() }),
        SessionCapError,
      );
      assert.equal(mgr.size(), 1);

      await mgr.terminate(first.id);
      assert.equal(mgr.size(), 0);
      assert.equal(mgr.get(first.id), first, "最新 terminal tombstone 应暂时保留");

      const second = mgr.spawn({
        command: "Write-Output 'replacement-completed'",
        workdir: tmpdir(),
      });
      const completed = await pollUntilDeadline(
        second,
        performance.now() + 10_000,
        POLL_OUTPUT_CHARS,
      );
      assert.equal(completed.kind, "exited");
      assert.equal(completed.kind === "exited" ? completed.exitCode : -1, 0);

      await waitFor(
        () => mgr.get(first.id) === undefined,
        1_000,
        "超过 maxSessions 的旧 terminal tombstone 应被回收",
      );
      assert.equal(mgr.get(second.id), second);
      assert.equal(mgr.size(), 0, "terminal tombstone 不应占 active cap");
    } finally {
      await mgr.terminateAll();
    }
  },
);
