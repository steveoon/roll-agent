import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession, type AgentSessionBashSession } from "./agent-session.ts";
import { ConfigurableToolPolicy } from "../policy/configurable-policy.ts";
import type { SessionEvent } from "../types/events.ts";
import { killProcessGroup } from "../bash/kill.ts";
import type { ShellProfile } from "../bash/profile.ts";

const skip = process.platform === "win32";
const MARKER = "ROLL_EXEC_E2E_MARKER";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };
const TOOL_CALLS: LanguageModelV4FinishReason = { unified: "tool-calls", raw: "tool-calls" };

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

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function sequencedModel(steps: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function toolCallStep(toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
    { type: "finish", usage: usage(), finishReason: TOOL_CALLS },
  ];
}

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: usage(), finishReason: STOP },
  ];
}

function bashSession(): AgentSessionBashSession {
  return {
    workdir: process.cwd(),
    profile,
    maxSessions: 4,
    defaultYieldMs: 250,
    maxOutputTokens: 1_000,
    bufferCapacity: 100_000,
  };
}

function markerProcessCount(): number {
  try {
    const out = execSync("pgrep -f '[s]leep 37; : ROLL_EXEC_E2E_MARKER' || true", {
      encoding: "utf-8",
    }).trim();
    return out.length === 0 ? 0 : out.split("\n").length;
  } catch {
    return 0;
  }
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

test(
  "exec_command 长跑首窗返回 running，进程跨 turn 存活，abort() 清理进程组",
  { skip },
  async () => {
    const command = `sleep 37; : ${MARKER}`;
    const model = sequencedModel([
      toolCallStep("roll__exec_command", { command, yield_time_ms: 250 }),
      textStep("已启动后台任务"),
    ]);
    const session = new AgentSession({
      id: "e2e-exec",
      model,
      sources: [],
      maxSteps: 6,
      bashSession: bashSession(),
      policy: new ConfigurableToolPolicy({
        defaultMode: "auto",
        overrides: { "roll.exec_command": "auto" },
      }),
    });

    try {
      const events = await collect(session.send("跑一个后台长命令"));
      const toolResult = events.find((event) => event.type === "tool-result");
      assert.ok(toolResult && toolResult.type === "tool-result", "应有 tool-result");
      const output = JSON.stringify(toolResult.output);
      assert.ok(output.includes("(running)"), `应返回 running，实际: ${output}`);
      assert.ok(output.includes("Session:"), "running 输出应含 session id");

      // turn 已结束，但后台进程不应被 turn 生命周期杀掉
      assert.equal(markerProcessCount(), 1, "后台进程应跨 turn 存活");
    } finally {
      session.abort();
      await delay(600);
    }

    // abort() → sessionManager.terminateAll() → 进程组被清理
    assert.equal(markerProcessCount(), 0, "abort 后不应残留进程");
  },
);

test("cancel() 在两次 poll 之间也会中断后台进程", { skip }, async () => {
  const command = `sleep 37; : ${MARKER}`;
  const model = sequencedModel([
    toolCallStep("roll__exec_command", { command, yield_time_ms: 250 }),
    textStep("准备稍后继续轮询"),
  ]);
  const session = new AgentSession({
    id: "e2e-exec-cancel",
    model,
    sources: [],
    maxSteps: 6,
    bashSession: bashSession(),
    policy: new ConfigurableToolPolicy({
      defaultMode: "auto",
      overrides: { "roll.exec_command": "auto" },
    }),
  });

  const events: SessionEvent[] = [];
  try {
    for await (const event of session.send("启动后台任务后继续思考")) {
      events.push(event);
      if (event.type === "step-finish" && event.finishReason === "tool-calls") {
        assert.equal(markerProcessCount(), 1, "取消前后台进程应仍在运行");
        assert.equal(session.cancel(), true);
      }
    }
    await delay(600);
    assert.ok(events.some((event) => event.type === "turn-cancelled"));
    assert.equal(markerProcessCount(), 0, "cancel 后不应残留后台进程");
  } finally {
    session.abort();
    await delay(200);
  }
});
