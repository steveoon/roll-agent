import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactionSemanticStateSchema,
  createCompactionSemanticReminderProjection,
  createEmptyCompactionSemanticState,
  listSemanticArchiveItems,
  replaceCompactionSemanticGoal,
  replaceCompactionSemanticConstraints,
} from "./compaction-semantic-state.ts";

test("legacy semantic snapshots remain strict and round-trip without adding current facts", () => {
  const state = createEmptyCompactionSemanticState();
  assert.deepEqual(compactionSemanticStateSchema.parse(JSON.parse(JSON.stringify(state))), state);
  assert.equal(state.goal, null);
  assert.deepEqual(listSemanticArchiveItems(state), []);
  assert.throws(() => compactionSemanticStateSchema.parse({ ...state, unexpected: "authority" }));
});

for (const [name, source, expected] of [
  ["BMP overflow", "中".repeat(600), `${"中".repeat(511)}…`],
  ["emoji below limit", `${"中".repeat(509)}😀`, `${"中".repeat(509)}😀`],
  ["emoji at limit", `${"中".repeat(510)}😀`, `${"中".repeat(510)}😀`],
  ["emoji fits before ellipsis", `${"中".repeat(509)}😀尾尾`, `${"中".repeat(509)}😀…`],
  ["emoji crosses truncation boundary", `${"中".repeat(510)}😀尾尾`, `${"中".repeat(510)}…`],
  ["astral-only overflow", "😀".repeat(600), `${"😀".repeat(255)}…`],
] as const) {
  test(`legacy semantic text bounds preserve Unicode: ${name}`, () => {
    const initial = createEmptyCompactionSemanticState();
    const goal = replaceCompactionSemanticGoal(initial, {
      verbatimRequest: source,
      sourceSequence: 1,
    });
    const constraints = replaceCompactionSemanticConstraints(initial, [
      { quote: source, sourceSequence: 1 },
    ]);
    assert.equal(goal.goal?.sourceQuotes[0], expected);
    assert.equal(constraints.constraints[0]?.sourceQuotes[0], expected);
    assert.doesNotThrow(() => compactionSemanticStateSchema.parse(goal));
    assert.doesNotThrow(() => compactionSemanticStateSchema.parse(constraints));
    assert.deepEqual(initial, createEmptyCompactionSemanticState());
  });
}

test("legacy snapshot rejects duplicate fact identities and wrong provenance", () => {
  const state = replaceCompactionSemanticConstraints(createEmptyCompactionSemanticState(), [
    { quote: "Do not publish", sourceSequence: 0 },
  ]);
  const constraint = state.constraints[0];
  assert.ok(constraint);
  assert.throws(() =>
    compactionSemanticStateSchema.parse({ ...state, constraints: [constraint, constraint] }),
  );
  assert.throws(() =>
    compactionSemanticStateSchema.parse({
      ...state,
      constraints: [
        {
          ...constraint,
          provenance: [
            {
              kind: "message",
              messageSequence: null,
              toolExecutionId: null,
              resourceKey: null,
              managerInstanceId: null,
              sessionId: null,
            },
          ],
        },
      ],
    }),
  );
});

test("bounded legacy reminder reports omitted facts without deleting their archived source", () => {
  const state = replaceCompactionSemanticConstraints(
    createEmptyCompactionSemanticState(),
    Array.from({ length: 20 }, (_, index) => ({
      quote: `constraint-${String(index)}: ${"keep evidence ".repeat(30)}`,
      sourceSequence: index,
    })),
  );
  const archive = listSemanticArchiveItems(state);
  const projection = createCompactionSemanticReminderProjection(state, 1024);
  assert.ok(JSON.stringify(projection).length <= 1024);
  assert.ok(projection.omittedCounts.constraint > 0);
  assert.equal(archive.length, 20);
  assert.deepEqual(listSemanticArchiveItems(state), archive);
});
