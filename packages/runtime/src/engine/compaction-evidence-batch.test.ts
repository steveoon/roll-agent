import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  buildCompactionSemanticEvidenceRegistry,
  buildCompactionSemanticModelContext,
} from "./compaction-semantic-state.ts";

test("actual serialized 32-item prompt includes both continuity lanes behind 40-message backlog", () => {
  const registry = buildCompactionSemanticEvidenceRegistry({
    messages: Array.from({ length: 40 }, (_, sequence) => ({
      sequence,
      role: "user",
      summary: `message ${sequence}`,
    })),
    toolExecutions: [
      {
        id: randomUUID(),
        agentName: "write",
        toolName: "file",
        outcome: { kind: "success" },
        resultSummary: "old tool evidence",
      },
    ],
    resources: [],
    runningSessions: [],
  });
  const context = buildCompactionSemanticModelContext(registry, undefined, 48000);
  const parsed = JSON.parse(context.prompt);
  assert.equal(parsed.evidence.length, 32);
  assert.equal(parsed.evidence[0].kind, "message");
  assert.equal(parsed.evidence[1].kind, "tool_execution");
  assert.equal(context.includedEvidenceIds.length, 32);
  assert.ok(context.prompt.length <= 48000);
});
test("serialized mandatory oldest entries fail explicitly under cap rather than skip Tool lane", () => {
  const registry = buildCompactionSemanticEvidenceRegistry({
    messages: [{ sequence: 0, role: "user", summary: "\\".repeat(800) }],
    toolExecutions: [
      {
        id: randomUUID(),
        agentName: "write",
        toolName: "file",
        outcome: { kind: "success" },
        resultSummary: "\\".repeat(800),
      },
    ],
    resources: [],
    runningSessions: [],
  });
  assert.throws(
    () => buildCompactionSemanticModelContext(registry, undefined, 1024),
    /evidence_unpresentable/,
  );
});
