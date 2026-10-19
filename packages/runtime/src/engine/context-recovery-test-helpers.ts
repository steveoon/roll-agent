import assert from "node:assert/strict";
import { z } from "zod";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { ContextRecoveryState } from "../store/semantic-ledger.ts";

/** A deterministic model follows the public recovery reminder, not internal gate state. */
export function recoveryModelInputs() {
  let rawReadCheckpoint: string | undefined;
  return (params: LanguageModelV4CallOptions, recovery: ContextRecoveryState, sourceId: string) => {
    const system = params.prompt
      .flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])),
      )
      .join("\n");
    const coverageJson = /Required semantic read coverage: (.+)\.\n/.exec(system)?.[1];
    assert.ok(coverageJson, "model must see bounded required read coverage");
    const coverage = z
      .object({
        remaining: z.number(),
        nextRequiredItems: z.array(z.object({ itemId: z.string(), version: z.number() })),
      })
      .parse(JSON.parse(coverageJson));
    const checkpointId = recovery.checkpointId;
    // A model acknowledges earlier pages in bounded notes before their bodies
    // may leave the prompt. Coverage alone is not a replacement for these notes.
    const notes =
      "Continue the same project; retain all recovered requirements and verify the next stage. Earlier source facts remain available in this checkpoint.";
    if (coverage.remaining) {
      return [{ action: "read", checkpointId, kind: "semantic", notes }];
    }
    if (rawReadCheckpoint !== checkpointId) {
      rawReadCheckpoint = checkpointId;
      return [{ action: "read", checkpointId, kind: "message", itemId: sourceId, notes }];
    }
    const receipt = /\\?"receipt\\?":\\?"([a-f0-9-]{36})/.exec(JSON.stringify(params.prompt))?.[1];
    assert.ok(receipt, "completed reads must return a current receipt");
    return [
      {
        action: "ready",
        checkpointId,
        receipts: [receipt],
        goal: "Continue the same project",
        constraints: "Retain all recovered requirements",
        nextAction: "Verify the next stage",
        notes,
      },
    ];
  };
}
