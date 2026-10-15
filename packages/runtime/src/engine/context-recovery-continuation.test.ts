import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4FinishReason, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { ThreadStore } from "../store/thread-store.ts";
import {
  CONTEXT_READ_CHUNK_CHARS,
  RECOVERY_PAGE_ITEMS,
  RECOVERY_RESERVED_STEPS,
} from "../store/semantic-ledger.ts";
import { omitEarlierContextReads } from "../tool-bridge/context-tool.ts";
import { createEmptyCompactionToolState } from "./compaction-checkpoint.ts";
import {
  buildCompactionSemanticEvidenceRegistry,
  createEmptyCompactionModelDraft,
  validateCompactionModelDraft,
} from "./compaction-semantic-state.ts";
import { AgentSession } from "./agent-session.ts";

const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: "stop" };

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: usage(), finishReason: STOP },
  ];
}

function streamChunks(chunks: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

const projectionCheckpoint = "11111111-1111-4111-8111-111111111111";
const projectionNotes = "Previously read facts are preserved here.";
const projectionNotesHash = createHash("sha256").update(projectionNotes).digest("hex");
function contextRound(id: string, body: string, recovery = false): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "roll__context", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "roll__context",
          output: recovery
            ? {
                type: "json",
                value: {
                  body,
                  recoveryProjection: {
                    checkpointId: projectionCheckpoint,
                    read: true,
                    notesHash: projectionNotesHash,
                  },
                },
              }
            : { type: "text", value: body },
        },
      ],
    },
  ];
}

test("ordinary recall and empty searches never evict earlier facts", () => {
  const messages = [
    ...contextRound("read", "IMPORTANT_FACT"),
    ...contextRound("search", "empty search"),
  ];
  assert.deepEqual(omitEarlierContextReads(messages), messages);
  assert.deepEqual(
    omitEarlierContextReads(messages, {
      checkpointId: projectionCheckpoint,
      notesHash: projectionNotesHash,
    }),
    messages,
  );
});

test("only acknowledged recovery pages leave the prompt with their paired calls", () => {
  const messages = [
    ...contextRound("ordinary", "ORDINARY_FACT"),
    ...contextRound("old", "OLD_READ_BODY", true),
    ...contextRound("mid", "MID_READ_BODY", true),
    ...contextRound("last", "LAST_READ_BODY", true),
    ...contextRound("search", "empty search"),
  ];
  assert.deepEqual(omitEarlierContextReads(messages), messages, "durable notes are required");
  assert.deepEqual(
    omitEarlierContextReads(messages, {
      checkpointId: projectionCheckpoint,
      notesHash: "0".repeat(64),
    }),
    messages,
    "unacknowledged notes cannot drop reads",
  );
  const projected = omitEarlierContextReads(messages, {
    checkpointId: projectionCheckpoint,
    notesHash: projectionNotesHash,
  });
  assert.deepEqual(projected, [...messages.slice(0, 2), ...messages.slice(6)]);
});

