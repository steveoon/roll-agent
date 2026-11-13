// Deterministic, offline driver for the real Ink/basic REPLs. No direct OSC writes here.
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { AgentSession, SessionEvent } from "@roll-agent/runtime";
import { runInkRepl } from "../run-ink-repl.ts";
import { runRepl } from "../../../commands/chat.ts";
import { createInteractiveTerminalAgentStatus } from "../../terminal-agent-status.ts";

const mode = process.argv[2];
const dir = process.argv[3];
if ((mode !== "ink" && mode !== "basic") || !dir) {
  throw new Error("expected ink|basic and scratch gate directory");
}
async function gate(name: string): Promise<void> {
  const file = join(dir!, name);
  if (existsSync(file)) return;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dir!, () => {
      if (existsSync(file)) {
        watcher.close();
        resolve();
      }
    });
    watcher.on("error", reject);
    if (existsSync(file)) {
      watcher.close();
      resolve();
    }
  });
}
let cancelled = false;
const session = {
  id: "herdr-status-fixture",
  getMessages: () => [],
  getSkillSummaries: () => [],
  getContextWindow: () => 200_000,
  setUserInputAvailable() {},
  setProviderOptions() {},
  approve: () => true,
  reject: () => true,
  resolveUserInput: () => true,
  cancelUserInput: () => true,
  cancel() {
    cancelled = true;
    return true;
  },
  async close() {},
  async *send(input: string): AsyncIterable<SessionEvent> {
    cancelled = false;
    yield { type: "message-start", messageId: input };
    if (input === "permission") {
      yield {
        type: "confirmation-required",
        approvalId: "fixture",
        agentName: "fixture",
        toolName: "noop",
        input: {},
      };
    }
    if (input === "question") {
      type Required = Extract<SessionEvent, { type: "user-input-required" }>;
      yield {
        type: "user-input-required",
        requestId: "b92f0f10-a5f5-4fad-a243-53d39c9972bf" as Required["requestId"],
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        form: {
          title: "Fixture question",
          description: "Safe test input",
          controls: [
            { type: "text", id: "answer", label: "Answer", required: true, maxLength: 50 },
          ],
        },
      };
    }
    await gate(input);
    if (input === "failure") throw new Error("deterministic fixture failure");
    if (cancelled || input === "cancel") {
      yield { type: "turn-cancelled", reason: "user", message: "fixture cancelled after cleanup" };
    } else yield { type: "message-finish", text: "Fixture completed" };
  },
  async *compact(): AsyncIterable<SessionEvent> {
    yield { type: "compaction-start", reason: "manual" };
    await gate("compact");
    yield {
      type: "context-compacted",
      reason: "manual",
      strategy: "truncate",
      removed: 0,
      kept: 0,
    };
  },
} as unknown as AgentSession;
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
      model: "offline-status-fixture",
      terminalAgentStatus: reporter,
      banner: { version: "test", model: "offline-status-fixture", agentCount: 0, skillCount: 0 },
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
}
