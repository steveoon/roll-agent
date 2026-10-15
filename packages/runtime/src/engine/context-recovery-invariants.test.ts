import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ThreadStore } from "../store/thread-store.ts";
import { contextReadInputSchema } from "../store/semantic-ledger.ts";
import { ContextRecoveryGate, contextToolInputSchema } from "../tool-bridge/context-tool.ts";
import {
  buildCompactionSemanticEvidenceRegistry,
  createEmptyCompactionModelDraft,
  createEmptyCompactionSemanticState,
  mergeCompactionSemanticState,
  validateCompactionModelDraft,
  createCompactionSemanticReminderProjection,
  semanticTextItemSchema,
  type CompactionSemanticState,
  type SemanticArchiveItem,
  type CompactionSemanticResolution,
  replaceCompactionSemanticGoal,
} from "./compaction-semantic-state.ts";
import { createEmptyCompactionToolState } from "./compaction-checkpoint.ts";

import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, type ModelMessage } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { recoveryModelInputs } from "./context-recovery-test-helpers.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "roll-context-invariants-"));
  const store = new ThreadStore(dir);
  const id = store.createThread();
  const backend = {
    read: (input: Parameters<ThreadStore["readContext"]>[1]) => store.readContext(id, input),
    readTransaction: <T>(read: () => T) => store.withContextReadTransaction(read),
    recovery: () => store.getContextRecovery(id),
    ready: (checkpointId: string, memo: string) =>
      store.completeContextRecovery(id, checkpointId, memo),
    rows: () => store.getSemanticLedgerRows(id),
    recordSegment: (segment: Parameters<ThreadStore["recordContextReadSegment"]>[1]) =>
      store.recordContextReadSegment(id, segment),
    segments: (checkpointId: string) => store.listContextReadSegments(id, checkpointId),
    notes: (checkpointId: string) => store.contextRecoveryNotes(id, checkpointId),
    saveNotes: (checkpointId: string, notes: string) =>
      store.saveContextRecoveryNotes(id, checkpointId, notes),
  };
  const commit = (
    state: CompactionSemanticState,
    archiveItems: readonly SemanticArchiveItem[] = [],
    unextracted = false,
    resolutions: readonly CompactionSemanticResolution[] = [],
  ) => {
    const previous = store.getLatestCheckpoint(id);
    return store.commitCompaction(id, {
      messages: [],
      expectedActiveMessages: store.getMessages(id),
      expectedLatestCheckpointId: store.getLatestCheckpoint(id)?.id,
      draft: {
        ...(state.goal
          ? {
              goal: {
                verbatimRequest: state.goal.text,
                sourceSequence: state.goal.provenance[0]!.messageSequence!,
                status: "active" as const,
              },
            }
          : {}),
        constraints: state.constraints.map((item) => ({
          quote: item.text,
          sourceSequence: item.provenance[0]!.messageSequence!,
        })),
        resources: [],
        runningWork: [],
        toolState: createEmptyCompactionToolState(),
        context: { cwd: dir, stableRuleIds: [], skills: [], explicitSkillNames: [] },
        summary: { status: "skipped" },
      },
      semanticState: state,
      semanticArchiveItems: archiveItems,
      semanticResolutions: resolutions,
      semanticEvidenceWatermarks:
        previous?.version === 2
          ? previous.semanticEvidence
          : { messagesThroughSequence: -1, toolExecutionsThroughSequence: -1 },
      evidenceWatermarks: {
        transcriptMessagesThroughSequence: store.countTranscriptMessages(id) - 1,
        toolExecutionsThroughSequence:
          store.listRecentToolExecutions(id, { limit: 1 }).entries.at(-1)?.sequence ?? -1,
      },
      contextRecovery: { unextracted },
    });
  };
  return {
    dir,
    store,
    id,
    backend,
    commit,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function random(seed: number) {
  let s = seed;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

for (let seed = 1; seed <= 32; seed++) {
  test(`semantic archive remains complete across 24 growing rounds, seed ${seed}`, async () => {
    const f = fixture();
    try {
      let state = createEmptyCompactionSemanticState();
      const expected = new Map<string, string>();
      const rng = random(seed);
      const category = (["constraints", "pendingWork", "uncertainties"] as const)[seed % 3]!;
      for (let round = 0; round < 24; round++) {
        const entries = Array.from({ length: 20 }, (_, i) => ({
          sequence: round * 20 + i,
          role: "user",
          summary: `Constraint ${round}/${i}: ${"q".repeat(320 + Math.floor(rng() * 120))}`,
        }));
        const registry = buildCompactionSemanticEvidenceRegistry({
          messages: entries,
          toolExecutions: [],
          resources: [],
          runningSessions: [],
          fullSources: true,
        });
        const candidate = validateCompactionModelDraft({
          previousState: state,
          evidenceRegistry: registry,
          draft: {
            ...createEmptyCompactionModelDraft(),
            [category]: registry.map((e) => ({
              priorItemId: null,
              text: e.summary,
              sourceQuotes: [e.summary],
              sourceEvidenceIds: [e.evidenceId],
            })),
          },
        });
        for (const entry of candidate.archiveItems ?? []) {
          if ("text" in entry.item) expected.set(entry.item.id, entry.item.text);
        }
        state = mergeCompactionSemanticState(state, candidate, { startsNewGoalScope: false });
        f.store.appendMessages(f.id, [
          { role: "assistant", content: `raw source ${round}`.repeat(100) },
        ]);
        const cp = f.commit(state, candidate.archiveItems);
        assert.equal(f.store.getMessages(f.id).length, 0, "archived sources leave active history");
        assert.ok(
          JSON.stringify(createCompactionSemanticReminderProjection(state, 8000)).length <= 8000,
        );
        assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 128 * 1024);
        const rows = f.store.getSemanticLedgerRows(f.id);
        assert.ok(rows.length >= expected.size);
        for (const [id, text] of expected) {
          assert.equal(
            semanticTextItemSchema.parse(
              JSON.parse(rows.find((row) => row.item_id === id)!.item_json),
            ).text,
            text,
          );
        }
        const last = rows.find((row) => row.item_id === [...expected.keys()].at(-1))!;
        const read = f.store.readContext(
          f.id,
          contextReadInputSchema.parse({ checkpointId: cp.id, itemId: last.item_id }),
        );
        assert.ok(read.entries[0]?.content.includes(expected.get(last.item_id)!));
        if (round === 23) {
          const pagedIds = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = f.store.readContext(
              f.id,
              contextReadInputSchema.parse({ checkpointId: cp.id, cursor }),
            );
            for (const entry of page.entries) pagedIds.add(entry.id);
            cursor = page.nextCursor;
          } while (cursor);
          for (const itemId of expected.keys()) {
            assert.ok(
              pagedIds.has(itemId),
              "every omitted fact is discoverable through pagination",
            );
          }
        }
        await assertRecoveryLiveness(f, round, rng);
      }
    } finally {
      f.close();
    }
  });
}

