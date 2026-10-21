import assert from "node:assert/strict";
import test from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";
import type { SessionEvent } from "../types/events.ts";
import type { ShellProfile } from "../bash/profile.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

test(
  "same-turn recovery polls the original real background process instead of spawning again",
  { timeout: 15000 },
  async () => {
    let spawned = 0;
    const profile: ShellProfile = {
      id: "posix",
      toolName: "bash",
      supportsSessionExec: true,
      supportsSafeCommandClassification: false,
      buildSpawn: (_command, workdir, env) => {
        spawned++;
        return {
          file: process.execPath,
          args: ["-e", "setTimeout(() => console.log('background-finished-once'), 1800)"],
          options: { cwd: workdir, detached: false, stdio: ["ignore", "pipe", "pipe"], env },
        };
      },
      classify: () => "unknown",
      killTree: async (pid) => {
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
      },
      systemPromptHints: () => [],
    };
    const offline = new Error("typed-offline");
    let step = 0;
    let sessionId: number | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        step++;
        const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
        if (step === 2) chunks.push({ type: "error", error: offline });
        else if (step === 1 || step === 3) {
          if (step === 3) assert.ok(sessionId);
          chunks.push({
            type: "tool-call",
            toolCallId: `call-${step}`,
            toolName: step === 1 ? "roll__exec_command" : "roll__exec_poll",
            input: JSON.stringify(
              step === 1
                ? {
                    command: "portable-background-fixture",
                    yield_time_ms: 250,
                    explanation: "运行一个会自动结束的测试进程以核验恢复不会重复启动。",
                  }
                : { session_id: sessionId, chars: "", yield_time_ms: 5000 },
            ),
          });
          chunks.push({
            type: "finish",
            usage,
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          });
        } else {
          chunks.push(
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
            { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
          );
        }
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const session = new AgentSession({
      id: "recovery-exec",
      model,
      sources: [],
      policy: { check: () => ({ action: "allow" }) },
      maxSteps: 5,
      modelRecovery: { isRecoverable: (error) => error === offline, prepare: async () => {} },
      bashSession: {
        workdir: process.cwd(),
        profile,
        maxSessions: 2,
        defaultYieldMs: 250,
        maxOutputTokens: 1000,
        bufferCapacity: 10000,
      },
    });
    try {
      const events: SessionEvent[] = [];
      for await (const event of session.send("run once and wait for result")) {
        events.push(event);
        if (event.type === "tool-result" && event.toolName === "exec_command") {
          const match = /Session: (\d+) \(running\)/u.exec(JSON.stringify(event.output));
          assert.ok(match?.[1], JSON.stringify(event));
          sessionId = Number(match[1]);
        }
      }
      assert.equal(spawned, 1);
      assert.equal(model.doStreamCalls.length, 4);
      assert.equal(
        events.some((event) => event.type === "error"),
        false,
        JSON.stringify(events),
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === "tool-result" &&
            event.toolName === "exec_poll" &&
            JSON.stringify(event.output).includes("background-finished-once"),
        ),
      );
      assert.equal(session.getToolExecutions().length, 2);
      assert.equal(events.at(-1)?.type, "message-finish");
    } finally {
      await session.close();
    }
  },
);
