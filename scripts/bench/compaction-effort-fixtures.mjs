#!/usr/bin/env node
// Controlled source histories plus an actual completed coding-session snapshot.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { ThreadStore } from "../../packages/runtime/src/store/thread-store.ts";
const { values } = parseArgs({
  options: { output: { type: "string" }, coding: { type: "string" } },
});
if (!values.output || !values.coding) {
  throw new Error("--output <directory> --coding <real benchmark state directory> required");
}
const out = resolve(values.output);
mkdirSync(out, { recursive: true });
const specs = [
  "The exponential retry delay cap is exactly 1739 milliseconds.",
  "Retry-After values above 1739 must not be clipped.",
  "Never retry outcome_unknown, success or policy_denied outcomes.",
  "Numeric validation runs before terminal-outcome handling and throws RangeError.",
  "Unknown outcomes throw TypeError.",
  "Batch duplicate IDs use first occurrence wins, including a terminal first entry.",
  "Exact equality at elapsedMs + delayMs === budgetMs allows the retry.",
];
const fixtures = [];
for (const name of ["first-compaction", "active-items-dense"]) {
  const store = new ThreadStore(join(out, name));
  try {
    const id = store.createThread();
    const facts =
      name === "first-compaction"
        ? specs
        : Array.from(
            { length: 30 },
            (_, i) =>
              `Pending requirement ${i}: implement /project/feature-${i}.ts with exact limit ${3100 + i}; preserve error code E_PENDING_${i}. Do not rename its public export feature${i}.`,
          );
    store.appendMessages(id, [
      {
        role: "user",
        content: "Continue the retry project. Preserve all requirements and pending work below.",
      },
      ...facts.flatMap((fact) => [
        { role: "user", content: fact },
        {
          role: "assistant",
          content: "Routine inspection; no new requirement or action. ".repeat(50),
        },
      ]),
      { role: "user", content: "Continue" },
    ]);
    const snapshotPath = join(out, `${name}.json`);
    writeFileSync(snapshotPath, JSON.stringify(store.readSnapshot(id)));
    fixtures.push({
      name,
      snapshotPath,
      criticalFacts: facts,
      provenance: "Controlled uncompressed coding requirements, archived by real ThreadStore",
    });
  } finally {
    store.close();
  }
}
const coding = new ThreadStore(resolve(values.coding), { readOnly: true });
try {
  const thread = coding.listThreads()[0];
  if (!thread) throw new Error("No completed coding snapshot");
  const snapshotPath = join(out, "post-coding-long.json");
  const snapshot = coding.readSnapshot(thread.id);
  let requiredFacts = [];
  const variant = new ThreadStore(join(out, "post-coding-replay"));
  try {
    const id = variant.createThread();
    const requirements = [
      ...new Set(
        snapshot.transcript.flatMap((entry) =>
          entry.message.role === "user" &&
          typeof entry.message.content === "string" &&
          /^(Implement and export|attempt must|Allowed outcomes|For retryable|A retry is|In phase two|Batch duplicate)/u.test(
            entry.message.content,
          )
            ? [entry.message.content]
            : [],
        ),
      ),
    ];
    requiredFacts = requirements;
    if (requirements.length < 7) {
      throw new Error("Completed coding artifact lacks the seven original requirements");
    }
    variant.appendMessages(
      id,
      requirements.map((content) => ({ role: "user", content })),
    );
    const code = ["retry.mjs", "dispatcher.mjs"]
      .map((name) => `${name}:\n${readFileSync(join(resolve(values.coding), "..", name), "utf8")}`)
      .join("\n");
    variant.appendMessages(id, [
      ...Array.from({ length: 16 }, () => ({
        role: "assistant",
        content:
          "Fixture replay of previously generated module contents; no new execution or requirement:\n" +
          code,
      })),
      { role: "user", content: "Continue" },
    ]);
    writeFileSync(snapshotPath, JSON.stringify(variant.readSnapshot(id)));
  } finally {
    variant.close();
  }
  const expected = requiredFacts;
  fixtures.splice(1, 0, {
    name: "post-coding-long",
    snapshotPath,
    criticalFacts: expected,
    provenance: `Reconstructed isolated snapshot from original user requirements and generated file contents of ${resolve(values.coding)}; checks require every original requirement verbatim in the production ledger`,
  });
} finally {
  coding.close();
}
writeFileSync(join(out, "fixtures.json"), JSON.stringify(fixtures, null, 2) + "\n");
console.log(join(out, "fixtures.json"));
