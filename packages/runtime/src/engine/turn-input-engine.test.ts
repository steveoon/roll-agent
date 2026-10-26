import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeSettingsSchema } from "../host-contracts/runtime-settings.ts";
import type { SkillLibrary } from "../skills/contracts.ts";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { ThreadStore } from "../store/thread-store.ts";
import { ConversationEngine } from "./conversation-engine.ts";
import { AgentSession } from "./agent-session.ts";

async function drain(session: AgentSession, text: string) {
  const events = [];
  for await (const event of session.send(text)) {
    events.push(event);
  }
  return events;
}
function engine(store: ThreadStore, library: SkillLibrary | null, prompts: string[]) {
  return new ConversationEngine({
    provider: "mock",
    modelName: "fixture",
    settings: runtimeSettingsSchema.parse({}),
    store,
    sources: [],
    skillLibrary: library,
    workspaceInstructions: null,
    fileToolsEnabled: false,
    sessionExecEnabled: false,
    inspectVcsContext: async () => undefined,
    model: new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
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
    }),
  });
}

test("Engine receipt metadata survives SQLite reopen/resume/fork without replay or Skill reloading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-input-engine-"));
  let store = new ThreadStore(dir);
  let loads = 0;
  const summary = { name: "demo", description: "fixture", source: "project" as const };
  const library: SkillLibrary = {
    list: () => [summary],
    load: () => {
      loads += 1;
      return { summary, content: "ONE_TURN_PRIVATE_BODY", referencePaths: [] };
    },
    loadReference: () => undefined,
  };
  const firstPrompts: string[] = [];
  let host = engine(store, library, firstPrompts);
  try {
    const session = await host.createSession();
    const id = session.id;
    await drain(session, "/demo same text");
    await drain(session, "/demo same text");
    const original = store.listTurnInputs(id);
    assert.equal(original.length, 2);
    assert.notEqual(original[0]?.inputId, original[1]?.inputId);
    assert.equal(loads, 2);
    assert.ok(firstPrompts.every((prompt) => prompt.split("ONE_TURN_PRIVATE_BODY").length === 2));
    assert.doesNotMatch(
      JSON.stringify(original),
      /ONE_TURN_PRIVATE_BODY|userPrompt|modelUserContent/,
    );
    await host.dispose();
    store.close();
    store = new ThreadStore(dir);
    const resumedPrompts: string[] = [];
    host = engine(
      store,
      {
        ...library,
        load: () => {
          throw new Error("historical Skill must not reload");
        },
      },
      resumedPrompts,
    );
    const resumed = await host.resumeSession(id);
    const forked = await host.forkSession(store.readSnapshot(id));
    assert.equal(resumedPrompts.length, 0, "resume/fork never dispatch a saved prompt");
    const forkReceipts = store.listTurnInputs(forked.id);
    assert.equal(forkReceipts.length, 2);
    assert.ok(
      forkReceipts.every((receipt) => !original.some((old) => old.inputId === receipt.inputId)),
    );
    assert.deepEqual(
      forkReceipts.map((receipt) => receipt.skillCheckpoint),
      original.map((receipt) => receipt.skillCheckpoint),
    );
    await drain(resumed, "new goal");
    await drain(forked, "fork goal");
    assert.equal(resumedPrompts.length, 2);
    assert.ok(resumedPrompts.every((prompt) => !prompt.includes("ONE_TURN_PRIVATE_BODY")));
    assert.equal(store.listTurnInputs(id).length, 3);
    assert.equal(store.listTurnInputs(forked.id).length, 3);
    assert.equal(
      store
        .listTranscriptMessages(id)
        .filter(
          (entry) => entry.message.role === "user" && entry.message.content === "/demo same text",
        ).length,
      2,
    );
  } finally {
    await host.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plain process-local AgentSession retains failed input, with distinct explicit repeated sends", async () => {
  const session = new AgentSession({
    id: "process-local-input",
    model: new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("offline");
      },
    }),
    sources: [],
    maxSteps: 1,
  });
  try {
    await drain(session, "repeat");
    await drain(session, "repeat");
    assert.deepEqual(session.getMessages(), [
      { role: "user", content: "repeat" },
      { role: "user", content: "repeat" },
    ]);
  } finally {
    await session.close();
  }
});