test("harness duplicates cover new evidence without growing provenance; other scope/text stays distinct", () => {
  let previous = createEmptyCompactionSemanticState();
  for (let sequence = 0; sequence < 30; sequence++) {
    const registry = buildCompactionSemanticEvidenceRegistry({
      messages: [
        {
          sequence,
          role: "user",
          summary: `message ${sequence} user: Continue the same project; no new requirements.`,
        },
      ],
      toolExecutions: [],
      resources: [],
      runningSessions: [],
      fullSources: true,
    });
    const candidate = validateCompactionModelDraft({
      draft: createEmptyCompactionModelDraft(),
      previousState: previous,
      evidenceRegistry: registry,
      presentedEvidenceIds: registry.map((e) => e.evidenceId),
    });
    assert.equal(candidate.coveredEvidenceIds.length, 1);
    previous = mergeCompactionSemanticState(previous, candidate, { startsNewGoalScope: false });
    assert.equal(previous.uncertainties.length, 1);
    assert.equal(previous.uncertainties[0]?.provenance.length, 1);
  }
});

test("recovery receipts require full reads, are turn-local, and empty results never unlock", () => {
  const f = fixture();
  try {
    const marker = "DO_NOT_REPLAY_UNKNOWN_RESULT";
    f.store.appendMessages(f.id, [{ role: "user", content: "x".repeat(13000) + marker }]);
    const cp = f.commit(createEmptyCompactionSemanticState(), [], true);
    const gate = new ContextRecoveryGate(f.backend);
    const call = (input: Record<string, unknown>) =>
      gate.execute(contextToolInputSchema.parse({ checkpointId: cp.id, ...input }));
    const ready = {
      action: "ready",
      goal: "implement",
      constraints: "recover unknown outcome",
      nextAction: "inspect",
    };
    assert.equal(call({ ...ready, receipts: [randomUUID()] }).isError, true);
    const page = f.store.readContext(
      f.id,
      contextReadInputSchema.parse({ checkpointId: cp.id, kind: "message" }),
    );
    const itemId = page.entries[0]!.id;
    const partial = call({ action: "read", kind: "message", itemId });
    assert.equal(
      z.object({ receipt: z.string().optional() }).parse(partial.raw).receipt,
      undefined,
    );
    call({ action: "read", kind: "message", itemId, version: 2, offset: 6000 });
    const mixedVersion = call({
      action: "read",
      kind: "message",
      itemId,
      version: 2,
      offset: 12000,
    });
    assert.equal(
      mixedVersion.isError,
      true,
      "raw sources do not accept fabricated semantic versions",
    );
    assert.deepEqual(
      f.backend.segments(cp.id).map((segment) => segment.offset),
      [0],
    );
    call({ action: "read", kind: "message", itemId, offset: 6000 });
    const end = call({ action: "read", kind: "message", itemId, offset: 12000 });
    const receipt = z.object({ receipt: z.string() }).parse(end.raw).receipt;
    assert.ok(JSON.stringify(end.raw).includes(marker));
    gate.beginTurn();
    assert.equal(call({ ...ready, receipts: [receipt] }).isError, true);
    call({ action: "read", kind: "message", itemId });
    call({ action: "read", kind: "message", itemId, offset: 6000 });
    const fresh = z
      .object({ receipt: z.string() })
      .parse(call({ action: "read", kind: "message", itemId, offset: 12000 }).raw).receipt;
    assert.equal(call({ ...ready, receipts: [fresh] }).isError, false);
    assert.equal(new ContextRecoveryGate(f.backend).required, false);
    assert.throws(
      () =>
        f.store.readContext(
          f.store.createThread(),
          contextReadInputSchema.parse({ checkpointId: cp.id }),
        ),
      /belong/,
    );
  } finally {
    f.close();
  }
});

