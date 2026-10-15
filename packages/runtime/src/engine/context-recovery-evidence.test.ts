import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ThreadStore } from "../store/thread-store.ts";
import { ContextRecoveryGate, contextToolInputSchema } from "../tool-bridge/context-tool.ts";
import { createEmptyCompactionToolState } from "./compaction-checkpoint.ts";
import {
  buildCompactionSemanticEvidenceRegistry,
  createEmptyCompactionModelDraft,
  validateCompactionModelDraft,
} from "./compaction-semantic-state.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession } from "./agent-session.ts";
import { createToolExecutionRecord } from "../tool-bridge/tool-execution-record.ts";
import { successfulToolResult } from "../tool-bridge/normalize-result.ts";

test("only persisted, pure context tool copies are auto-covered; mixed new text remains evidence", async () => {
  const call = {
    type: "tool-call",
    toolName: "roll__context",
    toolCallId: "read-1",
    input: { action: "read" },
  } as const;
  const record = createToolExecutionRecord({
    toolCallId: "read-1",
    agentName: "roll",
    toolName: "context",
    input: call.input,
    result: successfulToolResult({ content: "old evidence" }),
  });
  const messages: ModelMessage[] = [
    { role: "assistant", content: [call] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          output: { type: "text", value: "old evidence" },
        },
      ],
    },
    {
      role: "assistant",
      content: [call, { type: "text", text: "NEW_OBSERVATION must remain evidence" }],
    },
    { role: "assistant", content: [{ ...call, toolCallId: "not-executed" }] },
  ];
  const session = new AgentSession({
    id: "derived-evidence",
    model: new MockLanguageModelV4(),
    sources: [],
    maxSteps: 8,
    initialMessages: messages,
    listTranscriptMessages: () =>
      messages.map((message, sequence) => ({
        message,
        sequence,
        provenance: "native",
        createdAt: new Date(0).toISOString(),
      })),
    listToolExecutions: () => [{ ...record, sequence: 0 }],
  });
  try {
    const evidence = session["captureCompactionEvidence"]();
    assert.deepEqual([...evidence.autoCoveredMessageSequences], [0, 1]);
    assert.deepEqual([...evidence.autoCoveredToolSequences], [0]);
    assert.match(JSON.stringify(evidence.registry), /NEW_OBSERVATION/);
    assert.match(JSON.stringify(evidence.registry), /not-executed/);
    assert.doesNotMatch(JSON.stringify(evidence.registry), /old evidence/);
  } finally {
    await session.close();
  }
});

test("resolution coverage uses actual serialized raw chunks, including repeated source quotes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-resolution-read-"));
  const store = new ThreadStore(dir);
  const id = store.createThread();
  const request = "Implement the retry helper.";
  store.appendMessages(id, [{ role: "user", content: request }]);
  const registry = buildCompactionSemanticEvidenceRegistry({
    messages: [{ sequence: 0, role: "user", summary: request }],
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const candidate = validateCompactionModelDraft({
    evidenceRegistry: registry,
    draft: {
      ...createEmptyCompactionModelDraft(),
      pendingWork: [
        {
          priorItemId: null,
          text: request,
          sourceQuotes: [request],
          sourceEvidenceIds: [registry[0]!.evidenceId],
        },
      ],
    },
  });
  const base = {
    messages: [{ role: "user" as const, content: request }],
    draft: {
      constraints: [],
      resources: [],
      runningWork: [],
      toolState: createEmptyCompactionToolState(),
      context: { cwd: dir, stableRuleIds: [], skills: [], explicitSkillNames: [] },
      summary: { status: "skipped" as const },
    },
    semanticState: candidate.state,
    semanticArchiveItems: candidate.archiveItems ?? [],
    semanticEvidenceWatermarks: { messagesThroughSequence: 0, toolExecutionsThroughSequence: -1 },
  };
  const first = store.commitCompaction(id, {
    ...base,
    expectedActiveMessages: store.getMessages(id),
    expectedLatestCheckpointId: undefined,
    evidenceWatermarks: { transcriptMessagesThroughSequence: 0, toolExecutionsThroughSequence: -1 },
  });
  const firstQuote = "First verification passed.";
  const lastQuote = 'Final "quoted" verification passed.';
  const body = `${firstQuote} ${"Intermediate inspection passed. ".repeat(400)}${lastQuote}`;
  const execution = createToolExecutionRecord({
    toolCallId: "verified",
    agentName: "fixture",
    toolName: "verify",
    input: {},
    result: successfulToolResult(body),
  });
  store.appendToolExecution(id, execution);
  const cp = store.commitCompaction(id, {
    ...base,
    expectedActiveMessages: store.getMessages(id),
    expectedLatestCheckpointId: first.id,
    evidenceWatermarks: { transcriptMessagesThroughSequence: 0, toolExecutionsThroughSequence: 0 },
    contextRecovery: { unextracted: true },
  });
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
  const gate = new ContextRecoveryGate(backend);
  const session = new AgentSession({
    id,
    model: new MockLanguageModelV4(),
    sources: [],
    maxSteps: 24,
    initialMessages: store.getMessages(id),
    initialCheckpoint: cp,
    contextStore: backend,
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
    listToolExecutions: (options) => store.listToolExecutions(id, options),
  });
  try {
    const evidence = session["captureCompactionEvidence"]();
    const source = evidence.registry.find(
      (entry) => entry.provenance.toolExecutionId === execution.id,
    );
    assert.ok(source);
    const draft = {
      ...createEmptyCompactionModelDraft(),
      resolutions: [
        {
          targetItemId: candidate.state.pendingWork[0]!.id,
          targetCategory: "pending_work" as const,
          action: "complete" as const,
          reason: "verification passed",
          sourceQuotes: [firstQuote, lastQuote],
          sourceEvidenceIds: [source.evidenceId, source.evidenceId],
        },
      ],
    };
    let offset = 0;
    let pages = 0;
    do {
      const read = gate.execute(
        contextToolInputSchema.parse({
          action: "read",
          checkpointId: cp.id,
          kind: "tool_execution",
          itemId: "0000000000000000",
          offset,
        }),
      );
      assert.equal(read.isError, false, JSON.stringify(read.raw));
      const page = z.object({ nextOffset: z.number().optional() }).parse(read.raw);
      pages++;
      if (pages === 1) {
        const partial = session["buildCompactionDraft"](evidence, draft, true, undefined);
        assert.equal(
          partial.semanticResolutions.length,
          0,
          "an unread second quote cannot borrow the first quote's coverage",
        );
        assert.equal(
          backend.segments(cp.id).length,
          1,
          "rejected resolutions must preserve prior progress",
        );
      }
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    } while (offset < 100_000);
    assert.ok(pages > 2);
    const complete = session["buildCompactionDraft"](evidence, draft, true, undefined);
    assert.equal(
      complete.semanticResolutions.length,
      1,
      "escaped quotes read across actual JSON chunks remain valid evidence",
    );
  } finally {
    await session.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
