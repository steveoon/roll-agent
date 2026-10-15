import { test } from "node:test";
import type { ModelMessage } from "ai";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ThreadStore, type CommitCompactionInput } from "../store/thread-store.ts";
import { createEmptyCompactionToolState } from "../engine/compaction-checkpoint.ts";
import {
  buildCompactionSemanticEvidenceRegistry,
  createEmptyCompactionModelDraft,
  createEmptyCompactionSemanticState,
  validateCompactionModelDraft,
} from "../engine/compaction-semantic-state.ts";
import { createToolExecutionRecord } from "./tool-execution-record.ts";
import { successfulToolResult, type NormalizedToolResult } from "./normalize-result.ts";
import {
  ContextRecoveryGate,
  contextToolInputSchema,
  omitEarlierContextReads,
} from "./context-tool.ts";

function fixture(count = 24, withGoal = false) {
  const dir = mkdtempSync(join(tmpdir(), "roll-recovery-coverage-"));
  let store = new ThreadStore(dir);
  const id = store.createThread();
  const messages = Array.from({ length: count }, (_, sequence) => ({
    role: "user" as const,
    content: `Constraint ${sequence}: preserve contract ${sequence}. ${"Keep this requirement. ".repeat(18)}`,
  }));
  store.appendMessages(id, messages);
  const registry = buildCompactionSemanticEvidenceRegistry({
    messages: messages.map((m, sequence) => ({
      sequence,
      role: m.role,
      summary: `message ${sequence} user: ${m.content}`,
    })),
    toolExecutions: [],
    resources: [],
    runningSessions: [],
    fullSources: true,
  });
  const candidate = validateCompactionModelDraft({
    evidenceRegistry: registry,
    draft: {
      ...createEmptyCompactionModelDraft(),
      goal: withGoal
        ? {
            priorItemId: null,
            text: registry[0]!.summary,
            sourceQuotes: [registry[0]!.summary],
            sourceEvidenceIds: [registry[0]!.evidenceId],
          }
        : null,
      constraints: registry.map((e) => ({
        priorItemId: null,
        text: e.summary,
        sourceQuotes: [e.summary],
        sourceEvidenceIds: [e.evidenceId],
      })),
    },
  });
  const commitInput: CommitCompactionInput = {
    expectedActiveMessages: store.getMessages(id),
    expectedLatestCheckpointId: undefined,
    messages: [],
    semanticState: candidate.state,
    semanticArchiveItems: candidate.archiveItems ?? [],
    draft: {
      ...(candidate.state.goal
        ? {
            goal: {
              verbatimRequest: candidate.state.goal.text,
              sourceSequence: 0,
              status: "active" as const,
            },
          }
        : {}),
      constraints: candidate.state.constraints.map((item) => ({
        quote: item.text,
        sourceSequence: item.provenance[0]!.messageSequence!,
      })),
      resources: [],
      runningWork: [],
      toolState: createEmptyCompactionToolState(),
      context: { cwd: dir, stableRuleIds: [], skills: [], explicitSkillNames: [] },
      summary: { status: "skipped" },
    },
    semanticEvidenceWatermarks: {
      messagesThroughSequence: count - 1,
      toolExecutionsThroughSequence: -1,
    },
    evidenceWatermarks: {
      transcriptMessagesThroughSequence: count - 1,
      toolExecutionsThroughSequence: -1,
    },
    contextRecovery: { unextracted: false },
  };
  const cp = store.commitCompaction(id, commitInput);
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
  return {
    backend,
    cp,
    items: candidate.state.constraints,
    goal: candidate.state.goal,
    advance: () => {
      store.appendMessages(id, [messages[0]!]);
      const state = {
        ...candidate.state,
        constraints: candidate.state.constraints.map((item, index) =>
          index === 0
            ? {
                ...item,
                provenance: [
                  ...item.provenance,
                  { ...item.provenance[0]!, messageSequence: count },
                ],
              }
            : item,
        ),
      };
      return store.commitCompaction(id, {
        ...commitInput,
        expectedActiveMessages: store.getMessages(id),
        expectedLatestCheckpointId: cp.id,
        semanticState: state,
        semanticArchiveItems: state.constraints.map((item) => ({ category: "constraint", item })),
        evidenceWatermarks: {
          transcriptMessagesThroughSequence: count,
          toolExecutionsThroughSequence: -1,
        },
      });
    },
    reopen: () => {
      store.close();
      store = new ThreadStore(dir);
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function read(gate: ContextRecoveryGate, checkpointId: string, itemId: string, version?: number) {
  return gate.execute(
    contextToolInputSchema.parse({ action: "read", checkpointId, itemId, version }),
  );
}
function ready(gate: ContextRecoveryGate, checkpointId: string, receipt: string) {
  return gate.execute(
    contextToolInputSchema.parse({
      action: "ready",
      checkpointId,
      receipts: [receipt],
      goal: "continue implementation",
      constraints: "preserve all contracts",
      nextAction: "edit code",
    }),
  );
}

test("failed recovery page cannot cover undelivered items or unlock ready on retry", () => {
  const f = fixture(2);
  try {
    const originalRead = f.backend.read;
    let reads = 0;
    f.backend.read = (input) => {
      if (input.itemId && ++reads === 2) throw new Error("injected second read failure");
      return originalRead(input);
    };
    const gate = new ContextRecoveryGate(f.backend);
    const failed = gate.execute(
      contextToolInputSchema.parse({ action: "read", checkpointId: f.cp.id }),
    );
    assert.equal(failed.isError, true);
    assert.deepEqual(f.backend.segments(f.cp.id), [], "failed page must not commit coverage");
    assert.equal(gate.coverageRemaining(), 2);
    f.backend.read = originalRead;
    const receipt = z
      .object({ receipt: z.string() })
      .parse(read(gate, f.cp.id, f.items[1]!.id).raw).receipt;
    assert.equal(ready(gate, f.cp.id, receipt).isError, true);
    assert.equal(gate.coverageRemaining(), 1);
    read(gate, f.cp.id, f.items[0]!.id);
    assert.equal(ready(gate, f.cp.id, receipt).isError, false);
  } finally {
    f.close();
  }
});

for (const fault of ["metadata", "write", "coverage", "notes", "completion"] as const) {
  test(`recovery read rolls back ${fault} failure without losing earlier successful evidence`, () => {
    const f = fixture(3);
    try {
      const gate = new ContextRecoveryGate(f.backend);
      const first = read(gate, f.cp.id, f.items[0]!.id);
      const receipt = z.object({ receipt: z.string() }).parse(first.raw).receipt;
      f.backend.saveNotes(f.cp.id, "earlier successful notes");
      gate.refresh();
      const priorSegments = f.backend.segments(f.cp.id);
      const priorReminder = gate.reminder();
      const original = { ...f.backend };
      let wrote = false;
      f.backend.read = (input) => {
        if (fault === "metadata" && !input.itemId) throw new Error("metadata fault");
        return original.read(input);
      };
      f.backend.recordSegment = (segment) => {
        original.recordSegment(segment);
        wrote = true;
        if (fault === "write") throw new Error("write fault after mutation");
      };
      f.backend.segments = (checkpointId) => {
        if (fault === "coverage" && wrote) throw new Error("coverage fault after receipt creation");
        return original.segments(checkpointId);
      };
      f.backend.saveNotes = (checkpointId, notes) => {
        original.saveNotes(checkpointId, notes);
        if (fault === "notes") throw new Error("notes fault after mutation");
      };
      f.backend.readTransaction = (work) =>
        original.readTransaction(() => {
          const result = work();
          if (fault === "completion") throw new Error("transaction completion fault");
          return result;
        });
      const failed = gate.execute(
        contextToolInputSchema.parse({
          action: "read",
          checkpointId: f.cp.id,
          notes: "must roll back",
        }),
      );
      assert.equal(failed.isError, true);
      Object.assign(f.backend, original);
      assert.deepEqual(f.backend.segments(f.cp.id), priorSegments);
      assert.equal(f.backend.notes(f.cp.id), "earlier successful notes");
      assert.equal(
        gate.reminder(),
        priorReminder,
        "receipts, offsets and notes must roll back too",
      );
      assert.equal(ready(gate, f.cp.id, receipt).isError, true);
      f.reopen();
      assert.deepEqual(f.backend.segments(f.cp.id), priorSegments);
      assert.equal(f.backend.notes(f.cp.id), "earlier successful notes");
      gate.beginTurn();
      const retried = gate.execute(
        contextToolInputSchema.parse({ action: "read", checkpointId: f.cp.id }),
      );
      const page = z
        .object({ entries: z.array(z.object({ id: z.string() })), receipt: z.string() })
        .parse(retried.raw);
      assert.deepEqual(
        new Set(page.entries.map((entry) => entry.id)),
        new Set(f.items.slice(1).map((item) => item.id)),
      );
      assert.equal(ready(gate, f.cp.id, page.receipt).isError, false);
    } finally {
      f.close();
    }
  });
}

test("failed single and paged chunk reads restore contiguous offsets", () => {
  for (const paged of [false, true]) {
    const f = fixture(1);
    try {
      const original = { ...f.backend };
      const offsets: number[] = [];
      f.backend.read = (input) => {
        offsets.push(input.offset);
        return { ...original.read(input), nextOffset: input.offset + 12_000 };
      };
      const gate = new ContextRecoveryGate(f.backend);
      const request = contextToolInputSchema.parse({
        action: "read",
        checkpointId: f.cp.id,
        ...(paged ? {} : { itemId: f.items[0]!.id }),
      });
      let wrote = false;
      f.backend.recordSegment = (segment) => {
        original.recordSegment(segment);
        wrote = true;
      };
      f.backend.segments = (checkpointId) => {
        if (wrote) throw new Error("failure after advancing chunk offset");
        return original.segments(checkpointId);
      };
      assert.equal(gate.execute(request).isError, true);
      f.backend.recordSegment = original.recordSegment;
      f.backend.segments = original.segments;
      assert.deepEqual(original.segments(f.cp.id), []);
      assert.equal(gate.execute(request).isError, false);
      assert.deepEqual(offsets, [0, 0], "retry must re-deliver the failed chunk");
      assert.equal(gate.coverageRemaining(), 1, "partial chunk cannot complete an item");
    } finally {
      f.close();
    }
  }
});

test("ready cannot unlock 24 constraints after only one completed read", () => {
  const f = fixture();
  try {
    const gate = new ContextRecoveryGate(f.backend);
    const one = read(gate, f.cp.id, f.items[0]!.id);
    const receipt = z.object({ receipt: z.string() }).parse(one.raw).receipt;
    const result = ready(gate, f.cp.id, receipt);
    assert.equal(
      result.isError,
      true,
      "a valid but unrelated/incomplete receipt must not unlock writes",
    );
    assert.equal(f.backend.recovery()?.required, true);
  } finally {
    f.close();
  }
});

test("raw reads, previews and old semantic versions do not cover current required constraints", () => {
  const f = fixture(2);
  try {
    const cp = f.advance();
    const gate = new ContextRecoveryGate(f.backend);
    const raw = gate.execute(
      contextToolInputSchema.parse({
        action: "read",
        checkpointId: cp.id,
        kind: "message",
        itemId: "0000000000000000",
      }),
    );
    const rawReceipt = z.object({ receipt: z.string() }).parse(raw.raw).receipt;
    gate.execute(contextToolInputSchema.parse({ action: "list", checkpointId: cp.id }));
    assert.equal(ready(gate, cp.id, rawReceipt).isError, true);
    const old = z
      .object({ receipt: z.string() })
      .parse(read(gate, cp.id, f.items[0]!.id, 1).raw).receipt;
    const latest = z
      .object({ receipt: z.string() })
      .parse(read(gate, cp.id, f.items[1]!.id).raw).receipt;
    assert.equal(ready(gate, cp.id, old).isError, true, "version 1 cannot cover version 2");
    assert.equal(ready(gate, cp.id, latest).isError, true, "all current versions must be covered");
    read(gate, cp.id, f.items[0]!.id, 2);
    assert.equal(ready(gate, cp.id, latest).isError, false);
  } finally {
    f.close();
  }
});

test("coverage survives bounded prompt history but read authorization expires on restart", () => {
  const f = fixture();
  try {
    const before = new ContextRecoveryGate(f.backend);
    const old = z
      .object({ receipt: z.string() })
      .parse(read(before, f.cp.id, f.items[0]!.id).raw).receipt;
    f.reopen();
    const gate = new ContextRecoveryGate(f.backend);
    assert.equal(ready(gate, f.cp.id, old).isError, true);
    let receipt = "";
    for (const item of f.items) {
      receipt = z.object({ receipt: z.string() }).parse(read(gate, f.cp.id, item.id).raw).receipt;
    }
    assert.equal(
      ready(gate, f.cp.id, receipt).isError,
      false,
      "more than 20 required reads can complete without resubmitting every receipt",
    );
    assert.equal(f.backend.recovery()?.required, false);
  } finally {
    f.close();
  }
});

test("completed pages survive reopen and one receipt still cannot finish 22 items", () => {
  const f = fixture(22);
  try {
    const first = new ContextRecoveryGate(f.backend);
    const page = first.execute(
      contextToolInputSchema.parse({
        action: "read",
        checkpointId: f.cp.id,
        kind: "semantic",
        notes: "kept fact 17",
      }),
    );
    const coverage = z
      .object({
        coverage: z.object({
          remaining: z.number(),
          nextRequiredItems: z.array(z.unknown()),
        }),
      })
      .parse(page.raw);
    assert.equal(coverage.coverage.remaining, 13);
    assert.ok(coverage.coverage.nextRequiredItems.length <= 9);
    const stale = z.object({ receipt: z.string() }).parse(page.raw).receipt;
    f.reopen();
    const gate = new ContextRecoveryGate(f.backend);
    assert.equal(ready(gate, f.cp.id, stale).isError, true);
    assert.match(gate.reminder() ?? "", /kept fact 17/u);
    assert.equal(f.backend.segments(f.cp.id).filter((segment) => segment.finished).length, 9);
    let receipt = "";
    for (let step = 0; step < 4 && gate.coverageRemaining() > 0; step += 1) {
      receipt = z.object({ receipt: z.string() }).parse(
        gate.execute(
          contextToolInputSchema.parse({
            action: "read",
            checkpointId: f.cp.id,
            kind: "semantic",
          }),
        ).raw,
      ).receipt;
    }
    assert.equal(gate.coverageRemaining(), 0);
    assert.equal(ready(gate, f.cp.id, receipt).isError, false);
    assert.equal(JSON.stringify(gate.reminder() ?? "").includes(f.items[0]!.text), false);
  } finally {
    f.close();
  }
});

test("reading every constraint still cannot omit the current goal", () => {
  const f = fixture(1, true);
  try {
    const gate = new ContextRecoveryGate(f.backend);
    const receipt = z
      .object({ receipt: z.string() })
      .parse(read(gate, f.cp.id, f.items[0]!.id).raw).receipt;
    assert.equal(ready(gate, f.cp.id, receipt).isError, true);
    assert.ok(f.goal);
    read(gate, f.cp.id, f.goal.id);
    assert.equal(ready(gate, f.cp.id, receipt).isError, false);
  } finally {
    f.close();
  }
});

for (const kind of ["message", "tool_execution"] as const) {
  test(`${kind} chunk coverage survives SQLite reopen at every page`, () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-raw-read-reopen-"));
    let store = new ThreadStore(dir);
    const id = store.createThread();
    store.appendMessages(id, [{ role: "user", content: "A".repeat(12_500) }]);
    store.appendToolExecution(
      id,
      createToolExecutionRecord({
        toolCallId: "long-result",
        agentName: "fixture",
        toolName: "read",
        input: {},
        result: successfulToolResult("B".repeat(12_500)),
        createdAt: new Date().toISOString(),
      }),
    );
    const cp = store.commitCompaction(id, {
      messages: [],
      expectedActiveMessages: store.getMessages(id),
      expectedLatestCheckpointId: undefined,
      draft: {
        constraints: [],
        resources: [],
        runningWork: [],
        toolState: createEmptyCompactionToolState(),
        context: { cwd: dir, stableRuleIds: [], skills: [], explicitSkillNames: [] },
        summary: { status: "skipped" },
      },
      semanticState: createEmptyCompactionSemanticState(),
      semanticEvidenceWatermarks: {
        messagesThroughSequence: -1,
        toolExecutionsThroughSequence: -1,
      },
      evidenceWatermarks: {
        transcriptMessagesThroughSequence: 0,
        toolExecutionsThroughSequence: 0,
      },
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
    try {
      let gate = new ContextRecoveryGate(backend);
      const input = (offset: number) =>
        contextToolInputSchema.parse({
          action: "read",
          checkpointId: cp.id,
          kind,
          itemId: "0000000000000000",
          offset,
        });
      assert.equal(
        gate.execute(input(6000)).isError,
        true,
        "skipping the first page cannot certify coverage",
      );
      assert.equal(backend.segments(cp.id).length, 0);
      let offset = 0;
      let receipt: string | undefined;
      const expectedOffsets: number[] = [];
      do {
        const result = gate.execute(input(offset));
        assert.equal(result.isError, false, JSON.stringify(result.raw));
        const page = z
          .object({ nextOffset: z.number().optional(), receipt: z.string().optional() })
          .parse(result.raw);
        expectedOffsets.push(offset);
        assert.deepEqual(
          backend.segments(cp.id).map((segment) => segment.offset),
          expectedOffsets,
        );
        if (page.nextOffset === undefined) {
          receipt = page.receipt;
          break;
        }
        assert.equal(page.receipt, undefined);
        offset = page.nextOffset;
        store.close();
        store = new ThreadStore(dir);
        gate = new ContextRecoveryGate(backend);
        gate.beginTurn();
      } while (offset < 100_000);
      assert.ok(expectedOffsets.length >= 3);
      assert.ok(receipt, "finishing after restart must produce a valid receipt");
      assert.equal(ready(gate, cp.id, receipt).isError, false);
      assert.equal(backend.recovery()?.required, false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("ready persists final notes across reopen and refuses to unlock on a failed save", () => {
  const f = fixture(1);
  try {
    let failSave = false;
    const backend = {
      ...f.backend,
      saveNotes: (id: string, notes: string) => {
        if (failSave) throw new Error("disk write failed");
        f.backend.saveNotes(id, notes);
      },
    };
    const gate = new ContextRecoveryGate(backend);
    const result = read(gate, f.cp.id, f.items[0]!.id);
    const receipt = z.object({ receipt: z.string() }).parse(result.raw).receipt;
    const input = contextToolInputSchema.parse({
      action: "ready",
      checkpointId: f.cp.id,
      receipts: [receipt],
      goal: "continue",
      constraints: "preserve contract",
      nextAction: "implement",
      notes: "FINAL_PAGE_UNIQUE_FACT_1739",
    });
    failSave = true;
    assert.equal(gate.execute(input).isError, true);
    assert.equal(gate.required, true);
    assert.equal(gate.retainedReadContext(), undefined);
    assert.equal(f.backend.notes(f.cp.id), "");
    failSave = false;
    assert.equal(gate.execute(input).isError, false);
    f.reopen();
    const reopened = new ContextRecoveryGate(f.backend);
    assert.equal(reopened.required, false);
    assert.match(reopened.reminder() ?? "", /FINAL_PAGE_UNIQUE_FACT_1739/u);
    assert.equal(f.backend.notes(f.cp.id), "FINAL_PAGE_UNIQUE_FACT_1739");
  } finally {
    f.close();
  }
});

test("failed notes save cannot certify a read whose body was never returned", () => {
  const f = fixture(2);
  try {
    const gate = new ContextRecoveryGate({
      ...f.backend,
      saveNotes: () => {
        throw new Error("disk full");
      },
    });
    const first = read(gate, f.cp.id, f.items[0]!.id);
    const receipt = z.object({ receipt: z.string() }).parse(first.raw).receipt;
    const second = gate.execute(
      contextToolInputSchema.parse({
        action: "read",
        checkpointId: f.cp.id,
        itemId: f.items[1]!.id,
        notes: "first page notes",
      }),
    );
    assert.equal(second.isError, true);
    assert.equal(f.backend.segments(f.cp.id).length, 1);
    assert.equal(gate.coverageRemaining(), 1);
    assert.equal(ready(gate, f.cp.id, receipt).isError, true);
  } finally {
    f.close();
  }
});

test("escaped recovery pages stay within model output limits before coverage is recorded", () => {
  const f = fixture(9);
  try {
    const gate = new ContextRecoveryGate({
      ...f.backend,
      read: (input) => {
        const page = f.backend.read(input);
        // Valid serialized evidence may expand again when embedded in a tool result.
        return {
          ...page,
          entries: page.entries.map((entry) => ({
            ...entry,
            content: JSON.stringify({ body: '"'.repeat(2600) }),
          })),
        };
      },
    });
    const result = gate.execute(
      contextToolInputSchema.parse({ action: "read", checkpointId: f.cp.id }),
    );
    assert.equal(result.isError, false);
    assert.equal(
      result.model.type,
      "json",
      "a clipped text output must never certify omitted entries",
    );
    if (result.model.type !== "json") assert.fail("expected an intact JSON result");
    const model = z
      .object({ entries: z.array(z.object({ id: z.string() })) })
      .parse(result.model.value);
    assert.ok(model.entries.length > 0 && model.entries.length < 9);
    assert.deepEqual(
      f.backend
        .segments(f.cp.id)
        .map((segment) => segment.itemId)
        .sort(),
      model.entries.map((entry) => entry.id).sort(),
    );
    assert.equal(gate.coverageRemaining(), 9 - model.entries.length);
    assert.ok(JSON.stringify(result.model.value).length < 60_000);
  } finally {
    f.close();
  }
});

test("ready with saved notes removes the final recovery page but preserves ordinary recall", () => {
  const f = fixture(1);
  try {
    const gate = new ContextRecoveryGate(f.backend);
    const round = (id: string, result: NormalizedToolResult): ModelMessage[] => [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: "roll__context", input: {} }],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: id, toolName: "roll__context", output: result.model },
        ],
      },
    ];
    const page = read(gate, f.cp.id, f.items[0]!.id);
    const messages = round("read", page);
    assert.deepEqual(omitEarlierContextReads(messages, gate.retainedReadContext()), messages);
    const receipt = z.object({ receipt: z.string() }).parse(page.raw).receipt;
    const finished = gate.execute(
      contextToolInputSchema.parse({
        action: "ready",
        checkpointId: f.cp.id,
        receipts: [receipt],
        goal: "continue",
        constraints: "retain all",
        nextAction: "implement",
        notes: "Keep the requirement from the final page.",
      }),
    );
    assert.equal(finished.isError, false);
    const recalled = read(gate, f.cp.id, f.items[0]!.id);
    const tail = [...round("ready", finished), ...round("ordinary", recalled)];
    assert.deepEqual(
      omitEarlierContextReads([...messages, ...tail], gate.retainedReadContext()),
      tail,
    );
  } finally {
    f.close();
  }
});
