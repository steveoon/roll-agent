import type { CompactionSemanticEvidenceRegistry } from "./compaction-semantic-state.ts";

/** Continuity-first alternating lanes. Serialization must still admit both oldest entries. */
export function orderCompactionEvidence(registry: CompactionSemanticEvidenceRegistry) {
  const messages = registry.filter((entry) => entry.provenance.kind === "message");
  const tools = registry.filter((entry) => entry.provenance.kind === "tool_execution");
  const spare = registry.filter(
    (entry) => entry.provenance.kind !== "message" && entry.provenance.kind !== "tool_execution",
  );
  const ordered: CompactionSemanticEvidenceRegistry[number][] = [];
  for (let i = 0; i < Math.max(messages.length, tools.length); i += 1) {
    const message = messages[i];
    const tool = tools[i];
    if (message !== undefined) ordered.push(message);
    if (tool !== undefined) ordered.push(tool);
  }
  return [...ordered, ...spare];
}
export class CompactionEvidenceUnpresentable extends Error {
  constructor() {
    super("evidence_unpresentable: oldest continuity excerpts cannot fit serialized cap");
  }
}
