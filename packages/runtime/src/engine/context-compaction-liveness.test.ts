import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "./agent-session.ts";
import { createEmptyCompactionModelDraft } from "./compaction-semantic-state.ts";
import { projectCompactionCheckpointReminder } from "./compaction-checkpoint.ts";
import { recoveryModelInputs } from "./context-recovery-test-helpers.ts";
import { ThreadStore } from "../store/thread-store.ts";
import { contextReadInputSchema } from "../store/semantic-ledger.ts";

const evidenceSchema = z.object({
  evidence: z.array(z.object({ evidenceId: z.string(), summary: z.string() })),
});

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// Every round enters through the real AgentSession maintenance path. No test
// callback substitutes an empty history or invents a successful checkpoint.
for (let seed = 1; seed <= 32; seed++) {
  test(`production maintenance liveness and recoverability: 24 rounds, seed ${seed}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-production-liveness-"));
    let store = new ThreadStore(dir);
    const id = store.createThread();
    let rng = seed;
    const random = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296;
    const expected = new Map<string, string>();
    const archive = new Map<string, string>();
    let generated = 0;
    let successfulExtractions = 0;
    const generatedModes = new Set<string>();
    let recoveredRounds = 0;
    let reopened = 0;
    try {
      for (let round = 0; round < 24; round++) {
        if (round > 0 && round % 4 === 0) {
          store.close();
          store = new ThreadStore(dir);
          reopened++;
        }
        const firstSequence = store.countTranscriptMessages(id);
        const sourceId = String(firstSequence).padStart(16, "0");
        const facts = Array.from({ length: 20 }, (_, index) => {
          const key = `FACT_${seed}_${round}_${index}`;
          const text = `${key}: preserve /project/${index}/item-${round}; result=${Math.floor(random() * 100000)}. ${"detail ".repeat(43)}`;
          expected.set(key, text);
          return { role: "user" as const, content: text };
        });
        store.appendMessages(id, [
          ...facts,
          ...Array.from({ length: 24 }, () => ({
            role: "assistant" as const,
            content: "Routine inspection; no new requirements. ".repeat(130),
          })),
        ]);
        const before = JSON.stringify(store.getMessages(id)).length;
        let dispatched = 0;
        const recover = recoveryModelInputs();
        const category = (["constraints", "pendingWork", "uncertainties"] as const)[seed % 3]!;
        // Randomized failure schedule, with enough successful rounds to exceed
        // both the category count and 128 KiB unbounded semantic data boundaries.
        const mode = round % 6 === 4 ? "timeout" : round % 6 === 5 ? "invalid" : "valid";
        const model = new MockLanguageModelV4({
          doGenerate: async (params) => {
            generated++;
            generatedModes.add(mode);
            if (mode === "timeout") throw new DOMException("injected deadline", "TimeoutError");
            const prompt = params.prompt
              .flatMap((m) =>
                m.role === "user"
                  ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : []))
                  : [],
              )
              .join("\n");
            const json = /<harness-evidence>\n([\s\S]+)\n<\/harness-evidence>/.exec(prompt)?.[1];
            assert.ok(json);
            const entries = evidenceSchema.parse(JSON.parse(json)).evidence;
            const claim = (e: (typeof entries)[number]) => ({
              priorItemId: null,
              text: e.summary.slice(0, 350),
              sourceQuotes: [e.summary.length <= 512 ? e.summary : e.summary.split("\n")[0]!],
              sourceEvidenceIds: [e.evidenceId],
            });
            const facts = entries
              .filter((e) => /^message \d+ user: FACT_/.test(e.summary))
              .map(claim);
            const other = entries
              .filter(
                (e) => !/^message \d+ (?:assistant:|user: FACT_|user: Continue)/.test(e.summary),
              )
              .map(claim);
            const draft = {
              ...createEmptyCompactionModelDraft(),
              [category]: facts,
              uncertainties: category === "uncertainties" ? [...facts, ...other] : other,
              evidenceReviews: entries.map((e) => ({
                evidenceId: e.evidenceId,
                disposition: /^message \d+ (?:assistant:|user: Continue)/.test(e.summary)
                  ? "irrelevant"
                  : "reviewed",
                reason: "Inspected whole supplied evidence",
              })),
            };
            return {
              content: [
                { type: "text", text: mode === "invalid" ? "not JSON" : JSON.stringify(draft) },
              ],
              usage,
              warnings: [],
              finishReason: { unified: "stop", raw: "stop" },
            };
          },
          doStream: async (params) => {
            dispatched++;
            const recovery = store.getContextRecovery(id);
            const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
            if (recovery?.required) {
              assert.deepEqual(
                params.tools?.map((t) => t.name),
                ["roll__context"],
              );
              for (const [index, input] of recover(params, recovery, sourceId).entries()) {
                chunks.push({
                  type: "tool-call",
                  toolName: "roll__context",
                  toolCallId: `r-${round}-${dispatched}-${index}`,
                  input: JSON.stringify(input),
                });
              }
            }
            chunks.push({
              type: "finish",
              usage,
              finishReason: { unified: recovery?.required ? "tool-calls" : "stop", raw: "stop" },
            });
            return {
              stream: simulateReadableStream({
                chunks,
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            };
          },
        });
        const checkpoint = store.getLatestCheckpoint(id);
        const session = new AgentSession({
          id,
          model,
          sources: [],
          maxSteps: 64,
          contextWindow: 32768,
          debugEvents: true,
          initialMessages: store.getMessages(id),
          ...(checkpoint ? { initialCheckpoint: checkpoint } : {}),
          compaction: {
            enabled: true,
            strategy: "summarize",
            threshold: 0.75,
            keepRecentTurns: 1,
            keepRecentTokens: 1,
            maxOutputTokens: 2048,
          },
          contextStore: {
            read: (input) => store.readContext(id, input),
            readTransaction: (read) => store.withContextReadTransaction(read),
            recovery: () => store.getContextRecovery(id),
            ready: (cp, memo) => store.completeContextRecovery(id, cp, memo),
            rows: () => store.getSemanticLedgerRows(id),
            recordSegment: (segment) => store.recordContextReadSegment(id, segment),
            segments: (checkpointId) => store.listContextReadSegments(id, checkpointId),
            notes: (checkpointId) => store.contextRecoveryNotes(id, checkpointId),
            saveNotes: (checkpointId, notes) =>
              store.saveContextRecoveryNotes(id, checkpointId, notes),
          },
          onAcceptInput: (inputId, message) => store.acceptTurnInput(id, inputId, message),
          onPersist: (messages, options) => store.appendMessages(id, messages, options),
          onReplace: (messages) => store.replaceMessages(id, messages),
          onToolExecution: (record) => store.appendToolExecution(id, record),
          listTranscriptMessages: (options) => store.listTranscriptMessages(id, options),
          listToolExecutions: (options) => store.listToolExecutions(id, options),
          commitCompaction: (input) => {
            const cp = store.commitCompaction(id, input);
            if (input.draft.summary.status === "valid") successfulExtractions++;
            for (const entry of input.semanticArchiveItems ?? []) {
              if ("text" in entry.item) archive.set(entry.item.id, entry.item.text);
            }
            return cp;
          },
        });
        try {
          const events = [];
          if (round % 3 === 0) for await (const event of session.compact()) events.push(event);
          for await (const event of session.send("Continue")) events.push(event);
          assert.deepEqual(
            events.filter((e) => e.type === "error"),
            [],
            `seed=${seed} round=${round} mode=${mode}`,
          );
          const budget = session.getRequestBudgetState().last;
          assert.ok(budget && budget.calibratedInputEstimate <= budget.availableInputCeiling!);
          assert.ok(dispatched > 0);
          assert.ok(
            JSON.stringify(store.getMessages(id)).length < before ||
              budget.calibratedInputEstimate <= budget.availableInputCeiling!,
          );
          const cp = store.getLatestCheckpoint(id)!;
          assert.ok(
            projectCompactionCheckpointReminder(cp, undefined, undefined, "roll__context").text
              .length <= 8000,
          );
          assert.ok(
            cp.version === 2 && Buffer.byteLength(JSON.stringify(cp.semanticState)) <= 128 * 1024,
          );
          assert.equal(store.getContextRecovery(id)?.required, false);
          recoveredRounds++;
          // Production commit's entire validated archive survives beyond state caps.
          const rows = new Map(
            store.getSemanticLedgerRows(id).map((row) => [row.item_id, row.item_json]),
          );
          for (const [itemId, text] of archive) {
            assert.ok(rows.get(itemId)?.includes(JSON.stringify(text).slice(1, -1)));
          }
        } finally {
          await session.close();
        }
      }
      assert.ok(
        generated > 0 && successfulExtractions > 0,
        JSON.stringify({ generated, successfulExtractions, archiveSize: archive.size }),
      );
      // Full recovery reads may make later evidence hit the serialized input cap.
      // A bounded fallback is valid; count real recoveries and verify every fact
      // below instead of requiring an implementation-specific number of LLM calls.
      assert.deepEqual([...generatedModes].sort(), ["invalid", "timeout", "valid"]);
      assert.equal(recoveredRounds, 24);
      assert.equal(reopened, 5);
      assert.ok(
        archive.size > 128 &&
          Buffer.byteLength(JSON.stringify(store.getSemanticLedgerRows(id))) > 128 * 1024,
      );
      const cp = store.getLatestCheckpoint(id)!;
      const discovered = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = store.readContext(
          id,
          contextReadInputSchema.parse({ checkpointId: cp.id, cursor }),
        );
        for (const entry of page.entries) {
          discovered.add(entry.id);
          let offset = 0;
          let full = "";
          do {
            const part = store.readContext(
              id,
              contextReadInputSchema.parse({ checkpointId: cp.id, itemId: entry.id, offset }),
            );
            full += part.entries[0]!.content;
            offset = part.nextOffset ?? 0;
          } while (offset);
          const text = archive.get(entry.id);
          if (text) {
            assert.ok(full.includes(JSON.stringify(text).slice(1, -1)) || full.includes(text));
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      for (const id of archive.keys()) assert.ok(discovered.has(id));
      // Invalid/timeout summaries still retain every original fact, with bounded
      // pages/chunks rather than assuming that "it is somewhere in SQLite".
      for (const [key, text] of expected) {
        const found = store.readContext(
          id,
          contextReadInputSchema.parse({ checkpointId: cp.id, kind: "message", query: key }),
        );
        assert.ok(found.entries.length > 0);
        const read = store.readContext(
          id,
          contextReadInputSchema.parse({
            checkpointId: cp.id,
            kind: "message",
            itemId: found.entries[0]!.id,
          }),
        );
        assert.ok(read.entries[0]!.content.includes(text));
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
