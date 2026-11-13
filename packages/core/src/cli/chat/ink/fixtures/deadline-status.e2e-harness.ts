import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession, DefaultToolPolicy } from "@roll-agent/runtime";

/** Real Runtime cancellation/approval gate; no mocked send or synthetic terminal events. */
export function deadlineStatusFixture(permission: boolean, turnTimeoutMs = 120) {
  const dir = mkdtempSync(join(tmpdir(), "roll-status-deadline-"));
  const target = join(dir, "must-not-execute.txt");
  let calls = 0;
  const session = new AgentSession({
    id: `deadline-${permission ? "permission" : "model"}`,
    model: new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        // UI expiry only declines a tool. Keep inference pending until Runtime
        // actually times out, rather than completing a second synthetic tool step.
        if (!permission || ++calls > 1) {
          await new Promise<never>((_resolve, reject) => {
            if (abortSignal?.aborted) reject(abortSignal.reason);
            else {
              abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), {
                once: true,
              });
            }
          });
        }
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "tool-call",
                toolCallId: "deadline-write",
                toolName: "roll__write_file",
                input: JSON.stringify({ file_path: target, content: "must not execute" }),
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              });
              controller.close();
            },
          }),
        };
      },
    }),
    sources: [],
    ...(permission ? { fileTools: { workdir: dir } } : {}),
    policy: new DefaultToolPolicy(),
    maxSteps: 2,
    turnTimeoutMs,
  });
  return {
    session,
    executed: () => existsSync(target),
    async close() {
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
