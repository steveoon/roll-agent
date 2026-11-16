// Manual Herdr acceptance driver: real AgentSession + production frontends/reporter.
// Start with: node ...herdr-review.e2e-harness.ts ink|basic model|permission|success|cancel <gate-dir>
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { AgentSession } from "@roll-agent/runtime";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { deadlineStatusFixture } from "./deadline-status.e2e-harness.ts";
import { runInkRepl } from "../run-ink-repl.ts";
import { runRepl } from "../../../commands/chat.ts";
import { createInteractiveTerminalAgentStatus } from "../../terminal-agent-status.ts";

const mode = process.argv[2];
const scenario = process.argv[3];
const dir = process.argv[4];
if (
  (mode !== "ink" && mode !== "basic") ||
  !dir ||
  (scenario !== "model" &&
    scenario !== "permission" &&
    scenario !== "success" &&
    scenario !== "cancel")
) {
  throw new Error(
    "expected ink|basic model|permission|success|cancel and a scratch gate directory",
  );
}
async function waitForFinish(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      if (existsSync(join(dir!, "finish"))) {
        dispose();
        resolve();
      }
    };
    const abort = (): void => {
      dispose();
      reject(signal?.reason);
    };
    const watcher = watch(dir!, finish);
    const dispose = (): void => {
      watcher.close();
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else finish();
  });
}
const deadline =
  scenario === "model" || scenario === "permission"
    ? deadlineStatusFixture(scenario === "permission", 5000)
    : undefined;
const session =
  deadline?.session ??
  new AgentSession({
    id: `herdr-review-${scenario}`,
    sources: [],
    maxSteps: 2,
    model: new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        await waitForFinish(abortSignal);
        const chunks: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Herdr review success" },
          { type: "text-end", id: "answer" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ];
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    }),
  });
const store = {
  listThreads: () => [],
  updateTitle() {},
  countMessages: () => 1,
  deleteThread() {},
};
const reporter = createInteractiveTerminalAgentStatus(true);
try {
  if (mode === "ink") {
    await runInkRepl(session, store, false, {
      model: "herdr-review-offline",
      terminalAgentStatus: reporter,
      banner: { version: "review", model: "herdr-review-offline", agentCount: 0, skillCount: 0 },
    });
  } else {
    await runRepl(session, store as unknown as Parameters<typeof runRepl>[1], false, {
      input: process.stdin,
      output: process.stdout,
      terminalAgentStatus: reporter,
    });
  }
} finally {
  reporter.dispose();
  if (deadline) {
    if (deadline.executed()) process.exitCode = 1;
    await deadline.close();
  } else await session.close();
}