for (const failure of ["invalid", "timeout", "same-batch", "after-write"] as const) {
  test(`hard limit ${failure} archives then reads before side effects`, async () => {
    const f = fixture();
    let writes = 0;
    let calls = 0;
    let summaries = 0;
    const client = new Client({ name: "fixture", version: "1" });
    Object.defineProperty(client, "callTool", {
      value: async () => {
        writes++;
        return {
          content: [
            {
              type: "text",
              text: failure === "after-write" ? "written ".repeat(60000) : "written",
            },
          ],
        };
      },
    });
    const initial: ModelMessage[] = [
      { role: "user", content: "Never retry unknown results. Limit is 1739." },
      ...Array.from({ length: failure === "after-write" ? 0 : 6 }, () => ({
        role: "assistant" as const,
        content: "inspection ".repeat(9000),
      })),
    ];
    f.store.appendMessages(f.id, initial);
    const usage = {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const recover = recoveryModelInputs();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        summaries++;
        if (failure === "timeout") throw new DOMException("Summary deadline", "TimeoutError");
        return {
          content: [{ type: "text", text: "{}" }],
          usage,
          warnings: [],
          finishReason: { unified: "stop", raw: "stop" },
        };
      },
      doStream: async (params) => {
        calls++;
        if (failure === "after-write" && calls === 1) {
          return {
            stream: simulateReadableStream({
              initialDelayInMs: null,
              chunkDelayInMs: null,
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "written-before-compaction",
                  toolName: "fixture__write",
                  input: "{}",
                },
                {
                  type: "finish",
                  usage,
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                },
              ],
            }),
          };
        }
        const recovery = f.store.getContextRecovery(f.id);
        assert.ok(recovery, "oversized source must be archived before any real dispatch");
        const toolIds = (params.tools ?? []).map((t) => t.name);
        const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
        let name = "roll__context";
        let input: unknown;
        if (recovery.required) {
          assert.deepEqual(toolIds, ["roll__context"]);
          assert.equal(writes, failure === "after-write" ? 1 : 0);
          for (const [index, recoveryInput] of recover(
            params,
            recovery,
            "0000000000000000",
          ).entries()) {
            chunks.push({
              type: "tool-call",
              toolCallId: `c${calls}-${index}`,
              toolName: "roll__context",
              input: JSON.stringify(recoveryInput),
            });
          }
        } else if (writes === 0 && failure !== "after-write") {
          assert.ok(toolIds.includes("fixture__write"));
          assert.equal(recovery.required, false);
          assert.equal(writes, 0, "same-batch writes cannot use ready to bypass recovery");
          name = "fixture__write";
          input = {};
        } else {
          chunks.push(
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
          );
        }
        if (input !== undefined) {
          chunks.push({
            type: "tool-call",
            toolCallId: `c${calls}`,
            toolName: name,
            input: JSON.stringify(input),
          });
        }
        if (failure === "same-batch" && recovery.required) {
          chunks.push({
            type: "tool-call",
            toolCallId: `injected-write-${calls}`,
            toolName: "fixture__write",
            input: "{}",
          });
        }
        chunks.push({
          type: "finish",
          usage,
          finishReason: {
            unified: input === undefined && !recovery.required ? "stop" : "tool-calls",
            raw: "stop",
          },
        });
        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      },
    });
    const session = new AgentSession({
      id: f.id,
      model,
      sources: [
        {
          agentName: "fixture",
          client,
          tools: [
            {
              tool: { name: "write", inputSchema: { type: "object", properties: {} } },
              annotations: { destructiveHint: true },
            },
          ],
        },
      ],
      maxSteps: 12,
      policy: { check: () => ({ action: "allow" }) },
      initialMessages: initial,
      contextWindow: failure === "after-write" ? 8000 : 128000,
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.75,
        keepRecentTurns: 1,
        keepRecentTokens: 100,
      },
      onToolExecution: (record) => f.store.appendToolExecution(f.id, record),
      listToolExecutions: (options) => f.store.listToolExecutions(f.id, options),
      contextStore: f.backend,
      onAcceptInput: (id, msg) => f.store.acceptTurnInput(f.id, id, msg),
      onPersist: (messages, options) => f.store.appendMessages(f.id, messages, options),
      onReplace: (messages) => f.store.replaceMessages(f.id, messages),
      listTranscriptMessages: (options) => f.store.listTranscriptMessages(f.id, options),
      commitCompaction: (input) => f.store.commitCompaction(f.id, input),
    });
    try {
      const events = [];
      for await (const event of session.send("Continue")) events.push(event);
      assert.deepEqual(
        events.filter((e) => e.type === "error"),
        [],
      );
      const changes = events.filter((event) => event.type === "context-recovery");
      assert.ok(changes.some((event) => event.state?.required === true));
      assert.equal(changes.at(-1)?.state?.required, false);
      assert.equal(writes, 1);
      assert.ok(calls >= 4 && calls <= 12, "recovery must finish within the step budget");
      assert.equal(summaries, failure === "after-write" ? 0 : 1);
      assert.equal(
        f.store
          .listToolExecutions(f.id, { limit: 100 })
          .filter((r) => r.toolName === "write" && r.outcome.kind === "success").length,
        1,
        "successful side effects are never replayed across streams",
      );
      assert.ok(events.some((e) => e.type === "context-compacted" && e.removed > 0));
      assert.equal(f.store.getContextRecovery(f.id)?.required, false);
    } finally {
      await session.close();
      f.close();
    }
  });
}

