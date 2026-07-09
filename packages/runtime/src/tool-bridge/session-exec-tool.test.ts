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
  buildSessionExecToolset,
  EXEC_COMMAND_ID,
  EXEC_POLL_ID,
  type ExecCommandInput,
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

function options(id: string): ToolExecutionOptions<unknown> {
  return { toolCallId: id, messages: [], context: undefined };
}

function build(ctx: BashToolContext): {
  manager: SessionManager;
  execCommand: (input: ExecCommandInput, id: string) => Promise<NormalizedToolResult>;
  execPoll: (input: ExecPollInput, id: string) => Promise<NormalizedToolResult>;
} {
  const manager = new SessionManager({
    maxSessions: 8,
    profile,
    env: process.env,
    bufferCapacity: 100_000,
  });
  const registry = new ToolRegistry();
  const toolset = buildSessionExecToolset(settings(), manager, registry, ctx);
  const cmd = toolset[EXEC_COMMAND_ID];
  const poll = toolset[EXEC_POLL_ID];
  assert.ok(cmd?.execute);
  assert.ok(poll?.execute);
  const cmdExecute = cmd.execute;
  const pollExecute = poll.execute;
  return {
    manager,
    execCommand: (input, id) =>
      Promise.resolve(cmdExecute(input, options(id)) as Promise<NormalizedToolResult>),
    execPoll: (input, id) =>
      Promise.resolve(pollExecute(input, options(id)) as Promise<NormalizedToolResult>),
  };
}

function sessionIdFrom(output: string): number {
  const match = /Session: (\d+)/.exec(output);
  assert.ok(match, `期望 running 输出含 session id，实际: ${output}`);
  return Number(match[1]);
}

test("注册为 roll__exec_command 与 roll__exec_poll", () => {
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
    manager.terminateAll();
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
  manager.terminateAll();
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
    manager.terminateAll();
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
    manager.terminateAll();
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
  manager.terminateAll();
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
  manager.terminateAll();
});

test("无 policy 时 fail-closed：确认被拒则不启动会话", { skip }, async () => {
  const { manager, execCommand } = build({
    requestApproval: async () => ({ approved: false }),
  });
  const result = await execCommand({ command: "sleep 5" }, "c1");
  assert.ok(String(result.output).includes("已取消执行"));
  assert.equal(manager.size(), 0);
  manager.terminateAll();
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
    manager.terminateAll();
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
  manager.terminateAll();
});
