import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession } from "./agent-session.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import type { SessionEvent } from "../types/events.ts";

test("SDK interleaved argument streams end out of order and approve/execute each complete call once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-interleaved-input-"));
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "tool-input-start", id: "a", toolName: "roll__write_file" });
          controller.enqueue({ type: "tool-input-start", id: "b", toolName: "roll__write_file" });
          controller.enqueue({ type: "tool-input-delta", id: "b", delta: "SECRET_B" });
          controller.enqueue({ type: "tool-input-delta", id: "a", delta: "SECRET_A" });
          await gate;
          controller.enqueue({ type: "tool-input-end", id: "b" });
          controller.enqueue({
            type: "tool-call",
            toolCallId: "b",
            toolName: "roll__write_file",
            input: JSON.stringify({ file_path: b, content: "body-b" }),
          });
          // Missing end for a: its complete call must clear its own generation state.
          controller.enqueue({
            type: "tool-call",
            toolCallId: "a",
            toolName: "roll__write_file",
            input: JSON.stringify({ file_path: a, content: "body-a" }),
          });
          controller.enqueue({
            type: "finish",
            usage,
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          });
          controller.close();
        },
      }),
    }),
  });
  const session = new AgentSession({
    id: "interleaved",
    model,
    sources: [],
    fileTools: { workdir: dir },
    maxSteps: 1,
    turnTimeoutMs: 5000,
    policy: new DefaultToolPolicy(),
  });
  const events: SessionEvent[] = [];
  let approvals = 0;
  try {
    for await (const event of session.send("write both files")) {
      events.push(event);
      if (event.type === "tool-input-activity" && event.calls.length === 2) {
        assert.equal(approvals, 0);
        assert.equal(session.getToolExecutions().length, 0);
        assert.equal(existsSync(a) || existsSync(b), false);
        release();
      }
      if (event.type === "confirmation-required") {
        approvals += 1;
        session.approve(event.approvalId);
      }
    }
    assert.equal(approvals, 2);
    assert.equal(readFileSync(a, "utf8"), "body-a");
    assert.equal(readFileSync(b, "utf8"), "body-b");
    assert.deepEqual(
      session
        .getToolExecutions()
        .map((record) => record.toolCallId)
        .sort(),
      ["a", "b"],
    );
    for (const id of ["a", "b"]) {
      assert.equal(
        events.filter((event) => event.type === "tool-call" && event.toolCallId === id).length,
        1,
      );
      assert.equal(
        events.filter((event) => event.type === "tool-result" && event.toolCallId === id).length,
        1,
      );
    }
    const activity = events.filter(
      (event): event is Extract<SessionEvent, { type: "tool-input-activity" }> =>
        event.type === "tool-input-activity",
    );
    assert.ok(activity.some((event) => event.calls.length === 2));
    assert.ok(
      activity.some((event) => event.calls.length === 1 && event.calls[0]?.toolCallId === "a"),
    );
    assert.deepEqual(activity.at(-1)?.calls, []);
    assert.doesNotMatch(JSON.stringify(activity), /SECRET_A|SECRET_B/);
  } finally {
    release();
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