async function assertRecoveryLiveness(
  f: ReturnType<typeof fixture>,
  round: number,
  rng: () => number,
) {
  // Complete a pending semantic read, then grow beyond an 8k model's hard input limit.
  const old = new ContextRecoveryGate(f.backend);
  const checkpoint = f.store.getLatestCheckpoint(f.id)!;
  const requiredItems = f.backend.recovery()!.requiredItems;
  const items = requiredItems.length
    ? requiredItems
    : [{ itemId: f.store.getSemanticLedgerRows(f.id)[0]!.item_id }];
  let receipt = "";
  for (const item of items) {
    const result = old.execute(
      contextToolInputSchema.parse({
        action: "read",
        checkpointId: checkpoint.id,
        itemId: item.itemId,
      }),
    );
    receipt = z.object({ receipt: z.string() }).parse(result.raw).receipt;
  }
  old.execute(
    contextToolInputSchema.parse({
      action: "ready",
      checkpointId: checkpoint.id,
      receipts: [receipt],
      goal: "test growing activity",
      constraints: "retain all facts",
      nextAction: "inspect",
    }),
  );
  const sourceId = String(f.store.countTranscriptMessages(f.id)).padStart(16, "0");
  f.store.appendMessages(f.id, [
    { role: "user", content: `round ${round}: preserve every archived fact` },
    { role: "assistant", content: "inspection ".repeat(3200 + Math.floor(rng() * 2000)) },
  ]);
  let dispatched = 0;
  const recover = recoveryModelInputs();
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new DOMException("deadline", "TimeoutError");
    },
    doStream: async (params) => {
      dispatched++;
      const recovery = f.store.getContextRecovery(f.id);
      const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (recovery?.required) {
        assert.deepEqual(
          params.tools?.map((t) => t.name),
          ["roll__context"],
        );
        for (const [index, input] of recover(params, recovery, sourceId).entries()) {
          chunks.push({
            type: "tool-call",
            toolCallId: `recover-${dispatched}-${index}`,
            toolName: "roll__context",
            input: JSON.stringify(input),
          });
        }
      } else {
        chunks.push(
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "inspected" },
          { type: "text-end", id: "t" },
        );
      }
      chunks.push({
        type: "finish",
        usage,
        finishReason: { unified: recovery?.required ? "tool-calls" : "stop", raw: "stop" },
      });
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
  const session = new AgentSession({
    id: f.id,
    model,
    sources: [],
    maxSteps: 64,
    contextWindow: 8192,
    initialMessages: f.store.getMessages(f.id),
    initialCheckpoint: f.store.getLatestCheckpoint(f.id)!,
    contextStore: f.backend,
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 100,
    },
    onAcceptInput: (id, msg) => f.store.acceptTurnInput(f.id, id, msg),
    onPersist: (messages, options) => f.store.appendMessages(f.id, messages, options),
    onReplace: (messages) => f.store.replaceMessages(f.id, messages),
    onToolExecution: (r) => f.store.appendToolExecution(f.id, r),
    listToolExecutions: (o) => f.store.listToolExecutions(f.id, o),
    listTranscriptMessages: (o) => f.store.listTranscriptMessages(f.id, o),
    commitCompaction: (input) => f.store.commitCompaction(f.id, input),
  });
  try {
    const events = [];
    if (round % 3 === 0) for await (const e of session.compact()) events.push(e);
    for await (const e of session.send("Continue the same activity")) events.push(e);
    assert.deepEqual(
      events.filter((e) => e.type === "error"),
      [],
      `round ${round}`,
    );
    assert.ok(
      events.some((e) => e.type === "context-compacted" && e.removed > 0),
      "maintenance releases movable sources",
    );
    assert.ok(dispatched > 0, "guard admits recovery and resumed request");
    assert.equal(f.store.getContextRecovery(f.id)?.required, false);
  } finally {
    await session.close();
  }
}