test("duplicate source IDs cannot bypass an unread quote; completing the read allows it", () => {
  const filler = "Keep the documented contract intact. ";
  let body = "";
  while (body.length < CONTEXT_READ_CHUNK_CHARS * 9) body += filler;
  body += "Final segment must be read before close.";
  const dir = mkdtempSync(join(tmpdir(), "roll-segment-resolution-"));
  const store = new ThreadStore(dir);
  const threadId = store.createThread();
  const execution = randomUUID();
  const tools = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: [],
    toolExecutions: [
      {
        id: execution,
        agentName: "roll",
        toolName: "test",
        resultSummary: body,
        outcome: { kind: "success" },
      },
    ],
    resources: [],
    runningSessions: [],
  });
  const evidence = tools[0]!;
  const quote = "Final segment must be read before close.";
  const pending = validateCompactionModelDraft({
    draft: {
      ...createEmptyCompactionModelDraft(),
      pendingWork: [
        {
          priorItemId: null,
          text: "Implement retry helper",
          sourceQuotes: ["Implement retry helper"],
          sourceEvidenceIds: [
            buildCompactionSemanticEvidenceRegistry({
              messages: [{ sequence: 0, role: "user", summary: "Implement retry helper" }],
              toolExecutions: [],
              resources: [],
              runningSessions: [],
            })[0]!.evidenceId,
          ],
        },
      ],
    },
    evidenceRegistry: buildCompactionSemanticEvidenceRegistry({
      messages: [{ sequence: 0, role: "user", summary: "Implement retry helper" }],
      toolExecutions: [],
      resources: [],
      runningSessions: [],
    }),
  });
  store.appendMessages(threadId, [{ role: "user", content: "Implement retry helper" }]);
  const checkpoint = store.commitCompaction(threadId, {
    messages: [],
    expectedActiveMessages: store.getMessages(threadId),
    expectedLatestCheckpointId: undefined,
    draft: {
      constraints: [],
      resources: [],
      runningWork: [],
      toolState: createEmptyCompactionToolState(),
      context: { cwd: dir, stableRuleIds: [], skills: [], explicitSkillNames: [] },
      summary: { status: "skipped" },
    },
    semanticState: pending.state,
    semanticArchiveItems: pending.archiveItems ?? [],
    semanticEvidenceWatermarks: { messagesThroughSequence: 0, toolExecutionsThroughSequence: -1 },
    evidenceWatermarks: { transcriptMessagesThroughSequence: 0, toolExecutionsThroughSequence: -1 },
  });
  const target = pending.state.pendingWork[0]!;
  const source = evidence.fullSource ?? "";
  for (let offset = 0; offset < CONTEXT_READ_CHUNK_CHARS * 9; offset += CONTEXT_READ_CHUNK_CHARS) {
    store.recordContextReadSegment(threadId, {
      checkpointId: checkpoint.id,
      kind: "semantic",
      itemId: target.id,
      version: 1,
      offset,
      finished: false,
    });
  }
  const before = store.listContextReadSegments(threadId, checkpoint.id);
  const validate = (content: string) =>
    validateCompactionModelDraft({
      draft: {
        ...createEmptyCompactionModelDraft(),
        resolutions: [
          {
            targetItemId: target.id,
            targetCategory: "pending_work",
            action: "complete",
            reason: "verified helper",
            sourceQuotes: [filler.trim(), quote],
            sourceEvidenceIds: [evidence.evidenceId, evidence.evidenceId],
          },
        ],
      },
      evidenceRegistry: tools,
      previousState: pending.state,
      resolutionTargets: [
        { category: "pending_work", item: target, firstToolSequence: 1, status: "active" },
      ],
      toolSequences: new Map([[execution, 2]]),
      durableReadSegments: [{ provenance: evidence.provenance, content }],
    });
  const validated = validate(JSON.stringify(source).slice(0, CONTEXT_READ_CHUNK_CHARS * 9));
  assert.equal(
    validate(JSON.stringify(source)).resolutions.length,
    1,
    "reading the final segment must allow closure",
  );
  assert.equal(validated.resolutions.length, 0);
  assert.equal(validated.rejections[0]?.reason, "incomplete_read_segment");
  assert.equal(store.listContextReadSegments(threadId, checkpoint.id).length, before.length);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("manual compaction does not archive when retention cannot judge a one-message removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-manual-hold-"));
  const store = new ThreadStore(dir);
  const threadId = store.createThread();
  const sentences = Array.from(
    { length: 40 },
    (_, index) => `Constraint ${String(index)} must remain visible in the ledger.`,
  );
  store.appendMessages(threadId, [
    { role: "user", content: sentences.join(" ") },
    { role: "user", content: "continue the same project" },
  ]);
  let commits = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      const evidenceId = /evidence_[0-9a-f]{24}/u.exec(prompt)?.[0];
      if (evidenceId === undefined) throw new Error(prompt.slice(0, 2000));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...createEmptyCompactionModelDraft(),
              constraints: sentences.map((sentence) => ({
                priorItemId: null,
                text: sentence,
                sourceQuotes: [sentence],
                sourceEvidenceIds: [evidenceId],
              })),
            }),
          },
        ],
        finishReason: STOP,
        usage: usage(),
        warnings: [],
      };
    },
  });
  const session = new AgentSession({
    id: threadId,
    model,
    sources: [],
    maxSteps: 2,
    initialMessages: store.getMessages(threadId),
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    contextStore: {
      read: (input) => store.readContext(threadId, input),
      readTransaction: (read) => store.withContextReadTransaction(read),
      recovery: () => store.getContextRecovery(threadId),
      ready: (checkpointId, memo) => store.completeContextRecovery(threadId, checkpointId, memo),
      rows: () => store.getSemanticLedgerRows(threadId),
      recordSegment: (segment) => store.recordContextReadSegment(threadId, segment),
      segments: (checkpointId) => store.listContextReadSegments(threadId, checkpointId),
      notes: (checkpointId) => store.contextRecoveryNotes(threadId, checkpointId),
      saveNotes: (checkpointId, notes) =>
        store.saveContextRecoveryNotes(threadId, checkpointId, notes),
    },
    listTranscriptMessages: (options) => store.listTranscriptMessages(threadId, options),
    commitCompaction: (input) => {
      commits += 1;
      return store.commitCompaction(threadId, input);
    },
  });
  const events = [];
  for await (const event of session.compact("manual")) events.push(event);
  const compacted = events.find((event) => event.type === "context-compacted");
  assert.equal(compacted?.type, "context-compacted", JSON.stringify(events, null, 2));
  if (compacted?.type === "context-compacted") {
    assert.equal(compacted.removed, 0);
    assert.match(compacted.recoveryNotice ?? "", /语义覆盖不足/u);
    assert.equal(store.getMessages(threadId).length, 2);
    assert.equal(compacted.checkpointId, undefined);
  }
  assert.equal(commits, 0);
  assert.equal(store.getContextRecovery(threadId), undefined);
  await session.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an unfinished recovery page stays dispatchable without another summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-recovery-page-"));
  const store = new ThreadStore(dir);
  const threadId = store.createThread();
  const checkpointId = "11111111-1111-4111-8111-111111111111";
  let summaries = 0;
  let prompt = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompt = JSON.stringify(options.prompt);
      return streamChunks(textStep("still reading"));
    },
    doGenerate: async () => {
      summaries += 1;
      throw new Error("summary must not start");
    },
  });
  const session = new AgentSession({
    id: threadId,
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 8_000,
    initialMessages: [
      { role: "user", content: "continue" },
      ...contextRound("old", `OLD_READ_BODY ${"x".repeat(8_000)}`, true),
      ...contextRound("last", "LAST_READ_BODY", true),
    ],
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.5,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    contextStore: {
      read: (input) => store.readContext(threadId, input),
      readTransaction: (read) => store.withContextReadTransaction(read),
      recovery: () => ({
        checkpointId,
        required: true,
        unextracted: false,
        memo: "",
        requiredItems: [
          { itemId: "semantic_goal_abcdefghijklmnopqrstuv", version: 1, category: "goal" },
        ],
      }),
      ready: () => {},
      rows: () => [],
      recordSegment: () => {},
      segments: () => [],
      notes: () => projectionNotes,
      saveNotes: () => {},
    },
  });
  const events = [];
  for await (const event of session.send("continue")) events.push(event);
  assert.equal(summaries, 0);
  assert.match(prompt, /LAST_READ_BODY/u);
  assert.doesNotMatch(prompt, /OLD_READ_BODY/u);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
  await session.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("summary timeout above the hard ceiling still archives a read-only recovery checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-recovery-timeout-"));
  const store = new ThreadStore(dir);
  const threadId = store.createThread();
  store.appendMessages(threadId, [
    { role: "user", content: "keep-me" },
    { role: "assistant", content: "x".repeat(20_000) },
  ]);
  const model = new MockLanguageModelV4({
    doStream: async () => streamChunks(textStep("after archive")),
    doGenerate: async () => {
      const error = new Error("provider request timed out");
      error.name = "TimeoutError";
      throw error;
    },
  });
  const session = new AgentSession({
    id: threadId,
    model,
    sources: [],
    maxSteps: 4,
    contextWindow: 4_096,
    initialMessages: store.getMessages(threadId),
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    contextStore: {
      read: (input) => store.readContext(threadId, input),
      readTransaction: (read) => store.withContextReadTransaction(read),
      recovery: () => store.getContextRecovery(threadId),
      ready: (checkpointId, memo) => store.completeContextRecovery(threadId, checkpointId, memo),
      rows: () => store.getSemanticLedgerRows(threadId),
      recordSegment: (segment) => store.recordContextReadSegment(threadId, segment),
      segments: (checkpointId) => store.listContextReadSegments(threadId, checkpointId),
      notes: (checkpointId) => store.contextRecoveryNotes(threadId, checkpointId),
      saveNotes: (checkpointId, notes) =>
        store.saveContextRecoveryNotes(threadId, checkpointId, notes),
    },
    onAcceptInput: (inputId, message) => store.acceptTurnInput(threadId, inputId, message),
    onPersist: (messages, options) => store.appendMessages(threadId, messages, options),
    onReplace: (messages) => store.replaceMessages(threadId, messages),
    listTranscriptMessages: (options) => store.listTranscriptMessages(threadId, options),
    commitCompaction: (input) => store.commitCompaction(threadId, input),
  });
  const events = [];
  for await (const event of session.send("next")) events.push(event);
  const recovery = store.getContextRecovery(threadId);
  assert.equal(recovery?.required, true);
  assert.equal(recovery?.unextracted, true);
  assert.ok(events.some((event) => event.type === "context-compacted" && event.removed > 0));
  await session.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("manual compaction reports a real one-message removal and skips work that removes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-manual-split-"));
  const store = new ThreadStore(dir);
  const threadId = store.createThread();
  const kept = "continue the same project";
  const dropped = "Constraint 0 must remain visible in the ledger.";
  store.appendMessages(threadId, [
    { role: "user", content: dropped },
    { role: "user", content: kept },
  ]);
  const modelFor = (remove: boolean) =>
    new MockLanguageModelV4({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        const evidenceId = /evidence_[0-9a-f]{24}/u.exec(prompt)?.[0] ?? "missing";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...createEmptyCompactionModelDraft(),
                ...(remove
                  ? {
                      constraints: [
                        {
                          priorItemId: null,
                          text: dropped,
                          sourceQuotes: [dropped],
                          sourceEvidenceIds: [evidenceId],
                        },
                      ],
                    }
                  : {}),
              }),
            },
          ],
          finishReason: STOP,
          usage: usage(),
          warnings: [],
        };
      },
    });
  const base = {
    id: threadId,
    sources: [],
    maxSteps: 2,
    initialMessages: store.getMessages(threadId),
    contextStore: recoveryStore(store, threadId),
    listTranscriptMessages: (options?: { afterSequence?: number; limit?: number }) =>
      store.listTranscriptMessages(threadId, options),
    commitCompaction: (input: Parameters<ThreadStore["commitCompaction"]>[1]) =>
      store.commitCompaction(threadId, input),
  };
  const idle = new AgentSession({
    ...base,
    model: modelFor(false),
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 5,
      keepRecentTokens: 100,
    },
  });
  const idleEvents = [];
  for await (const event of idle.compact("manual")) idleEvents.push(event);
  const idleCompacted = idleEvents.find((event) => event.type === "context-compacted");
  assert.equal(idleCompacted?.type, "context-compacted");
  if (idleCompacted?.type === "context-compacted") {
    assert.equal(idleCompacted.removed, 0);
    assert.match(idleCompacted.recoveryNotice ?? "", /无需压缩/u);
  }
  assert.equal(store.getContextRecovery(threadId), undefined);
  assert.equal(store.getMessages(threadId).length, 2);
  await idle.close();
  const checkpoint = store.getLatestCheckpoint(threadId);
  const removing = new AgentSession({
    ...base,
    initialMessages: store.getMessages(threadId),
    ...(checkpoint === undefined ? {} : { initialCheckpoint: checkpoint }),
    model: modelFor(true),
    compaction: {
      enabled: true,
      strategy: "summarize",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
  });
  const removedEvents = [];
  for await (const event of removing.compact("manual")) removedEvents.push(event);
  const removed = removedEvents.find((event) => event.type === "context-compacted");
  assert.equal(removed?.type, "context-compacted", JSON.stringify(removedEvents));
  if (removed?.type === "context-compacted") assert.equal(removed.removed, 1);
  assert.equal(store.getContextRecovery(threadId)?.required ?? false, false);
  await removing.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("equivalent repeated source ids stay grounded and unknown ids stay rejected", () => {
  const registry = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: [
      {
        sequence: 0,
        role: "user",
        summary: `${"Alpha stays. ".repeat(40)}Beta stays.`,
      },
    ],
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const evidence = registry[0]!;
  const accepted = validateCompactionModelDraft({
    draft: {
      ...createEmptyCompactionModelDraft(),
      constraints: [
        {
          priorItemId: null,
          text: "both sentences",
          sourceQuotes: ["Alpha stays.", "Beta stays."],
          sourceEvidenceIds: [evidence.evidenceId, evidence.evidenceId],
        },
      ],
    },
    evidenceRegistry: registry,
  });
  assert.deepEqual(accepted.rejections, []);
  assert.equal(accepted.state.constraints.length, 1);
  const rejected = validateCompactionModelDraft({
    draft: {
      ...createEmptyCompactionModelDraft(),
      constraints: [
        {
          priorItemId: null,
          text: "missing source",
          sourceQuotes: ["Alpha stays."],
          sourceEvidenceIds: [evidence.evidenceId, "not-a-real-source"],
        },
      ],
    },
    evidenceRegistry: registry,
  });
  assert.equal(rejected.rejections[0]?.reason, "unknown_provenance");
});

function recoveryStore(store: ThreadStore, threadId: string) {
  return {
    read: (input: Parameters<ThreadStore["readContext"]>[1]) => store.readContext(threadId, input),
    readTransaction: <T>(read: () => T) => store.withContextReadTransaction(read),
    recovery: () => store.getContextRecovery(threadId),
    ready: (checkpointId: string, memo: string) =>
      store.completeContextRecovery(threadId, checkpointId, memo),
    rows: () => store.getSemanticLedgerRows(threadId),
    recordSegment: (segment: Parameters<ThreadStore["recordContextReadSegment"]>[1]) =>
      store.recordContextReadSegment(threadId, segment),
    segments: (checkpointId: string) => store.listContextReadSegments(threadId, checkpointId),
    notes: (checkpointId: string) => store.contextRecoveryNotes(threadId, checkpointId),
    saveNotes: (checkpointId: string, notes: string) =>
      store.saveContextRecoveryNotes(threadId, checkpointId, notes),
  };
}

test("27 required items finish inside 24 steps and resume work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-recovery-budget-"));
  let store = new ThreadStore(dir);
  const threadId = store.createThread();
  const messages = Array.from({ length: 27 }, (_, index) => ({
    role: "user" as const,
    content: `Constraint ${String(index)} stays available.`,
  }));
  store.appendMessages(threadId, messages);
  const registry = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: messages.map((message, sequence) => ({
      sequence,
      role: message.role,
      summary: `message ${String(sequence)} user: ${message.content}`,
    })),
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const candidate = validateCompactionModelDraft({
    draft: {
      ...createEmptyCompactionModelDraft(),
      constraints: registry.map((entry) => ({
        priorItemId: null,
        text: entry.summary,
        sourceQuotes: [entry.summary],
        sourceEvidenceIds: [entry.evidenceId],
      })),
    },
    evidenceRegistry: registry,
  });
  store.commitCompaction(threadId, {
    messages: [{ role: "user", content: "continue" }],
    expectedActiveMessages: store.getMessages(threadId),
    expectedLatestCheckpointId: undefined,
    draft: {
      resources: [],
      runningWork: [],
      toolState: createEmptyCompactionToolState(),
      context: { cwd: dir, stableRuleIds: [], skills: [], explicitSkillNames: [] },
      summary: { status: "fallback", reason: "archived for recovery" },
      constraints: candidate.state.constraints.map((item) => ({
        quote: item.text,
        sourceSequence: item.provenance[0]?.messageSequence ?? 0,
      })),
    },
    semanticState: candidate.state,
    semanticArchiveItems: candidate.archiveItems ?? [],
    semanticEvidenceWatermarks: { messagesThroughSequence: 26, toolExecutionsThroughSequence: -1 },
    evidenceWatermarks: {
      transcriptMessagesThroughSequence: 26,
      toolExecutionsThroughSequence: -1,
    },
    contextRecovery: { unextracted: true },
  });
  let steps = 0;
  let writes = 0;
  const destination = join(dir, "written.txt");
  const client = new Client({ name: "fixture", version: "1" });
  Object.defineProperty(client, "callTool", {
    value: async () => {
      assert.equal(store.getContextRecovery(threadId)?.required, false);
      appendFileSync(destination, "written once\n");
      writes++;
      return { content: [{ type: "text", text: "written" }] };
    },
  });
  const sources = [
    {
      agentName: "fixture",
      client,
      tools: [
        {
          tool: { name: "write", inputSchema: { type: "object" as const, properties: {} } },
          annotations: { destructiveHint: true },
        },
      ],
    },
  ];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      steps += 1;
      const system = JSON.stringify(options.prompt);
      const recovery = store.getContextRecovery(threadId);
      if (recovery?.required) {
        assert.equal(writes, 0);
        assert.equal(existsSync(destination), false);
        assert.deepEqual(
          (options.tools ?? []).map((tool) => tool.name),
          ["roll__context"],
        );
        const coverage = /"remaining":(\d+)/u.exec(system);
        const remaining = Number(coverage?.[1] ?? "1");
        if (remaining > 0) {
          return streamChunks([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: `page-${String(steps)}`,
              toolName: "roll__context",
              input: JSON.stringify({
                action: "read",
                checkpointId: recovery.checkpointId,
                kind: "semantic",
                notes: `page ${String(steps)}`,
              }),
            },
            {
              type: "finish",
              usage: usage(),
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            },
          ]);
        }
        const receipt = /"receipt":"([0-9a-f-]{36})"/u.exec(system)?.[1];
        assert.ok(receipt);
        const sourceRead = !/"kind":"message"/u.test(system);
        return streamChunks([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: sourceRead ? "source" : "ready",
            toolName: "roll__context",
            input: JSON.stringify(
              sourceRead
                ? {
                    action: "read",
                    checkpointId: recovery.checkpointId,
                    kind: "message",
                    itemId: "0000000000000000",
                  }
                : {
                    action: "ready",
                    checkpointId: recovery.checkpointId,
                    receipts: [receipt],
                    goal: "continue",
                    constraints: "keep contracts",
                    nextAction: "edit",
                  },
            ),
          },
          {
            type: "finish",
            usage: usage(),
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]);
      }
      if (writes === 0) {
        assert.ok((options.tools ?? []).some((tool) => tool.name === "fixture__write"));
        return streamChunks([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "write-once", toolName: "fixture__write", input: "{}" },
          {
            type: "finish",
            usage: usage(),
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]);
      }
      return streamChunks(textStep("resumed work"));
    },
  });
  const makeSession = (activeModel: MockLanguageModelV4) =>
    new AgentSession({
      id: threadId,
      model: activeModel,
      sources,
      policy: { check: () => ({ action: "allow" }) },
      maxSteps: 24,
      turnTimeoutMs: 300_000,
      initialMessages: store.getMessages(threadId),
      initialCheckpoint: store.getLatestCheckpoint(threadId)!,
      compaction: {
        enabled: true,
        strategy: "summarize",
        threshold: 0.75,
        keepRecentTurns: 2,
        keepRecentTokens: 100,
      },
      contextStore: recoveryStore(store, threadId),
      onAcceptInput: (inputId, message) => store.acceptTurnInput(threadId, inputId, message),
      onPersist: (messages, options) => store.appendMessages(threadId, messages, options),
      onToolExecution: (record) => store.appendToolExecution(threadId, record),
      listToolExecutions: (options) => store.listToolExecutions(threadId, options),
      onReplace: (messages) => store.replaceMessages(threadId, messages),
      listTranscriptMessages: (options) => store.listTranscriptMessages(threadId, options),
      commitCompaction: (input) => store.commitCompaction(threadId, input),
    });
  const session = makeSession(model);
  const events = [];
  for await (const event of session.send("continue")) events.push(event);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
    JSON.stringify(events),
  );
  assert.ok(steps <= 24);
  assert.ok(steps < 27, "a page read must cover more than one required item");
  assert.equal(writes, 1);
  assert.equal(store.getContextRecovery(threadId)?.required, false);
  assert.ok(
    events.some((event) => event.type === "message-finish" && event.text === "resumed work"),
  );
  await session.close();
  assert.equal(readFileSync(destination, "utf8"), "written once\n");
  store.close();
  store = new ThreadStore(dir);
  const reopened = makeSession(
    new MockLanguageModelV4({
      doStream: async () => streamChunks(textStep("checked existing result")),
    }),
  );
  const reopenedEvents = [];
  for await (const event of reopened.send("Check existing result without repeating it")) {
    reopenedEvents.push(event);
  }
  assert.equal(
    reopenedEvents.some((event) => event.type === "error"),
    false,
  );
  assert.equal(writes, 1);
  assert.equal(readFileSync(destination, "utf8"), "written once\n");
  assert.equal(
    store
      .listToolExecutions(threadId, { limit: 100 })
      .filter((record) => record.toolName === "write" && record.outcome.kind === "success").length,
    1,
  );
  await reopened.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(RECOVERY_PAGE_ITEMS, 9);
});

