import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { SkillLibrary } from "@roll-agent/core/skills/library";
import { ThreadStore } from "../store/thread-store.ts";
import { AgentSession } from "./agent-session.ts";
import type { SessionEvent } from "../types/events.ts";

async function drain(session: AgentSession, prompt: string) {
  const events: SessionEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}

function model(onCall: () => void) {
  return new MockLanguageModelV4({
    doStream: async () => {
      onCall();
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

for (const failure of [
  "precompact",
  "cancel",
  "timeout",
  "skill",
  "rollback",
  "metadata",
] as const) {
  test(`accepted input survives ${failure} exactly once; subsequent send works`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-accept-session-"));
    const store = new ThreadStore(dir);
    const thread = store.createThread();
    let calls = 0;
    const demo: SkillLibrary = {
      list: () => [{ name: "demo", description: "fixture", source: "project" }],
      load: () => {
        throw new Error("Skill load failed");
      },
      loadReference: () => undefined,
    };
    const session = new AgentSession({
      id: thread,
      model: model(() => {
        calls += 1;
      }),
      sources: [],
      maxSteps: 2,
      onAcceptInput: (id, input) => store.acceptTurnInput(thread, id, input),
      onRecordInputSkillCheckpoint: (id, checkpoint) => {
        if (failure === "metadata") throw new Error("metadata storage failed");
        store.recordTurnSkillCheckpoint(thread, id, checkpoint);
      },
      onPersist: (messages, options) => store.appendMessages(thread, messages, options),
      ...(failure === "skill" ? { skillLibrary: demo } : {}),
      ...(failure === "metadata"
        ? {
            skillLibrary: {
              ...demo,
              load: () => ({
                summary: demo.list()[0]!,
                content: "PRIVATE_BODY",
                referencePaths: [],
              }),
            },
          }
        : {}),
      ...(failure === "timeout" ? { turnTimeoutMs: 10 } : {}),
    });
    // Fault injection at the pre-inference maintenance boundary, not fake provider success.
    if (failure === "precompact") {
      Object.defineProperty(session, "runAutoCompactionPasses", {
        configurable: true,
        value: async () => {
          throw new Error("precompact failed");
        },
      });
    }
    if (failure === "cancel") {
      Object.defineProperty(session, "runAutoCompactionPasses", {
        configurable: true,
        value: async () => {
          session.cancel();
          return false;
        },
      });
    }
    if (failure === "timeout") {
      Object.defineProperty(session, "runAutoCompactionPasses", {
        configurable: true,
        value: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return false;
        },
      });
    }
    if (failure === "rollback") {
      Object.defineProperty(session, "syncWorkspaceInstructions", {
        configurable: true,
        value: () => {
          throw new Error("workspace failed");
        },
      });
    }
    const prompt =
      failure === "skill" || failure === "metadata" ? "/demo saved request" : "saved request";
    try {
      const events = await drain(session, prompt);
      assert.equal(calls, 0);
      assert.ok(events.some((event) => event.type === "error" || event.type === "turn-cancelled"));
      assert.equal(store.listTurnInputs(thread).length, 1);
      assert.deepEqual(
        store
          .listTranscriptMessages(thread)
          .filter((e) => e.message.role === "user")
          .map((e) => e.message.content),
        [prompt],
      );
      assert.deepEqual(
        session
          .getMessages()
          .filter((e) => e.role === "user")
          .map((e) => e.content),
        [prompt],
      );
      if (["precompact", "cancel", "timeout"].includes(failure)) {
        Object.defineProperty(session, "runAutoCompactionPasses", { value: async () => false });
      }
      if (failure === "rollback") {
        Object.defineProperty(session, "syncWorkspaceInstructions", { value: () => {} });
      }
      await drain(session, "next request");
      assert.equal(calls, 1);
      assert.equal(store.listTurnInputs(thread).length, 2);
      assert.equal(
        store
          .listTranscriptMessages(thread)
          .filter((e) => e.message.role === "user" && e.message.content === prompt).length,
        1,
      );
    } finally {
      await session.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("legacy onPersist accepts raw input before Skill errors without claiming old Tool coverage", async () => {
  const persisted: { messages: readonly ModelMessage[]; hasCoverage: boolean }[] = [];
  let calls = 0;
  const session = new AgentSession({
    id: "legacy",
    model: model(() => {
      calls += 1;
    }),
    sources: [],
    maxSteps: 1,
    onPersist: (messages, options) =>
      persisted.push({
        messages: [...messages],
        hasCoverage: options?.toolExecutionCoverage !== undefined,
      }),
  });
  try {
    await drain(session, "/missing save this input");
    assert.equal(calls, 0);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.messages[0]?.content, "/missing save this input");
    assert.equal(persisted[0]?.hasCoverage, false);
    await drain(session, "valid input");
    assert.equal(calls, 1);
  } finally {
    await session.close();
  }
});