test("ledger transaction failure keeps sources, checkpoints and semantic versions unchanged", () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.dir, "threads.db"));
  try {
    f.store.appendMessages(f.id, [{ role: "user", content: "retain raw source" }]);
    const cp = f.commit(createEmptyCompactionSemanticState());
    f.store.appendMessages(f.id, [{ role: "assistant", content: "new source" }]);
    const before = f.store.readSnapshot(f.id);
    db.exec(
      "CREATE TRIGGER fail_context_commit BEFORE INSERT ON compaction_recovery BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
    );
    assert.throws(() => f.commit(createEmptyCompactionSemanticState()), /injected storage failure/);
    assert.deepEqual(f.store.getMessages(f.id), before.messages);
    assert.equal(f.store.getLatestCheckpoint(f.id)?.id, cp.id);
    assert.deepEqual(f.store.getSemanticLedgerRows(f.id), before.semanticLedger);
  } finally {
    db.close();
    f.close();
  }
});

test("fork retains all semantic versions and requires fresh recovery reads", () => {
  const f = fixture();
  try {
    const state = replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
      verbatimRequest: "Keep a stable contract",
      sourceSequence: 0,
    });
    f.store.appendMessages(f.id, [{ role: "user", content: "Keep a stable contract" }]);
    const cp = f.commit(state, [{ category: "goal", item: state.goal! }]);
    const gate = new ContextRecoveryGate(f.backend);
    const read = gate.execute(
      contextToolInputSchema.parse({ action: "read", checkpointId: cp.id, itemId: state.goal!.id }),
    );
    gate.execute(
      contextToolInputSchema.parse({
        action: "ready",
        checkpointId: cp.id,
        receipts: [z.object({ receipt: z.string() }).parse(read.raw).receipt],
        goal: "stable",
        constraints: "contract",
        nextAction: "verify",
      }),
    );
    const fork = f.store.forkSnapshot(f.store.readSnapshot(f.id));
    assert.deepEqual(f.store.getSemanticLedgerRows(fork), f.store.getSemanticLedgerRows(f.id));
    assert.equal(f.store.getContextRecovery(fork)?.required, true);
    assert.notEqual(f.store.getLatestCheckpoint(fork)?.id, cp.id);
  } finally {
    f.close();
  }
});