test("an exhausted read budget continues on the next turn without rereading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-recovery-continue-"));
  const store = new ThreadStore(dir);
  const threadId = store.createThread();
  const messages = Array.from({ length: 27 }, (_, index) => ({
    role: "user" as const,
    content: `Constraint ${String(index)} stays available.`,
  }));
  store.appendMessages(threadId, messages);
  const registry = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: messages.map((message, sequence) => ({
      sequence,
      role: message.role,
      summary: `message ${String(sequence)} user: ${message.content}`,
    })),
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const candidate = validateCompactionModelDraft({
    draft: {
      ...createEmptyCompactionModelDraft(),
      constraints: registry.map((entry) => ({
        priorItemId: null,
        text: entry.summary,
        sourceQuotes: [entry.summary],
        sourceEvidenceIds: [entry.evidenceId],
      })),
    },
    evidenceRegistry: registry,
  });
  const checkpoint = store.commitCompaction(threadId, {
    messages: [{ role: "user", content: "continue" }],
    expectedActiveMessages: store.getMessages(threadId),
    expectedLatestCheckpointId: undefined,
    draft: {
      resources: [],
      runningWork: [],
      toolState: createEmptyCompactionToolState(),
      context: { cwd: dir, stableRuleIds: [], skills: [], explicitSkillNames: [] },
      summary: { status: "fallback", reason: "archived for recovery" },
      constraints: candidate.state.constraints.map((item) => ({
        quote: item.text,
        sourceSequence: item.provenance[0]?.messageSequence ?? 0,
      })),
    },
    semanticState: candidate.state,
    semanticArchiveItems: candidate.archiveItems ?? [],
    semanticEvidenceWatermarks: { messagesThroughSequence: 26, toolExecutionsThroughSequence: -1 },
    evidenceWatermarks: {
      transcriptMessagesThroughSequence: 26,
      toolExecutionsThroughSequence: -1,
    },
    contextRecovery: { unextracted: false },
  });
  const readPages = (label: string) =>
    new MockLanguageModelV4({
      doStream: async () => {
        const recovery = store.getContextRecovery(threadId);
        assert.ok(recovery?.required);
        return streamChunks([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: label,
            toolName: "roll__context",
            input: JSON.stringify({
              action: "read",
              checkpointId: recovery.checkpointId,
              kind: "semantic",
              notes: label,
            }),
          },
          {
            type: "finish",
            usage: usage(),
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]);
      },
    });
  const limited = new AgentSession({
    id: threadId,
    model: readPages("first"),
    sources: [],
    maxSteps: RECOVERY_RESERVED_STEPS + 1,
    turnTimeoutMs: 300_000,
    initialMessages: store.getMessages(threadId),
    initialCheckpoint: checkpoint,
    contextStore: recoveryStore(store, threadId),
    onAcceptInput: (inputId, message) => store.acceptTurnInput(threadId, inputId, message),
    onPersist: (messages, options) => store.appendMessages(threadId, messages, options),
    onToolExecution: (record) => store.appendToolExecution(threadId, record),
    listToolExecutions: (options) => store.listToolExecutions(threadId, options),
    listTranscriptMessages: (options) => store.listTranscriptMessages(threadId, options),
    commitCompaction: (input) => store.commitCompaction(threadId, input),
  });
  const firstEvents = [];
  for await (const event of limited.send("continue")) firstEvents.push(event);
  assert.equal(
    firstEvents.some((event) => event.type === "error"),
    false,
  );
  const covered = store.listContextReadSegments(threadId, checkpoint.id).length;
  assert.equal(covered, RECOVERY_PAGE_ITEMS);
  assert.equal(store.getContextRecovery(threadId)?.required, true);
  assert.match(store.contextRecoveryNotes(threadId, checkpoint.id), /first/u);
  await limited.close();
  const resumed = new AgentSession({
    id: threadId,
    model: readPages("second"),
    sources: [],
    maxSteps: RECOVERY_RESERVED_STEPS + 1,
    turnTimeoutMs: 300_000,
    initialMessages: store.getMessages(threadId),
    initialCheckpoint: store.getLatestCheckpoint(threadId)!,
    contextStore: recoveryStore(store, threadId),
    onAcceptInput: (inputId, message) => store.acceptTurnInput(threadId, inputId, message),
    onPersist: (messages, options) => store.appendMessages(threadId, messages, options),
    onToolExecution: (record) => store.appendToolExecution(threadId, record),
    listToolExecutions: (options) => store.listToolExecutions(threadId, options),
    listTranscriptMessages: (options) => store.listTranscriptMessages(threadId, options),
    commitCompaction: (input) => store.commitCompaction(threadId, input),
  });
  const secondEvents = [];
  for await (const event of resumed.send("continue")) secondEvents.push(event);
  assert.equal(
    secondEvents.some((event) => event.type === "error"),
    false,
  );
  assert.equal(
    store.listContextReadSegments(threadId, checkpoint.id).length,
    RECOVERY_PAGE_ITEMS * 2,
  );
  assert.match(store.contextRecoveryNotes(threadId, checkpoint.id), /second/u);
  await resumed.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
