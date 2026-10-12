import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { compactMessages, compactionEvidenceTokenBudget } from "./compactor.ts";
import {
  buildCompactionSemanticEvidenceRegistry,
  buildCompactionSemanticModelContext,
  createEmptyCompactionModelDraft,
  validateCompactionModelDraft,
} from "./compaction-semantic-state.ts";

test("packing subtracts real output schema, provider options and output reservation", async () => {
  const base = { model: new MockLanguageModelV4({}), contextWindow: 20_000, maxOutputTokens: 8192 };
  const budget = await compactionEvidenceTokenBudget(base);
  assert.ok(budget !== undefined && budget > 1000 && budget < 11_408);
  const smaller = await compactionEvidenceTokenBudget({
    ...base,
    structuredOutputProviderOptions: { test: { note: "x".repeat(3500) } },
  });
  assert.ok(smaller !== undefined && smaller < budget - 999);
  assert.equal(await compactionEvidenceTokenBudget({ model: base.model }), undefined);
  await assert.rejects(
    compactionEvidenceTokenBudget({ ...base, contextWindow: 8192 }),
    /evidence_unpresentable/,
  );
});

test("verbatim multi-sentence facts are admitted without admitting mid-sentence fragments", () => {
  const source =
    "archive\n".repeat(100) +
    "Do not replay unknown outcomes. Retry only known failures. Keep input immutable.\n";
  const registry = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: [{ sequence: 0, role: "user", summary: source }],
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  const id = registry[0]!.evidenceId;
  for (const [quote, valid] of [
    ["Do not replay unknown outcomes. Retry only known failures. Keep input immutable.", true],
    ["Do not replay unknown outcomes. Retry only known failures.", true],
    ["Retry only known failures. Keep input immutable.", true],
    ["replay unknown outcomes.", false],
    ["Retry only known", false],
    ["Do not replay unknown outcomes.  Retry only known failures.", false],
  ] as const) {
    const candidate = validateCompactionModelDraft({
      evidenceRegistry: registry,
      presentedEvidenceIds: [id],
      draft: {
        ...createEmptyCompactionModelDraft(),
        constraints: [
          { priorItemId: null, text: "label", sourceEvidenceIds: [id], sourceQuotes: [quote] },
        ],
        evidenceReviews: [{ evidenceId: id, disposition: "reviewed", reason: "Complete" }],
      },
    });
    assert.equal(candidate.state.constraints.length, valid ? 1 : 0, quote);
    assert.deepEqual(candidate.coveredEvidenceIds, valid ? [id] : [], quote);
    if (valid) assert.equal(candidate.state.constraints[0]?.text, quote);
  }
});

for (const fragment of ["inspection ", "检查记录", "🧪", '\\"\n']) {
  test(`summary packing budgets complete UTF-8 evidence: ${JSON.stringify(fragment)}`, () => {
    const messages = Array.from({ length: 40 }, (_, sequence) => ({
      sequence,
      role: "assistant",
      summary: `${sequence}\n${fragment.repeat(1800)}\nNever replay outcome_unknown.`,
    }));
    const registry = buildCompactionSemanticEvidenceRegistry({
      fullSources: true,
      messages,
      toolExecutions: [],
      resources: [],
      runningSessions: [],
    });
    const context = buildCompactionSemanticModelContext(
      registry,
      undefined,
      1_000_000,
      undefined,
      96_000,
    );
    const payload = z
      .object({
        evidence: z.array(
          z.object({
            evidenceId: z.string(),
            summary: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(context.prompt));
    assert.ok(Math.ceil(Buffer.byteLength(context.prompt) / 3.5) <= 96_000);
    assert.ok(payload.evidence.length > 10, "a token budget must not become a character budget");
    assert.ok(payload.evidence.length <= 32);
    for (const [index, entry] of payload.evidence.entries()) {
      assert.equal(entry.summary, messages[index]?.summary, "never clip an admitted source");
      assert.equal(entry.evidenceId, context.includedEvidenceIds[index]);
    }
  });
}

test("an oversized mandatory source is retained rather than clipped to the token allowance", () => {
  const registry = buildCompactionSemanticEvidenceRegistry({
    fullSources: true,
    messages: [{ sequence: 0, role: "user", summary: "重要事实".repeat(1000) }],
    toolExecutions: [],
    resources: [],
    runningSessions: [],
  });
  assert.throws(
    () => buildCompactionSemanticModelContext(registry, undefined, 1_000_000, undefined, 1000),
    /evidence_unpresentable/,
  );
});

for (const cause of ["output reserve", "provider options"] as const) {
  test(`summary final SDK guard counts ${cause} before dispatch`, async () => {
    let dispatched = false;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        dispatched = true;
        throw new Error("must not dispatch an oversized summary request");
      },
    });
    await assert.rejects(
      compactMessages({
        model,
        messages: [
          { role: "user", content: "Earlier requirements." },
          { role: "assistant", content: "Earlier inspection." },
          { role: "user", content: "Continue." },
        ],
        strategy: "summarize",
        keepRecentTurns: 1,
        keepRecentTokens: 1,
        contextWindow: cause === "output reserve" ? 8192 : 128000,
        maxOutputTokens: 8192,
        ...(cause === "provider options"
          ? {
              structuredOutputProviderOptions: { test: { metadata: "重要".repeat(100000) } },
            }
          : {}),
      }),
      /evidence_unpresentable/,
    );
    assert.equal(dispatched, false);
  });
}