test("complete and reopen are single-target evidence transitions with retained versions", () => {
  const f = fixture();
  try {
    const registry = buildCompactionSemanticEvidenceRegistry({
      messages: [{ sequence: 0, role: "user", summary: "Implement retry helper" }],
      toolExecutions: [],
      resources: [],
      runningSessions: [],
    });
    const e = registry[0]!;
    const pending = validateCompactionModelDraft({
      draft: {
        ...createEmptyCompactionModelDraft(),
        pendingWork: [
          {
            priorItemId: null,
            text: e.summary,
            sourceQuotes: [e.summary],
            sourceEvidenceIds: [e.evidenceId],
          },
        ],
      },
      evidenceRegistry: registry,
    });
    f.store.appendMessages(f.id, [{ role: "user", content: e.summary }]);
    f.commit(pending.state, pending.archiveItems);
    const target = pending.state.pendingWork[0]!;
    const execution = randomUUID();
    const tools = buildCompactionSemanticEvidenceRegistry({
      messages: [],
      toolExecutions: [
        {
          id: execution,
          agentName: "roll",
          toolName: "test",
          resultSummary: "Retry helper passes assertions",
          outcome: { kind: "success" },
        },
      ],
      resources: [],
      runningSessions: [],
    });
    const evidence = tools[0]!;
    const draft = {
      ...createEmptyCompactionModelDraft(),
      resolutions: [
        {
          targetItemId: target.id,
          targetCategory: "pending_work",
          action: "complete",
          reason: "verified helper",
          sourceQuotes: [evidence.summary],
          sourceEvidenceIds: [evidence.evidenceId],
        },
      ],
    };
    const validate = (watermark: number) =>
      validateCompactionModelDraft({
        draft,
        evidenceRegistry: tools,
        previousState: pending.state,
        resolutionTargets: [
          {
            category: "pending_work",
            item: target,
            firstToolSequence: watermark,
            status: "active",
          },
        ],
        toolSequences: new Map([[execution, 2]]),
      });
    assert.equal(validate(2).resolutions.length, 0, "old evidence cannot close pending work");
    const complete = validate(1);
    assert.equal(complete.resolutions.length, 1);
    const done = mergeCompactionSemanticState(pending.state, complete, {
      startsNewGoalScope: false,
    });
    assert.equal(done.pendingWork.length, 0);
    assert.equal(done.completedWork[0]?.relatedItemId, target.id);
    f.commit(done, complete.archiveItems, false, complete.resolutions);
    const closed = done.completedWork[0]!;
    const user = buildCompactionSemanticEvidenceRegistry({
      messages: [
        { sequence: 2, role: "user", summary: "Reopen the retry helper; it needs a correction" },
      ],
      toolExecutions: [],
      resources: [],
      runningSessions: [],
    })[0]!;
    const reopen = validateCompactionModelDraft({
      draft: {
        ...createEmptyCompactionModelDraft(),
        resolutions: [
          {
            targetItemId: closed.id,
            targetCategory: "completed_work",
            action: "reopen",
            reason: "user correction",
            sourceQuotes: [user.summary],
            sourceEvidenceIds: [user.evidenceId],
          },
        ],
      },
      evidenceRegistry: [user],
      previousState: done,
      resolutionTargets: [
        { category: "completed_work", item: closed, firstToolSequence: 2, status: "completed" },
      ],
    });
    assert.equal(reopen.resolutions.length, 1);
    const reopened = mergeCompactionSemanticState(done, reopen, { startsNewGoalScope: false });
    const cp = f.commit(reopened, reopen.archiveItems, false, reopen.resolutions);
    assert.equal(reopened.pendingWork[0]?.relatedItemId, closed.id);
    const rows = f.store.readSnapshot(f.id).semanticLedger!;
    assert.equal(rows.filter((r) => r.item_id === target.id).length, 2);
    assert.ok(rows.some((r) => r.resolution_json?.includes('"action":"complete"')));
    assert.ok(rows.some((r) => r.resolution_json?.includes('"action":"reopen"')));
    assert.ok(
      f.store
        .readContext(
          f.id,
          contextReadInputSchema.parse({ checkpointId: cp.id, itemId: target.id, version: 1 }),
        )
        .entries[0]?.content.includes('"status":"active"'),
    );
  } finally {
    f.close();
  }
});

