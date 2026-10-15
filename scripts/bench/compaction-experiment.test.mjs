import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ThreadStore } from "../../packages/runtime/src/store/thread-store.ts";
import { createEmptyCompactionModelDraft } from "../../packages/runtime/src/engine/compaction-semantic-state.ts";
import { runProductionCompaction, decideExperiment } from "./compaction-experiment.mjs";
const require = createRequire(resolve("packages/runtime/package.json"));
const { MockLanguageModelV4 } = await import(pathToFileURL(require.resolve("ai/test")));
for (const mode of [
  "valid",
  "valid-unpresented-tail",
  "invalid-grounding",
  "invalid-json",
  "timeout",
]) {
  test(`experiment grades production validation and real space: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-experiment-test-"));
    const store = new ThreadStore(join(dir, "source"));
    try {
      const id = store.createThread();
      const fact = "The retry limit must remain exactly 1739.";
      store.appendMessages(id, [
        { role: "user", content: fact },
        { role: "assistant", content: "Routine inspection. ".repeat(900) },
        { role: "user", content: "Continue" },
      ]);
      const extraFacts =
        mode === "valid-unpresented-tail"
          ? Array.from({ length: 40 }, (_, i) => `Keep requirement tail-${i} exact.`)
          : [];
      store.appendMessages(id, [
        ...extraFacts.flatMap((content) => [
          { role: "user", content },
          { role: "assistant", content: "Routine inspection. ".repeat(100) },
        ]),
        ...(extraFacts.length ? [{ role: "user", content: "Continue" }] : []),
      ]);
      const model = new MockLanguageModelV4({
        doGenerate: async (params) => {
          if (mode === "timeout") throw new DOMException("deadline", "TimeoutError");
          const text = params.prompt
            .filter((m) => m.role === "user")
            .flatMap((m) => m.content)
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n");
          const { evidence } = JSON.parse(
            /<harness-evidence>\n([\s\S]+)\n<\/harness-evidence>/.exec(text)[1],
          );
          const source = evidence.find((e) => e.summary.includes(fact));
          const draft = {
            ...createEmptyCompactionModelDraft(),
            constraints: [
              {
                priorItemId: null,
                text: fact,
                sourceEvidenceIds: [source.evidenceId],
                sourceQuotes: [
                  mode === "invalid-grounding" ? "Invented constraint with 2500." : source.summary,
                ],
              },
            ],
            evidenceReviews: evidence.map((e) => ({
              evidenceId: e.evidenceId,
              disposition: e.evidenceId === source.evidenceId ? "reviewed" : "irrelevant",
              reason: "Full evidence inspected",
            })),
          };
          return {
            content: [
              {
                type: "text",
                text: mode === "invalid-json" ? "invalid JSON" : JSON.stringify(draft),
              },
            ],
            usage: { inputTokens: { total: 100 }, outputTokens: { total: 100 } },
            warnings: [],
            finishReason: { unified: "stop", raw: "stop" },
          };
        },
      });
      const result = await runProductionCompaction({
        snapshot: store.readSnapshot(id),
        directory: join(dir, "variant"),
        model,
        timeoutMs: 120000,
        criticalFacts: [fact, ...extraFacts],
      });
      assert.equal(
        result.productionQualityPassed,
        mode.startsWith("valid"),
        JSON.stringify(result),
      );
      if (extraFacts.length) {
        assert.ok(result.criticalFacts.some((fact) => fact.location === "active"));
      }
      assert.ok(result.before.activeHistoryChars > 17000);
      assert.ok(result.after.activeHistoryChars < result.before.activeHistoryChars);
      if (mode === "invalid-grounding") assert.ok(result.semanticRejections > 0);
      if (mode === "timeout" || mode === "invalid-json") {
        assert.equal(result.committedValidSummaries, 0);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("default-effort decision requires all nine identical request pairs and quality", () => {
  const fixtures = ["first", "coding", "dense"].map((name) => ({ name }));
  const runs = fixtures.flatMap((f) =>
    Array.from({ length: 3 }, (_, pair) =>
      ["low", "medium"].map((effort) => ({
        fixture: f.name,
        pair,
        effort,
        status: "completed",
        qualityPassed: true,
        requestDigest: f.name,
        elapsedMs: effort === "low" ? 70 : 100,
      })),
    ).flat(),
  );
  assert.equal(decideExperiment(runs, fixtures).changeDefaultToLow, true);
  assert.equal(decideExperiment(runs.slice(1), fixtures).changeDefaultToLow, false);
  assert.equal(
    decideExperiment(
      runs.map((r, i) => (i === 0 ? { ...r, qualityPassed: false } : r)),
      fixtures,
    ).changeDefaultToLow,
    false,
  );
  assert.equal(
    decideExperiment(
      runs.map((r, i) => (i === 0 ? { ...r, requestDigest: "changed" } : r)),
      fixtures,
    ).changeDefaultToLow,
    false,
  );
  assert.equal(
    decideExperiment(
      runs.map((r) => ({ ...r, elapsedMs: r.effort === "low" ? 90 : 100 })),
      fixtures,
    ).changeDefaultToLow,
    false,
  );
});
