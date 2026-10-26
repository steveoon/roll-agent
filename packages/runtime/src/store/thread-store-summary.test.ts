import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { runtimeSettingsSchema } from "../host-contracts/runtime-settings.ts";
import { threadIdSchema } from "@roll-agent/protocol";
import { ThreadStore } from "./thread-store.ts";
import { SemanticLedger } from "./semantic-ledger.ts";
import { ConversationEngine } from "../engine/conversation-engine.ts";
import { RuntimeService } from "../service/runtime-service.ts";
import { createLegacyCompactionTranscriptMessage } from "../engine/compactor.ts";
import { executeTranscriptTool } from "../tool-bridge/transcript-tool.ts";
import {
  createCompactionCheckpoint,
  createEmptyCompactionToolState,
  createSummaryCheckpoint,
  parseCompactionCheckpoint,
  buildCompactionCheckpointReminder,
  MAX_TASK_SUMMARY_CHARS,
  type CompactionCheckpoint,
} from "../engine/compaction-checkpoint.ts";
import {
  createEmptyCompactionSemanticState,
  replaceCompactionSemanticConstraints,
  listSemanticArchiveItems,
} from "../engine/compaction-semantic-state.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "roll-summary-store-"));
  const store = new ThreadStore(dir);
  const threadId = store.createThread();
  store.appendMessages(threadId, [
    { role: "user", content: "Keep hidden marker archived-73fuchsia" },
    { role: "assistant", content: "Earlier work completed" },
  ]);
  const database = new DatabaseSync(join(dir, "threads.db"));
  return {
    dir,
    store,
    threadId,
    database,
    close: () => {
      database.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedLegacy(f: ReturnType<typeof fixture>, version: 1 | 2 = 2): CompactionCheckpoint {
  const checkpoint = createCompactionCheckpoint({
    generation: 1,
    draft: {
      constraints: [],
      resources: [],
      toolState: createEmptyCompactionToolState(),
      runningWork: [],
      context: { cwd: "/workspace", stableRuleIds: [], skills: [], explicitSkillNames: [] },
      summary: { status: "skipped" },
    },
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 1 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
  });
  const { semanticState: _state, semanticEvidence: _evidence, ...v1 } = checkpoint;
  const legacy = version === 1 ? parseCompactionCheckpoint({ ...v1, version: 1 }) : checkpoint;
  f.database
    .prepare(
      `INSERT INTO compaction_checkpoints
    (id,thread_id,generation,schema_version,message_from_sequence,message_through_sequence,
     tool_from_sequence,tool_through_sequence,checkpoint_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      legacy.id,
      f.threadId,
      1,
      version,
      -1,
      1,
      -1,
      -1,
      JSON.stringify(legacy),
      legacy.createdAt,
    );
  return legacy;
}

function seedLegacyRecovery(f: ReturnType<typeof fixture>, checkpointId: string): void {
  f.database
    .prepare(
      "INSERT INTO compaction_recovery(thread_id,checkpoint_id,required,unextracted,memo) VALUES(?,?,1,1,'')",
    )
    .run(f.threadId, checkpointId);
}

function commit(f: ReturnType<typeof fixture>, summary = "Task summary") {
  return f.store.commitCompaction(f.threadId, {
    messages: [{ role: "user", content: "continue" }],
    expectedActiveMessages: f.store.getMessages(f.threadId),
    expectedLatestCheckpointId: f.store.getLatestCheckpoint(f.threadId)?.id,
    summary,
  });
}

test("an active-only legacy summary is archived once when eventually removed, including after V3", () => {
  const f = fixture();
  try {
    seedLegacy(f, 1);
    const fragment = createLegacyCompactionTranscriptMessage(
      "unique-old-summary password=fixture-secret",
    );
    const active: ModelMessage[] = [fragment, { role: "user", content: "recent request" }];
    // Older versions kept derived summaries only in the active message table.
    f.store.replaceMessages(f.threadId, active);
    const first = f.store.commitCompaction(f.threadId, {
      messages: [fragment],
      expectedActiveMessages: active,
      expectedLatestCheckpointId: f.store.getLatestCheckpoint(f.threadId)?.id,
      summary: "Keep the previous summary in the recent tail",
    });
    assert.equal(f.store.countTranscriptMessages(f.threadId), 2);
    f.database.exec(
      "CREATE TRIGGER fail_projection BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'projection failure'); END",
    );
    assert.throws(() => commit(f), /projection failure/);
    assert.equal(f.store.getLatestCheckpoint(f.threadId)?.id, first.id);
    assert.equal(f.store.countTranscriptMessages(f.threadId), 2);
    assert.deepEqual(f.store.getMessages(f.threadId), [fragment]);
    f.database.exec("DROP TRIGGER fail_projection");
    const second = commit(f);
    const archived = f.store.readCheckpointTranscript(f.threadId, {
      checkpointId: second.id,
      kind: "message",
    });
    assert.equal(archived.entries.length, 1);
    assert.match(JSON.stringify(archived), /unique-old-summary/);
    assert.doesNotMatch(JSON.stringify(archived), /fixture-secret/);
    assert.equal(
      archived.entries[0]?.kind === "message" && archived.entries[0].provenance,
      "legacy_snapshot",
    );
    f.store.replaceMessages(f.threadId, [fragment]);
    commit(f);
    assert.equal(f.store.countTranscriptMessages(f.threadId), 3);
  } finally {
    f.close();
  }
});

test("large legacy ledger pages pin their generation and retain metadata across conversion and fork", () => {
  const f = fixture();
  try {
    const legacy = seedLegacy(f);
    seedLegacyRecovery(f, legacy.id);
    f.database
      .prepare("UPDATE compaction_recovery SET required=0, memo=? WHERE thread_id=?")
      .run("historical memo password=memo-secret", f.threadId);
    f.database
      .prepare("INSERT INTO compaction_recovery_notes VALUES (?,?,?)")
      .run(f.threadId, legacy.id, "historical note token=note-secret");
    const items = Array.from({ length: 400 }, (_, index) =>
      listSemanticArchiveItems(
        replaceCompactionSemanticConstraints(createEmptyCompactionSemanticState(), [
          { quote: `legacy-${index}: ` + "evidence ".repeat(50), sourceSequence: 0 },
        ]),
      ),
    ).flat();
    assert.ok(JSON.stringify(items).length > 256_000);
    const ledger = new SemanticLedger(f.database);
    ledger.append(f.threadId, 1, "legacy", -1, items);
    const originalPage = f.store.readCheckpointTranscript(f.threadId, {
      checkpointId: legacy.id,
      kind: "legacy_context",
      limit: 7,
    });
    const first = items[0];
    assert.ok(first?.category === "constraint");
    ledger.append(f.threadId, 2, "legacy", -1, [
      { ...first, item: { ...first.item, text: "future version must not leak" } },
    ]);
    assert.deepEqual(
      f.store.readCheckpointTranscript(f.threadId, {
        checkpointId: legacy.id,
        kind: "legacy_context",
        limit: 7,
      }),
      originalPage,
    );
    const seen = new Set<number>();
    let afterSequence = -1;
    do {
      const page = f.store.readCheckpointTranscript(f.threadId, {
        checkpointId: legacy.id,
        kind: "legacy_context",
        limit: 7,
        afterSequence,
      });
      assert.ok(page.entries.length <= 7);
      assert.doesNotMatch(JSON.stringify(page), /future version must not leak/);
      for (const entry of page.entries) {
        assert.ok(!seen.has(entry.sequence));
        seen.add(entry.sequence);
      }
      if (page.nextAfterSequence === undefined) break;
      assert.ok(page.nextAfterSequence > afterSequence);
      afterSequence = page.nextAfterSequence;
    } while (seen.size <= 401);
    assert.equal(seen.size, 401);
    const converted = commit(f);
    assert.equal(converted.previousCheckpointId, legacy.id);
    assert.equal(f.store.countTranscriptMessages(f.threadId), 2);
    const fork = f.store.forkSnapshot(f.store.readSnapshot(f.threadId));
    const forkLegacy = f.store.getLatestCheckpoint(fork)?.previousCheckpointId;
    assert.ok(forkLegacy && forkLegacy !== legacy.id);
    const raw = f.store.readCheckpointTranscript(fork, {
      checkpointId: forkLegacy,
      kind: "legacy_context",
      limit: 1,
    });
    assert.match(JSON.stringify(raw), /historical memo/);
    assert.match(JSON.stringify(raw), /historical note/);
    assert.equal(f.store.getContextRecovery(fork), undefined);
    let text = "";
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const chunk = executeTranscriptTool(
        (input) => f.store.readCheckpointTranscript(fork, input),
        {
          checkpointId: forkLegacy,
          kind: "legacy_context",
          sequence: 0,
          offset,
          maxChars: 91,
        },
      );
      assert.equal(chunk.outcome.kind, "success");
      assert.ok(
        typeof chunk.raw === "object" &&
          chunk.raw !== null &&
          "text" in chunk.raw &&
          typeof chunk.raw.text === "string",
      );
      text += chunk.raw.text;
      if (!("nextOffset" in chunk.raw)) break;
      assert.ok(typeof chunk.raw.nextOffset === "number" && chunk.raw.nextOffset > offset);
      offset = chunk.raw.nextOffset;
    }
    assert.match(text, /historical memo/);
    assert.match(text, /historical note/);
    assert.doesNotMatch(text, /memo-secret|note-secret/);
    assert.throws(
      () =>
        f.store.readCheckpointTranscript(fork, { checkpointId: legacy.id, kind: "legacy_context" }),
      /不属于/,
    );
  } finally {
    f.close();
  }
});

for (const version of [1, 2] as const) {
  test(`V${version} opens through Engine and Runtime, compacts normally, restarts and forks despite missing sources`, async () => {
    const f = fixture();
    let engine: ConversationEngine | undefined;
    let service: RuntimeService | undefined;
    let reopened: ThreadStore | undefined;
    try {
      const legacy = seedLegacy(f, version);
      seedLegacyRecovery(f, legacy.id);
      f.database
        .prepare("UPDATE compaction_recovery SET required=0 WHERE thread_id=?")
        .run(f.threadId);
      f.database
        .prepare("DELETE FROM transcript_messages WHERE thread_id=? AND sequence=0")
        .run(f.threadId);
      f.database
        .prepare(
          "UPDATE thread_transcript_state SET completeness='legacy_snapshot' WHERE thread_id=?",
        )
        .run(f.threadId);
      f.store.appendMessages(f.threadId, [
        { role: "assistant", content: "previous large evidence ".repeat(2000) },
        { role: "user", content: "Only fix the parser; already authorized" },
      ]);
      const initial = f.store.getMessages(f.threadId);
      let failSummary = true;
      const usage = {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      };
      const model = new MockLanguageModelV4({
        doGenerate: async (params) => {
          assert.match(JSON.stringify(params.prompt), /Only fix the parser; already authorized/);
          assert.doesNotMatch(JSON.stringify(params.tools ?? []), /roll__context/);
          if (failSummary) throw new Error("fixture summary unavailable");
          return {
            content: [{ type: "text", text: "Continue the parser fix" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        },
        doStream: async (params) => {
          assert.match(JSON.stringify(params.prompt), /Only fix the parser; already authorized/);
          assert.doesNotMatch(JSON.stringify(params.tools), /roll__context/);
          return {
            stream: simulateReadableStream({
              initialDelayInMs: null,
              chunkDelayInMs: null,
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "text" },
                { type: "text-delta", id: "text", delta: "Continuing parser fix" },
                { type: "text-end", id: "text" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ],
            }),
          };
        },
      });
      const config = runtimeSettingsSchema.parse({
        shell: { enabled: false },
        contextWindow: 200_000,
        compaction: { keepRecentTurns: 1, keepRecentTokens: 1, maxOutputTokens: 2048 },
      });
      const makeEngine = (store: ThreadStore) =>
        new ConversationEngine({
          provider: "mock",
          modelName: "test",
          settings: config,
          model,
          store,
          sources: [],
          skillLibrary: null,
          workspaceInstructions: null,
          fileToolsEnabled: false,
          inspectVcsContext: () => undefined,
        });
      engine = makeEngine(f.store);
      service = new RuntimeService(engine, f.store);
      assert.equal(
        (await service.openThread({ threadId: threadIdSchema.parse(f.threadId) })).contextRecovery,
        null,
      );
      let session = await engine.resumeSession(f.threadId);
      assert.equal(model.doGenerateCalls.length, 0);
      assert.equal(model.doStreamCalls.length, 0);
      assert.ok(
        buildCompactionCheckpointReminder(legacy, undefined, "roll__transcript").length <= 8000,
      );
      for await (const event of session.compact()) {
        assert.ok(event.type !== "context-compacted" || event.removed === 0);
      }
      assert.equal(model.doGenerateCalls.length, 1);
      assert.deepEqual(f.store.getMessages(f.threadId), initial);
      assert.equal(f.store.getLatestCheckpoint(f.threadId)?.id, legacy.id);
      failSummary = false;
      const events = [];
      for await (const event of session.compact()) events.push(event);
      assert.ok(
        events.some((event) => event.type === "context-compacted" && event.removed > 0),
        JSON.stringify(events),
      );
      assert.equal(model.doGenerateCalls.length, 2);
      const converted = f.store.getLatestCheckpoint(f.threadId);
      assert.equal(converted?.version, 3);
      assert.equal(converted.previousCheckpointId, legacy.id);
      assert.deepEqual(f.store.getMessages(f.threadId), initial.slice(-1));
      await service.close();
      service = undefined;
      await engine.dispose();
      engine = undefined;
      reopened = new ThreadStore(f.dir);
      engine = makeEngine(reopened);
      session = await engine.resumeSession(f.threadId);
      const continuation = [];
      for await (const event of session.send("Continue")) continuation.push(event);
      assert.ok(continuation.some((event) => event.type === "message-finish"));
      assert.ok(continuation.every((event) => event.type !== "error"));
      const fork = await engine.forkSession(reopened.readSnapshot(f.threadId));
      assert.ok(fork.getCapabilityManifest().tools.some((tool) => tool.id === "roll__transcript"));
      const forkCheckpoint = reopened.getLatestCheckpoint(fork.id);
      assert.ok(
        forkCheckpoint?.previousCheckpointId && forkCheckpoint.previousCheckpointId !== legacy.id,
      );
      assert.equal(
        reopened.readCheckpointTranscript(fork.id, {
          checkpointId: forkCheckpoint.previousCheckpointId,
          kind: "legacy_context",
          limit: 1,
        }).entries.length,
        1,
      );
    } finally {
      await service?.close();
      await engine?.dispose();
      reopened?.close();
      f.close();
    }
  });
}

test("V3 schema stores bounded plain task summary and renders it as historical context", () => {
  const checkpoint = createSummaryCheckpoint({
    summary: "Fix parser; next run exact failed test",
    generation: 1,
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 4 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: -1 },
      completeness: "complete",
    },
  });
  assert.deepEqual(parseCompactionCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint);
  assert.equal(checkpoint.version, 3);
  assert.equal("semanticState" in checkpoint, false);
  assert.match(
    buildCompactionCheckpointReminder(checkpoint, undefined, "roll__transcript"),
    /Fix parser/,
  );
  assert.throws(() =>
    createSummaryCheckpoint({
      generation: checkpoint.generation,
      transcript: checkpoint.transcript,
      summary: "x".repeat(MAX_TASK_SUMMARY_CHARS + 1),
    }),
  );
});

for (const version of [7, 8, 9, 10]) {
  test(`schema v${String(version)} opens V1/V2 checkpoints, migrates forward, restarts and forks`, () => {
    const f = fixture();
    try {
      const legacy = seedLegacy(f, version % 2 === 0 ? 2 : 1);
      // Match the pre-ledger layouts, rather than only changing user_version on a V11 DB.
      if (version < 9) {
        f.database.exec(`DROP TABLE compaction_semantic_items;
          DROP TABLE compaction_recovery; DROP TABLE compaction_recovery_reads;
          DROP TABLE compaction_recovery_notes;`);
      }
      if (version < 8) f.database.exec("DROP TABLE thread_turn_inputs");
      f.database.exec(`PRAGMA user_version = ${String(version)}`);
      const reopened = new ThreadStore(f.dir);
      assert.equal(f.database.prepare("PRAGMA user_version").get()?.user_version, 11);
      assert.equal(reopened.loadSessionState(f.threadId).checkpoint?.id, legacy.id);
      const forkId = reopened.forkSnapshot(reopened.readSnapshot(f.threadId));
      assert.equal(reopened.getLatestCheckpoint(forkId)?.version, version % 2 === 0 ? 2 : 1);
      const checkpoint = reopened.commitCompaction(f.threadId, {
        messages: [{ role: "user", content: "continue" }],
        expectedActiveMessages: reopened.getMessages(f.threadId),
        expectedLatestCheckpointId: reopened.getLatestCheckpoint(f.threadId)?.id,
        summary: "Converted legacy context",
      });
      assert.equal(checkpoint.version, 3);
      assert.equal(checkpoint.previousCheckpointId, legacy.id);
      const v3ForkId = reopened.forkSnapshot(reopened.readSnapshot(f.threadId));
      assert.equal(reopened.getLatestCheckpoint(v3ForkId)?.version, 3);
      assert.equal(reopened.listTranscriptMessages(v3ForkId).length, 2);
      reopened.close();
      const restart = new ThreadStore(f.dir);
      assert.equal(restart.getLatestCheckpoint(f.threadId)?.id, checkpoint.id);
      restart.close();
    } finally {
      f.close();
    }
  });
}

test("legacy pending recovery facts and originals remain independently readable before and after conversion", () => {
  const f = fixture();
  try {
    const checkpoint = seedLegacy(f);
    const ledger = new SemanticLedger(f.database);
    const facts = replaceCompactionSemanticConstraints(createEmptyCompactionSemanticState(), [
      { quote: "Do not change hidden-module", sourceSequence: 0 },
    ]);
    ledger.append(f.threadId, 1, "legacy", -1, listSemanticArchiveItems(facts));
    seedLegacyRecovery(f, checkpoint.id);
    const read = (threadId: string, checkpointId: string) =>
      JSON.stringify(
        f.store.readCheckpointTranscript(threadId, { checkpointId, kind: "legacy_context" }),
      );
    assert.match(read(f.threadId, checkpoint.id), /Do not change hidden-module/);
    assert.match(
      JSON.stringify(
        f.store.readCheckpointTranscript(f.threadId, {
          checkpointId: checkpoint.id,
          kind: "message",
        }),
      ),
      /archived-73fuchsia/,
    );
    const fork = f.store.forkSnapshot(f.store.readSnapshot(f.threadId));
    assert.equal(f.store.getContextRecovery(fork)?.required, true);
    const forkCheckpoint = f.store.getLatestCheckpoint(fork);
    assert.ok(forkCheckpoint);
    assert.match(read(fork, forkCheckpoint.id), /Do not change hidden-module/);
    const beforeFacts = ledger.versions(f.threadId);
    commit(f);
    assert.equal(f.store.getContextRecovery(f.threadId), undefined);
    assert.deepEqual(ledger.versions(f.threadId), beforeFacts);
    assert.equal(f.store.listTranscriptMessages(f.threadId).length, 2);
    assert.match(read(f.threadId, checkpoint.id), /Do not change hidden-module/);
  } finally {
    f.close();
  }
});

for (const required of [0, 1]) {
  test(`missing legacy source allows conversion with required=${String(required)} and reports unavailable only on read`, () => {
    const f = fixture();
    try {
      const checkpoint = seedLegacy(f);
      seedLegacyRecovery(f, checkpoint.id);
      f.database
        .prepare("UPDATE compaction_recovery SET required=? WHERE thread_id=?")
        .run(required, f.threadId);
      f.database
        .prepare("DELETE FROM transcript_messages WHERE thread_id=? AND sequence=0")
        .run(f.threadId);
      f.database
        .prepare(
          "UPDATE thread_transcript_state SET completeness='legacy_snapshot' WHERE thread_id=?",
        )
        .run(f.threadId);
      assert.equal(f.store.loadSessionState(f.threadId).checkpoint?.id, checkpoint.id);
      const converted = commit(f);
      assert.equal(converted.version, 3);
      assert.equal(converted.previousCheckpointId, checkpoint.id);
      assert.equal(converted.transcript.completeness, "legacy_snapshot");
      const missing = executeTranscriptTool(
        (input) => f.store.readCheckpointTranscript(f.threadId, input),
        {
          checkpointId: checkpoint.id,
          kind: "message",
          sequence: 0,
        },
      );
      assert.equal(missing.outcome.kind, "invalid_input");
      assert.equal(f.store.countTranscriptMessages(f.threadId), 1);
      assert.equal(f.store.getContextRecovery(f.threadId), undefined);
    } finally {
      f.close();
    }
  });
}

test("failed V3 active projection write rolls back checkpoint and legacy history atomically", () => {
  const f = fixture();
  try {
    const checkpoint = seedLegacy(f);
    seedLegacyRecovery(f, checkpoint.id);
    const transcript = f.store.listTranscriptMessages(f.threadId);
    const active = f.store.getMessages(f.threadId);
    f.database.exec(
      "CREATE TRIGGER fail_projection BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'projection failure'); END",
    );
    assert.throws(() => commit(f), /projection failure/);
    assert.deepEqual(f.store.getMessages(f.threadId), active);
    assert.deepEqual(f.store.listTranscriptMessages(f.threadId), transcript);
    assert.equal(f.store.getLatestCheckpoint(f.threadId)?.id, checkpoint.id);
    assert.equal(f.store.getContextRecovery(f.threadId)?.required, true);
  } finally {
    f.close();
  }
});

test("oversized legacy original stays chunk-readable without blocking conversion", () => {
  const f = fixture();
  try {
    const checkpoint = seedLegacy(f);
    assert.ok(checkpoint.version === 2);
    seedLegacyRecovery(f, checkpoint.id);
    f.database
      .prepare("UPDATE transcript_messages SET message_json=? WHERE thread_id=? AND sequence=0")
      .run(
        JSON.stringify({ role: "user", content: "evidence ".repeat(40_000) + "TAIL_MARKER" }),
        f.threadId,
      );
    assert.equal(commit(f).version, 3);
    const tail = executeTranscriptTool(
      (input) => f.store.readCheckpointTranscript(f.threadId, input),
      {
        checkpointId: checkpoint.id,
        kind: "message",
        sequence: 0,
        offset: 359_900,
      },
    );
    assert.equal(tail.outcome.kind, "success");
    assert.match(JSON.stringify(tail.raw), /TAIL_MARKER/);
    assert.equal(f.store.countTranscriptMessages(f.threadId), 2);
  } finally {
    f.close();
  }
});

test("V3 reminder includes bounded Harness counts without copying long failed-tool reasons", () => {
  const checkpoint = createSummaryCheckpoint({
    summary: "Keep investigating the failure",
    generation: 1,
    transcript: {
      messages: { fromSequenceExclusive: -1, throughSequence: 8 },
      toolExecutions: { fromSequenceExclusive: -1, throughSequence: 7 },
      completeness: "complete",
    },
    toolState: {
      ...createEmptyCompactionToolState(),
      countsByOutcome: { ...createEmptyCompactionToolState().countsByOutcome, tool_failed: 8 },
      recentRecords: Array.from({ length: 8 }, (_, sequence) => ({
        executionId: "2410ef09-e409-4209-a33e-8baeee665e4a",
        sequence,
        toolCallId: `call-${String(sequence)}`,
        agentName: "demo",
        toolName: "lookup",
        outcome: { kind: "tool_failed" as const, reason: `REASON_DETAIL_${"x".repeat(8000)}` },
      })),
    },
  });
  const reminder = buildCompactionCheckpointReminder(checkpoint, undefined, "roll__transcript");
  assert.ok(reminder.length < checkpoint.taskSummary.length + 1500);
  assert.doesNotMatch(reminder, /REASON_DETAIL/);
  assert.match(reminder, /"tool_failed":8/);
  assert.equal(checkpoint.toolState.recentRecords.length, 8);
});

test("commit validates the final exact checkpoint at a transcript digit boundary and atomically rejects no progress", () => {
  const f = fixture();
  try {
    f.store.appendMessages(
      f.threadId,
      Array.from({ length: 999 }, () => ({ role: "user" as const, content: "archive" })),
    );
    const previous = commit(f, "first summary");
    assert.equal(previous.transcript.messages.throughSequence, 1000);
    const activeBefore = f.store.getMessages(f.threadId);
    const transcriptBefore = f.store.listTranscriptMessages(f.threadId, { limit: 500 });
    let validationCalls = 0;
    assert.throws(
      () =>
        f.store.commitCompaction(f.threadId, {
          messages: [{ role: "user", content: "candidate" }],
          expectedActiveMessages: activeBefore,
          expectedLatestCheckpointId: previous.id,
          summary: "would not shrink final projection",
          validateCheckpoint(checkpoint) {
            validationCalls += 1;
            assert.equal(checkpoint.transcript.messages.fromSequenceExclusive, 1000);
            assert.equal(checkpoint.generation, previous.generation + 1);
            throw new Error("final request did not shrink");
          },
        }),
      /final request did not shrink/,
    );
    assert.equal(validationCalls, 1);
    assert.deepEqual(f.store.getMessages(f.threadId), activeBefore);
    assert.deepEqual(f.store.listTranscriptMessages(f.threadId, { limit: 500 }), transcriptBefore);
    assert.equal(f.store.getLatestCheckpoint(f.threadId)?.id, previous.id);
    let inspected: CompactionCheckpoint | undefined;
    const committed = f.store.commitCompaction(f.threadId, {
      messages: [{ role: "user", content: "candidate" }],
      expectedActiveMessages: activeBefore,
      expectedLatestCheckpointId: previous.id,
      summary: "new summary",
      validateCheckpoint(checkpoint) {
        inspected = checkpoint;
      },
    });
    assert.strictEqual(inspected, committed);
    assert.equal(committed.transcript.messages.fromSequenceExclusive, 1000);
    assert.deepEqual(f.store.getLatestCheckpoint(f.threadId), committed);
  } finally {
    f.close();
  }
});

test("legacy cumulative pruning counts do not reject a complete available ledger", () => {
  const f = fixture();
  try {
    const checkpoint = seedLegacy(f);
    assert.ok(checkpoint.version === 2);
    const constraints = Array.from({ length: 129 }, (_, sequence) => ({
      quote: `Do not modify module-${String(sequence)}`,
      sourceSequence: sequence,
    }));
    const once = replaceCompactionSemanticConstraints(
      createEmptyCompactionSemanticState(),
      constraints,
    );
    const twice = replaceCompactionSemanticConstraints(once, constraints);
    assert.equal(twice.prunedItemCounts.constraint, 2);
    const updated = { ...checkpoint, constraints: constraints.slice(1), semanticState: twice };
    f.database
      .prepare("UPDATE compaction_checkpoints SET checkpoint_json=? WHERE id=?")
      .run(JSON.stringify(updated), checkpoint.id);
    const allFacts = constraints.flatMap((constraint) =>
      listSemanticArchiveItems(
        replaceCompactionSemanticConstraints(createEmptyCompactionSemanticState(), [constraint]),
      ),
    );
    new SemanticLedger(f.database).append(f.threadId, 1, "legacy", -1, allFacts);
    assert.ok(
      f.store
        .getSemanticLedgerRows(f.threadId)
        .some((row) => row.item_json.includes("Do not modify module-0")),
    );
    assert.equal(commit(f).version, 3);
  } finally {
    f.close();
  }
});

test("ledger-only legacy facts remain chunk-readable after lossy conversion, reopen and fork without duplicate archival", () => {
  const f = fixture();
  try {
    const legacy = seedLegacy(f);
    const legacyFact = "ledger-only-marker-73-fuchsia";
    const state = replaceCompactionSemanticConstraints(createEmptyCompactionSemanticState(), [
      { quote: legacyFact, sourceSequence: 0 },
    ]);
    new SemanticLedger(f.database).append(
      f.threadId,
      1,
      "legacy",
      -1,
      listSemanticArchiveItems(state),
    );
    const converted = commit(f, "Continue the task");
    assert.doesNotMatch(converted.taskSummary, /ledger-only-marker/);
    assert.doesNotMatch(JSON.stringify(f.store.getMessages(f.threadId)), /ledger-only-marker/);
    const archive = f.store
      .readCheckpointTranscript(f.threadId, { checkpointId: legacy.id, kind: "legacy_context" })
      .entries.at(-1);
    assert.ok(archive?.kind === "legacy_context");
    assert.equal(f.store.countTranscriptMessages(f.threadId), 2);
    const readAllChunks = (
      store: ThreadStore,
      threadId: string,
      checkpointId: string,
      sequence: number,
    ): string => {
      let text = "";
      let offset = 0;
      while (true) {
        const result = executeTranscriptTool(
          (input) => store.readCheckpointTranscript(threadId, input),
          { checkpointId, kind: "legacy_context", sequence, offset, maxChars: 91 },
        );
        assert.equal(result.outcome.kind, "success");
        const chunk = result.raw;
        assert.ok(
          typeof chunk === "object" &&
            chunk !== null &&
            "text" in chunk &&
            typeof chunk.text === "string",
        );
        text += chunk.text;
        if (!("nextOffset" in chunk)) return text;
        assert.equal(typeof chunk.nextOffset, "number");
        offset = Number(chunk.nextOffset);
      }
    };
    assert.match(
      readAllChunks(f.store, f.threadId, legacy.id, archive.sequence),
      new RegExp(legacyFact),
    );
    const reopened = new ThreadStore(f.dir);
    try {
      const fork = reopened.forkSnapshot(reopened.readSnapshot(f.threadId));
      const forkCheckpoint = reopened.getLatestCheckpoint(fork);
      assert.ok(forkCheckpoint?.version === 3);
      assert.ok(forkCheckpoint.previousCheckpointId);
      assert.match(
        readAllChunks(reopened, fork, forkCheckpoint.previousCheckpointId, archive.sequence),
        new RegExp(legacyFact),
      );
      const countBefore = reopened.countTranscriptMessages(f.threadId);
      const next = reopened.commitCompaction(f.threadId, {
        messages: reopened.getMessages(f.threadId),
        expectedActiveMessages: reopened.getMessages(f.threadId),
        expectedLatestCheckpointId: converted.id,
        summary: "Continue again",
      });
      assert.equal(reopened.countTranscriptMessages(f.threadId), countBefore);
      assert.match(buildCompactionCheckpointReminder(next), new RegExp(converted.id));
      assert.equal(
        reopened.readCheckpointTranscript(f.threadId, { checkpointId: next.id, kind: "message" })
          .previousCheckpointId,
        converted.id,
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
