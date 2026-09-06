import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { rollConfigSchema } from "@roll-agent/core/config/schema";
import { ThreadStore } from "../store/thread-store.ts";
import { scheduledThreadOriginSchema } from "../store/thread-origin.ts";
import { ConversationEngine } from "./conversation-engine.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";

const origin = scheduledThreadOriginSchema.parse({
  kind: "scheduled",
  scheduleId: "schedule-a",
  invocationId: "run-a",
  attempt: 1,
  name: "Daily review",
  cwd: "/historical-workspace",
  scheduledFor: "2026-09-05T09:00:00.000Z",
  ledgerDir: "/ledger",
});

test("engine scheduled creation honors preallocated identity, rejects resume, and forks under current config without a model turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-engine-fork-"));
  const store = new ThreadStore(dir);
  let calls = 0;
  const engine = new ConversationEngine({
    config: rollConfigSchema.parse({
      ask: {},
      llm: {
        defaultProvider: "mock",
        defaultModel: "current-model",
        providers: { mock: { apiKey: "test" } },
      },
      agents: { dataDir: join(dir, "agents") },
      runtime: { shell: { enabled: false } },
    }),
    model: new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        throw new Error("unexpected model call");
      },
    }),
    agents: [],
    sources: [],
    store,
    skillLibrary: null,
    workspaceInstructions: null,
    sessionExecEnabled: false,
    fileToolsEnabled: false,
  });
  try {
    const id = randomUUID();
    const session = await engine.createSession({ id, origin, title: "run" });
    assert.equal(session.id, id);
    assert.deepEqual(store.getThread(id)?.origin, origin);
    // Live scheduled sessions are also protected from user resume, even though the executor owns one.
    await assert.rejects(engine.resumeSession(id), /只读记录/u);
    store.appendMessages(id, [
      { role: "user", content: "Original task" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "unsettled", toolName: "long_job", input: {} }],
      },
    ]);
    const record = createToolExecutionRecord({
      id: randomUUID(),
      toolCallId: "durable-uncovered",
      agentName: "demo",
      toolName: "lookup",
      input: {},
      result: successfulToolResult("completed before interruption"),
    });
    store.appendToolExecution(id, record);
    const sourceBefore = store.readSnapshot(id);
    const fork = await engine.forkSession(sourceBefore, {
      title: "Discussion",
    });
    assert.notEqual(fork.id, id);
    assert.equal(store.getThread(fork.id)?.model, "current-model");
    assert.equal(fork.getCapabilityManifest().dynamicContext.cwd, process.cwd());
    assert.equal(store.getThread(fork.id)?.origin.kind, "interactive");
    assert.equal(calls, 0);
    assert.equal(store.listUncoveredToolExecutions(fork.id).length, 0);
    assert.equal(store.countRuntimeEvents(fork.id), 0);
    const serialized = JSON.stringify(store.getMessages(fork.id));
    assert.ok(serialized.includes("completed before interruption"));
    assert.ok(!serialized.includes('"toolCallId":"unsettled"'));
    assert.deepEqual(store.getMessages(id), sourceBefore.messages);
    assert.equal(store.listUncoveredToolExecutions(id).length, 1);
    assert.equal(await engine.resumeSession(fork.id), fork);
  } finally {
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed engine fork leaves current conversation intact and no empty derived thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-engine-fork-failure-"));
  const store = new ThreadStore(dir);
  const engine = new ConversationEngine({
    config: rollConfigSchema.parse({
      ask: {},
      llm: {
        defaultProvider: "mock",
        defaultModel: "current-model",
        providers: { mock: { apiKey: "test" } },
      },
      agents: { dataDir: join(dir, "agents") },
      runtime: { shell: { enabled: false } },
    }),
    model: new MockLanguageModelV4(),
    agents: [],
    sources: [],
    store,
    skillLibrary: null,
    workspaceInstructions: null,
  });
  try {
    const current = await engine.createSession({ title: "current" });
    const source = store.createThread({ origin });
    const snapshot = store.readSnapshot(source);
    await assert.rejects(
      engine.forkSession({
        ...snapshot,
        toolExecutionCoverage: [
          {
            executionId: randomUUID(),
            representation: "raw_transcript",
            transcriptSequence: 0,
            createdAt: snapshot.capturedAt,
          },
        ],
      }),
    );
    assert.equal(store.listThreads().length, 2);
    assert.equal(await engine.resumeSession(current.id), current);
  } finally {
    await engine.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
