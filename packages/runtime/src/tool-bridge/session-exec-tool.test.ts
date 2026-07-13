import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecutionOptions } from "ai";
import type { SessionEvent } from "../types/events.ts";
import type { PolicyDecision, ToolPolicy } from "../types/policy.ts";
import { SessionManager } from "../bash/session/session-manager.ts";
import { killProcessGroup } from "../bash/kill.ts";
import type { ShellProfile } from "../bash/profile.ts";
import { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";
import type { BashToolContext } from "./bash-tool.ts";
import {
  RUNTIME_CANCELLATION_ABORT_REASON,
  TURN_TIMEOUT_ABORT_REASON,
  USER_CANCELLATION_ABORT_REASON,
} from "../types/cancellation.ts";
import {
  buildSessionExecToolset,
  EXEC_COMMAND_ID,
  EXEC_LIST_ID,
  EXEC_POLL_ID,
  type ExecCommandInput,
  type ExecListInput,
  type ExecPollInput,
  type SessionExecSettings,
} from "./session-exec-tool.ts";

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

const allowPolicy: ToolPolicy = { check: (): PolicyDecision => ({ action: "allow" }) };
const denyPolicy: ToolPolicy = {
  check: (): PolicyDecision => ({ action: "deny", reason: "禁止" }),
};

function settings(): SessionExecSettings {
  return { workdir: process.cwd(), defaultYieldMs: 300, maxOutputTokens: 10_000 };
}

function options(id: string, abortSignal?: AbortSignal): ToolExecutionOptions<unknown> {
  return {
    toolCallId: id,
    messages: [],
    context: undefined,
    ...(abortSignal ? { abortSignal } : {}),
  };
}

function build(
  ctx: BashToolContext,
  maxSessions = 8,
): {
  manager: SessionManager;
  execCommand: (
    input: ExecCommandInput,
    id: string,
    abortSignal?: AbortSignal,
  ) => Promise<NormalizedToolResult>;
  execPoll: (
    input: ExecPollInput,
    id: string,
    abortSignal?: AbortSignal,
  ) => Promise<NormalizedToolResult>;
  execList: (input?: ExecListInput) => Promise<NormalizedToolResult>;
} {
  const manager = new SessionManager({
    maxSessions,
    profile,
    env: process.env,
    bufferCapacity: 100_000,
  });
  const registry = new ToolRegistry();
  const toolset = buildSessionExecToolset(settings(), manager, registry, ctx);
  const cmd = toolset[EXEC_COMMAND_ID];
  const poll = toolset[EXEC_POLL_ID];
  const list = toolset[EXEC_LIST_ID];
  assert.ok(cmd?.execute);
  assert.ok(poll?.execute);
  assert.ok(list?.execute);
  const cmdExecute = cmd.execute;
  const pollExecute = poll.execute;
  const listExecute = list.execute;
  return {
    manager,
    execCommand: (input, id, abortSignal) =>
      Promise.resolve(cmdExecute(input, options(id, abortSignal)) as Promise<NormalizedToolResult>),
    execPoll: (input, id, abortSignal) =>
      Promise.resolve(
        pollExecute(input, options(id, abortSignal)) as Promise<NormalizedToolResult>,
      ),
    execList: (input = {}) =>
      Promise.resolve(listExecute(input, options("list")) as Promise<NormalizedToolResult>),
  };
}

function sessionIdFrom(output: string): number {
  const match = /Session: (\d+)/.exec(output);
  assert.ok(match, `期望 running 输出含 session id，实际: ${output}`);
  return Number(match[1]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("注册为 roll__exec_command、roll__exec_poll 与 roll__exec_list", () => {
  const registry = new ToolRegistry();
  const manager = new SessionManager({
    maxSessions: 1,
    profile,
    env: process.env,
    bufferCapacity: 1_000,
  });
  buildSessionExecToolset(settings(), manager, registry, {
    requestApproval: async () => ({ approved: true }),
  });
  assert.deepEqual(registry.resolve(EXEC_COMMAND_ID), {
    agentName: "roll",
    toolName: "exec_command",
  });
  assert.deepEqual(registry.resolve(EXEC_POLL_ID), { agentName: "roll", toolName: "exec_poll" });
  assert.deepEqual(registry.resolve(EXEC_LIST_ID), { agentName: "roll", toolName: "exec_list" });
});

test("会话达上限时返回 exec_list / exec_poll 自恢复指引", { skip }, async () => {
  const { manager, execCommand } = build(
    {
      policy: allowPolicy,
      requestApproval: async () => ({ approved: true }),
    },
    1,
  );

  try {
    const first = await execCommand({ command: "sleep 30", yield_time_ms: 250 }, "cap-first");
    assert.equal(first.isError, false);

    const blocked = await execCommand(
      { command: "printf should-not-start", yield_time_ms: 250 },
      "cap-blocked",
    );
    assert.equal(blocked.isError, true);
    assert.match(String(blocked.output), /roll__exec_list/u);
    assert.match(String(blocked.output), /cleanup-failed/u);
    assert.match(String(blocked.output), /roll__exec_poll/u);
    assert.equal(manager.size(), 1);
  } finally {
    await manager.close();
  }
});

test("长跑命令首窗 running，exec_poll 续查至 exited + 退出码", { skip }, async () => {
  const { manager, execCommand, execPoll } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  try {
    const first = await execCommand(
      { command: "printf begin; sleep 0.6; printf end; exit 0", yield_time_ms: 250 },
      "c1",
    );
    assert.equal(first.isError, false);
    assert.ok(String(first.output).includes("(running)"));
    assert.ok(String(first.output).includes("begin"));
    const id = sessionIdFrom(String(first.output));
    const second = await execPoll({ session_id: id, chars: "", yield_time_ms: 5_000 }, "c2");
    assert.ok(String(second.output).includes("Exit code: 0"));
    assert.ok(String(second.output).includes("end"));
    assert.equal(manager.get(id), undefined);
  } finally {
    await manager.terminateAll();
  }
});

test("短跑命令首窗即 exited 且非零码标记 isError", { skip }, async () => {
  const { manager, execCommand } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  const result = await execCommand({ command: "exit 3", yield_time_ms: 3_000 }, "c1");
  assert.ok(String(result.output).includes("Exit code: 3"));
  assert.equal(result.isError, true);
  await manager.terminateAll();
});

test("exec_poll Ctrl-C 中断会话", { skip }, async () => {
  const { manager, execCommand, execPoll } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  try {
    const first = await execCommand({ command: "sleep 30", yield_time_ms: 250 }, "c1");
    const id = sessionIdFrom(String(first.output));
    const interrupted = await execPoll(
      { session_id: id, chars: String.fromCharCode(3), yield_time_ms: 5_000 },
      "c2",
    );
    assert.ok(String(interrupted.output).includes("Exit code"));
    assert.equal(manager.get(id), undefined);
  } finally {
    await manager.terminateAll();
  }
});

test("用户取消 signal 只中断当前 exec_command 会话", { skip }, async () => {
  const { manager, execCommand, execList } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  const controller = new AbortController();
  try {
    const pending = execCommand(
      { command: "sleep 30", yield_time_ms: 30_000 },
      "c1",
      controller.signal,
    );
    setTimeout(() => controller.abort(USER_CANCELLATION_ABORT_REASON), 100);
    await assert.rejects(pending, /roll:user-cancelled/u);
    await waitFor(() => manager.size() === 0);
    assert.equal(manager.size(), 0);
    const listed = await execList();
    assert.match(String(listed.output), /"termination_cause": "interrupt"/u);
  } finally {
    await manager.terminateAll();
  }
});

test("预先取消的 exec_command 不启动隐形后台会话", { skip }, async () => {
  for (const reason of [
    USER_CANCELLATION_ABORT_REASON,
    TURN_TIMEOUT_ABORT_REASON,
    RUNTIME_CANCELLATION_ABORT_REASON,
  ]) {
    let approvals = 0;
    const { manager, execCommand } = build({
      requestApproval: async () => {
        approvals += 1;
        return { approved: true };
      },
    });
    const controller = new AbortController();
    controller.abort(reason);

    await assert.rejects(
      execCommand({ command: "sleep 30", yield_time_ms: 30_000 }, "c1", controller.signal),
      new RegExp(reason, "u"),
    );
    assert.equal(manager.size(), 0);
    assert.deepEqual(manager.list(), []);
    assert.equal(approvals, 0);
  }
});

test("exec_command 等待确认期间取消，确认返回后仍不 spawn", { skip }, async () => {
  const approvalStarted = Promise.withResolvers<void>();
  const releaseApproval = Promise.withResolvers<void>();
  const { manager, execCommand } = build({
    requestApproval: async () => {
      approvalStarted.resolve();
      await releaseApproval.promise;
      return { approved: true };
    },
  });
  const controller = new AbortController();
  const pending = execCommand(
    { command: "sleep 30", yield_time_ms: 30_000 },
    "c1",
    controller.signal,
  );

  await approvalStarted.promise;
  controller.abort(TURN_TIMEOUT_ABORT_REASON);
  releaseApproval.resolve();

  await assert.rejects(pending, /roll:turn-timeout/u);
  assert.equal(manager.size(), 0);
  assert.deepEqual(manager.list(), []);
});

test(
  "会话管理器 close 后，迟到 exec_command 即使无 abort signal 也不 spawn",
  { skip },
  async () => {
    const { manager, execCommand } = build({
      policy: allowPolicy,
      requestApproval: async () => ({ approved: true }),
    });
    await manager.close();

    const result = await execCommand({ command: "sleep 30", yield_time_ms: 30_000 }, "late");

    assert.equal(result.isError, true);
    assert.match(String(result.output), /会话管理器已关闭/u);
    assert.equal(manager.size(), 0);
    assert.deepEqual(manager.list(), []);
  },
);

test("预先 timeout 的 exec_poll Ctrl-C 不中断后台会话", { skip }, async () => {
  const { manager, execCommand, execPoll } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  try {
    const first = await execCommand({ command: "sleep 30", yield_time_ms: 250 }, "c1");
    const id = sessionIdFrom(String(first.output));
    const controller = new AbortController();
    controller.abort(TURN_TIMEOUT_ABORT_REASON);

    await assert.rejects(
      execPoll(
        { session_id: id, chars: String.fromCharCode(3), yield_time_ms: 5_000 },
        "c2",
        controller.signal,
      ),
      /roll:turn-timeout/u,
    );
    assert.equal(manager.get(id)?.state, "running");
    assert.equal(manager.size(), 1);
  } finally {
    await manager.terminateAll();
  }
});

test("运行时 timeout signal 不误杀已后台化的 exec_command", { skip }, async () => {
  const { manager, execCommand, execList, execPoll } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  const controller = new AbortController();
  try {
    const pending = execCommand(
      { command: "sleep 2", yield_time_ms: 250 },
      "c1",
      controller.signal,
    );
    setTimeout(
      () => controller.abort(new DOMException("The operation timed out", "TimeoutError")),
      50,
    );
    await assert.rejects(pending, /timed out/u);
    const listed = await execList();
    const listPayload = JSON.parse(String(listed.output)) as {
      sessions: Array<{ session_id: number; state: string }>;
    };
    const recovered = listPayload.sessions.find((session) => session.state === "running");
    assert.ok(recovered);
    const id = recovered.session_id;
    assert.ok(manager.get(id));
    const result = await execPoll({ session_id: id, chars: "", yield_time_ms: 5_000 }, "c2");
    assert.match(String(result.output), /Exit code: 0/u);
  } finally {
    await manager.terminateAll();
  }
});

test("exec_list 可恢复 running 与未领取的 terminal 会话", { skip }, async () => {
  const { manager, execCommand, execList } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  try {
    const running = await execCommand(
      { command: "printf active; sleep 5", yield_time_ms: 250 },
      "c1",
    );
    const runningId = sessionIdFrom(String(running.output));
    const terminal = manager.spawn({ command: "printf finished", workdir: process.cwd() });
    await terminal.waitSettled();

    const listed = await execList();
    const payload = JSON.parse(String(listed.output)) as {
      sessions: Array<{ session_id: number; state: string; command: string }>;
    };
    assert.ok(
      payload.sessions.some(
        (session) => session.session_id === runningId && session.state === "running",
      ),
    );
    assert.ok(
      payload.sessions.some(
        (session) => session.session_id === terminal.id && session.state === "completed",
      ),
    );
  } finally {
    await manager.terminateAll();
  }
});

test("exec_poll 非空非哨兵 chars 报错，不写入", { skip }, async () => {
  const { manager, execCommand, execPoll } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  try {
    const first = await execCommand({ command: "sleep 5", yield_time_ms: 250 }, "c1");
    const id = sessionIdFrom(String(first.output));
    const result = await execPoll({ session_id: id, chars: "hello" }, "c2");
    assert.equal(result.isError, true);
    assert.ok(String(result.output).includes("不支持交互输入"));
  } finally {
    await manager.terminateAll();
  }
});

test("exec_poll 未知 session 返回错误", { skip }, async () => {
  const { manager, execPoll } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  const result = await execPoll({ session_id: 999_999, chars: "" }, "c1");
  assert.equal(result.isError, true);
  assert.ok(String(result.output).includes("不存在或已结束"));
  await manager.terminateAll();
});

test("policy deny 时不启动会话", { skip }, async () => {
  const { manager, execCommand } = build({
    policy: denyPolicy,
    requestApproval: async () => ({ approved: true }),
  });
  const result = await execCommand({ command: "sleep 5" }, "c1");
  assert.equal(result.isError, true);
  assert.ok(String(result.output).includes("策略拒绝执行"));
  assert.equal(manager.size(), 0);
  await manager.terminateAll();
});

test("无 policy 时 fail-closed：确认被拒则不启动会话", { skip }, async () => {
  const { manager, execCommand } = build({
    requestApproval: async () => ({ approved: false }),
  });
  const result = await execCommand({ command: "sleep 5" }, "c1");
  assert.ok(String(result.output).includes("已取消执行"));
  assert.equal(manager.size(), 0);
  await manager.terminateAll();
});

test("exec_poll 把流式 delta 重绑到自己的 toolCallId", { skip }, async () => {
  const events: SessionEvent[] = [];
  const { manager, execCommand, execPoll } = build({
    policy: allowPolicy,
    requestApproval: async () => ({ approved: true }),
    emitEvent: (event) => events.push(event),
  });
  try {
    const first = await execCommand(
      { command: "printf one; sleep 1; printf two", yield_time_ms: 250 },
      "c1",
    );
    const id = sessionIdFrom(String(first.output));
    const second = await execPoll({ session_id: id, chars: "", yield_time_ms: 5_000 }, "c2");
    assert.ok(String(second.output).includes("Exit code: 0"));
    const deltas = events.filter((event) => event.type === "tool-output-delta");
    assert.ok(
      deltas.some(
        (event) =>
          event.type === "tool-output-delta" &&
          event.toolCallId === "c1" &&
          event.toolName === "exec_command" &&
          event.delta.includes("one"),
      ),
      "首窗 delta 应挂在 exec_command 调用上",
    );
    assert.ok(
      deltas.some(
        (event) =>
          event.type === "tool-output-delta" &&
          event.toolCallId === "c2" &&
          event.toolName === "exec_poll" &&
          event.delta.includes("two"),
      ),
      "poll 窗口 delta 应重绑到 exec_poll 调用上",
    );
  } finally {
    await manager.terminateAll();
  }
});

test("P1：workdir 逃出会话根目录时 exec_command 强制 unknown 走确认", { skip }, async () => {
  const { DefaultToolPolicy } = await import("../policy/default-policy.ts");
  const { ruleBasedClassifier } = await import("../bash/classifier/index.ts");
  let confirmed = false;
  const manager = new SessionManager({
    maxSessions: 2,
    profile,
    env: process.env,
    bufferCapacity: 10_000,
  });
  const registry = new ToolRegistry();
  const toolset = buildSessionExecToolset(
    settings(),
    manager,
    registry,
    {
      policy: new DefaultToolPolicy(),
      requestApproval: async () => {
        confirmed = true;
        return { approved: false };
      },
    },
    { classifier: ruleBasedClassifier },
  );
  const cmd = toolset[EXEC_COMMAND_ID];
  assert.ok(cmd?.execute);
  const result = (await cmd.execute(
    { command: "ls", workdir: "/", chars: "" } as ExecCommandInput,
    { toolCallId: "c1", messages: [], context: undefined },
  )) as NormalizedToolResult;
  assert.equal(confirmed, true);
  assert.equal(manager.size(), 0);
  assert.equal(result.isError, true);
  await manager.terminateAll();
});