test("automatic dedup respects confirmed scope, paths, tool identity and outcome differences", () => {
  const auto = (previous: CompactionSemanticState, sequence: number, text: string) => {
    const registry = buildCompactionSemanticEvidenceRegistry({
      messages: [{ sequence, role: "user", summary: `message ${sequence} user: ${text}` }],
      toolExecutions: [],
      resources: [],
      runningSessions: [],
      fullSources: true,
    });
    return validateCompactionModelDraft({
      previousState: previous,
      draft: createEmptyCompactionModelDraft(),
      evidenceRegistry: registry,
      presentedEvidenceIds: registry.map((e) => e.evidenceId),
    });
  };
  const initial = replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
    verbatimRequest: "Project A",
    sourceSequence: 0,
  });
  const first = auto(initial, 1, "Inspect /work/a  b: port 1234");
  const state = mergeCompactionSemanticState(initial, first, { startsNewGoalScope: false });
  assert.equal(auto(state, 2, "Inspect /work/a  b: port 1234").state.uncertainties.length, 0);
  for (const text of ["Inspect /work/a b: port 1234", "Inspect /work/a  b: port 1235"]) {
    assert.equal(auto(state, 3, text).state.uncertainties.length, 1);
  }
  const other = {
    ...replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
      verbatimRequest: "Project B",
      sourceSequence: 10,
    }),
    uncertainties: state.uncertainties,
  };
  assert.equal(auto(other, 11, "Inspect /work/a  b: port 1234").state.uncertainties.length, 1);
  let tools = createEmptyCompactionSemanticState();
  for (const [toolName, inputSummary, resultSummary, count] of [
    ["read", "/a", "missing", 1],
    ["read", "/a", "missing", 1],
    ["read", "/b", "missing", 2],
    ["write", "/b", "missing", 3],
    ["write", "/b", "denied", 4],
  ] as const) {
    const registry = buildCompactionSemanticEvidenceRegistry({
      messages: [],
      toolExecutions: [
        {
          id: randomUUID(),
          agentName: "fixture",
          toolName,
          inputSummary,
          resultSummary,
          outcome: { kind: "tool_failed" },
        },
      ],
      resources: [],
      runningSessions: [],
      fullSources: true,
    });
    const candidate = validateCompactionModelDraft({
      previousState: tools,
      draft: createEmptyCompactionModelDraft(),
      evidenceRegistry: registry,
      presentedEvidenceIds: registry.map((e) => e.evidenceId),
    });
    tools = mergeCompactionSemanticState(tools, candidate, { startsNewGoalScope: false });
    assert.equal(tools.uncertainties.length, count);
  }
});

test("null and empty optional filters do not hide ledger entries; previews never issue receipts", () => {
  const f = fixture();
  try {
    f.store.appendMessages(f.id, [{ role: "user", content: "never change port 1234" }]);
    const state = replaceCompactionSemanticGoal(createEmptyCompactionSemanticState(), {
      verbatimRequest: "never change port 1234",
      sourceSequence: 0,
    });
    const cp = f.commit(state, [{ category: "goal", item: state.goal! }]);
    const gate = new ContextRecoveryGate(f.backend);
    const listed = gate.execute(
      contextToolInputSchema.parse({
        action: "list",
        checkpointId: cp.id,
        itemId: "",
        cursor: "",
        query: "not a filter for list",
        category: null,
      }),
    );
    assert.equal(listed.isError, false);
    const page = z
      .object({ entries: z.array(z.unknown()), receipt: z.string().optional() })
      .parse(listed.raw);
    assert.equal(page.entries.length, 1);
    assert.equal(page.receipt, undefined);
    assert.equal(
      gate.execute(
        contextToolInputSchema.parse({
          action: "search",
          checkpointId: cp.id,
          query: "no such fact",
        }),
      ).isError,
      false,
    );
    assert.equal(gate.required, true);
  } finally {
    f.close();
  }
});
