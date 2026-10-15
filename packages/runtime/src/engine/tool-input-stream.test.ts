import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import type { SessionEvent } from "../types/events.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function done(): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "done" },
    { type: "text-end", id: "t" },
    { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
  ];
}
function stream(chunks: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
  };
}

for (const mode of ["stream", "stream-no-end", "complete"] as const) {
  const withDeltas = mode !== "complete";
  test(`real SDK ${mode} approves and writes exactly once`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-tool-input-stream-"));
    const path = join(dir, "large.txt");
    const body = "PRIVATE_ARGUMENT_BODY_".repeat(4000);
    const input = JSON.stringify({ file_path: path, content: body });
    let completeSent = false;
    let requests = 0;
    let releases: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releases = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        requests += 1;
        if (requests > 1) return stream(done());
        if (!withDeltas) {
          completeSent = true;
          return stream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "write", toolName: "roll__write_file", input },
            { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
          ]);
        }
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            async start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "tool-input-start",
                id: "write",
                toolName: "roll__write_file",
              });
              for (let i = 0; i < input.length; i += 100) {
                controller.enqueue({
                  type: "tool-input-delta",
                  id: "write",
                  delta: input.slice(i, i + 100),
                });
              }
              await gate;
              if (mode !== "stream-no-end") {
                controller.enqueue({ type: "tool-input-end", id: "write" });
              }
              completeSent = true;
              controller.enqueue({
                type: "tool-call",
                toolCallId: "write",
                toolName: "roll__write_file",
                input,
              });
              controller.enqueue({
                type: "finish",
                usage,
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const persisted: ModelMessage[] = [];
    const session = new AgentSession({
      id: `write-stream-${String(withDeltas)}`,
      model,
      sources: [],
      fileTools: { workdir: dir },
      maxSteps: 2,
      policy: new DefaultToolPolicy(),
      onPersist: (messages) => persisted.push(...messages),
    });
    const events: SessionEvent[] = [];
    let approvals = 0;
    try {
      for await (const event of session.send("write the file")) {
        events.push(event);
        if (event.type === "tool-input-activity" && event.calls.length > 0) {
          assert.equal(completeSent, false);
          assert.equal(approvals, 0);
          assert.equal(session.getToolExecutions().length, 0);
          assert.equal(
            existsSync(path),
            false,
            "generation must not write even valid-looking partial JSON",
          );
          releases?.();
        }
        if (event.type === "confirmation-required") {
          approvals += 1;
          assert.equal(completeSent, true);
          assert.equal(existsSync(path), false);
          session.approve(event.approvalId);
        }
      }
      assert.equal(approvals, 1);
      assert.equal(readFileSync(path, "utf8"), body);
      assert.equal(session.getToolExecutions().length, 1);
      assert.equal(events.filter((event) => event.type === "tool-call").length, 1);
      assert.equal(events.filter((event) => event.type === "tool-result").length, 1);
      const activity = events.filter((event) => event.type === "tool-input-activity");
      assert.equal(activity.length, withDeltas ? 2 : 0);
      assert.doesNotMatch(JSON.stringify(activity), /PRIVATE_ARGUMENT_BODY|delta|inputText|tokens/);
      assert.doesNotMatch(JSON.stringify(persisted), /tool-input-activity|tool-input-delta/);
    } finally {
      releases?.();
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const boundary of ["end", "step", "error", "cancel"] as const) {
  test(`real SDK clears unfinished/interleaved activity at ${boundary} without executing incomplete calls`, async () => {
    let requests = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        requests += 1;
        if (requests > 1) return stream(done());
        const chunks: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "a", toolName: "unregistered_secret" },
          { type: "tool-input-start", id: "b", toolName: "another_secret" },
          { type: "tool-input-delta", id: "b", delta: "PRIVATE_DELTA_BODY" },
          { type: "tool-input-delta", id: "a", delta: '{"incomplete":' },
        ];
        if (boundary === "end") {
          chunks.push({ type: "tool-input-end", id: "a" }, { type: "tool-input-end", id: "b" });
        }
        if (boundary === "error") {
          chunks.push({ type: "error", error: new Error("provider failed") });
        } else {
          chunks.push({ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } });
        }
        if (boundary !== "cancel") return stream(chunks);
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              chunks.slice(0, 5).forEach((chunk) => controller.enqueue(chunk));
              options.abortSignal?.addEventListener(
                "abort",
                () => controller.error(options.abortSignal?.reason),
                { once: true },
              );
            },
          }),
        };
      },
    });
    const session = new AgentSession({
      id: `input-boundary-${boundary}`,
      model,
      sources: [],
      maxSteps: 1,
    });
    const events: SessionEvent[] = [];
    try {
      for await (const event of session.send("test incomplete")) {
        events.push(event);
        if (
          boundary === "cancel" &&
          event.type === "tool-input-activity" &&
          event.calls.length > 0
        ) {
          session.cancel();
        }
      }
      const activity = events.filter(
        (event): event is Extract<SessionEvent, { type: "tool-input-activity" }> =>
          event.type === "tool-input-activity",
      );
      assert.ok(activity.length >= 2);
      assert.deepEqual(activity.at(-1)?.calls, []);
      assert.doesNotMatch(
        JSON.stringify(activity),
        /unregistered_secret|another_secret|PRIVATE_DELTA_BODY|incomplete/,
      );
      assert.equal(
        events.filter(
          (event) =>
            event.type === "confirmation-required" ||
            event.type === "tool-call" ||
            event.type === "tool-result",
        ).length,
        0,
      );
      assert.equal(session.getToolExecutions().length, 0);
      await delay(120);
      const next: SessionEvent[] = [];
      for await (const event of session.send("next")) next.push(event);
      assert.equal(next.filter((event) => event.type === "tool-input-activity").length, 0);
      assert.ok(next.some((event) => event.type === "message-finish"));
    } finally {
      await session.close();
    }
  });
}
