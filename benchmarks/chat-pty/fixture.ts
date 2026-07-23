import { setTimeout as delay } from "node:timers/promises";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { runInkRepl } from "../../packages/core/src/cli/chat/ink/run-ink-repl.ts";

const SCENARIOS = [
  "fixture-ink-cold-start",
  "keypress",
  "text-stream",
  "tool-stream",
  "resize-cycle",
  "resize-storm",
  "stream-resize",
  "idle",
] as const;

type Scenario = (typeof SCENARIOS)[number];

const RESIZE_HISTORY = [
  ...Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `PTY_HISTORY_${String(index).padStart(2, "0")}`,
  })),
  { role: "user", content: "PTY_USER_4F21" },
  { role: "assistant", content: "PTY_ASSIST_91C7" },
] as const;

function isScenario(value: string | undefined): value is Scenario {
  return SCENARIOS.some((scenario) => scenario === value);
}

async function* textStream(): AsyncIterable<SessionEvent> {
  const words = Array.from({ length: 400 }, (_, index) =>
    index === 399 ? "STREAM_COMPLETE_400" : `word${String(index).padStart(3, "0")}`,
  );
  yield { type: "message-start", messageId: "text-stream" };
  for (const [index, word] of words.entries()) {
    // Bounded lines keep each marker contiguous while the viewport reflows at narrow widths.
    yield { type: "text-delta", delta: `${word}${index % 4 === 3 ? "\n" : " "}` };
    await delay(4);
  }
  const text = words.join(" ");
  yield {
    type: "message-finish",
    text,
    totalUsage: { inputTokens: 8, outputTokens: words.length, totalTokens: words.length + 8 },
    outputTokensPerSecond: 250,
  };
}

async function* toolStream(): AsyncIterable<SessionEvent> {
  yield { type: "message-start", messageId: "tool-stream" };
  yield {
    type: "tool-call",
    toolCallId: "tool-call-1",
    agentName: "fixture",
    toolName: "stream_tool",
    input: { chunks: 80 },
  };
  for (let index = 0; index < 80; index += 1) {
    yield {
      type: "tool-output-delta",
      toolCallId: "tool-call-1",
      agentName: "fixture",
      toolName: "stream_tool",
      stream: "stdout",
      delta: `tool-chunk-${String(index).padStart(2, "0")}${index % 8 === 7 ? "\n" : " "}`,
    };
    // Group markers into bounded lines so every chunk remains observable even
    // when Ink coalesces several 5 ms deltas into one visible frame.
    await delay(5);
  }
  // Leave the final tail visible for at least one terminal repaint before committing the row.
  await delay(50);
  yield {
    type: "tool-result",
    toolCallId: "tool-call-1",
    agentName: "fixture",
    toolName: "stream_tool",
    outcome: { kind: "success" },
    display: "80 deterministic chunks",
    output: "80 deterministic chunks",
    isError: false,
  };
  yield { type: "text-delta", delta: "TOOL_STREAM_COMPLETE" };
  yield {
    type: "message-finish",
    text: "TOOL_STREAM_COMPLETE",
    totalUsage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
  };
}

function createFixtureSession(scenario: Scenario): AgentSession {
  let cancelled = false;
  const session = {
    id: `pty-${scenario}`,
    getMessages() {
      return scenario === "resize-cycle" ||
        scenario === "resize-storm" ||
        scenario === "stream-resize"
        ? RESIZE_HISTORY
        : [];
    },
    getContextWindow() {
      return 200_000;
    },
    getSkillSummaries() {
      return [];
    },
    async *send(): AsyncIterable<SessionEvent> {
      if (scenario === "text-stream" || scenario === "stream-resize") {
        yield* textStream();
        return;
      }
      if (scenario === "tool-stream") {
        yield* toolStream();
        return;
      }
      yield { type: "message-start", messageId: scenario };
      yield { type: "text-delta", delta: `FIXTURE_${scenario.toUpperCase()}_COMPLETE` };
      yield { type: "message-finish", text: `FIXTURE_${scenario.toUpperCase()}_COMPLETE` };
    },
    async *compact(): AsyncIterable<SessionEvent> {
      yield { type: "compaction-start", reason: "manual" };
      yield {
        type: "context-compacted",
        reason: "manual",
        strategy: "truncate",
        removed: 0,
        kept: 0,
      };
    },
    approve() {
      return true;
    },
    reject() {
      return true;
    },
    cancel() {
      cancelled = true;
      return true;
    },
    setProviderOptions() {},
    async close() {
      cancelled = true;
    },
    isCancelled() {
      return cancelled;
    },
  };
  return session as unknown as AgentSession;
}

const scenarioArg = process.argv[2];
if (!isScenario(scenarioArg)) {
  process.stderr.write(`Unknown PTY fixture scenario: ${scenarioArg ?? "<missing>"}\n`);
  process.exitCode = 2;
} else {
  const session = createFixtureSession(scenarioArg);
  const store = {
    updateTitle() {},
    countMessages() {
      return 0;
    },
    deleteThread() {},
  };

  await runInkRepl(session, store, true, {
    model: `pty-fixture/${scenarioArg}`,
    banner: {
      version: "benchmark",
      model: `pty-banner/${scenarioArg}`,
      agentCount: 1,
      skillCount: 0,
    },
    initialThinkingLevel: "off",
  });
}
