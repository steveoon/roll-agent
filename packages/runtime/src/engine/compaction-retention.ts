import { createCheckpointSemanticReminderProjection } from "./compaction-checkpoint.ts";
import type { CompactionSemanticState } from "./compaction-semantic-state.ts";

const textItems = (state: CompactionSemanticState) => [
  ...(state.goal === null ? [] : [state.goal]),
  ...state.constraints,
  ...state.decisions,
  ...state.pendingWork,
  ...state.uncertainties,
  ...state.completedWork,
];

/** New facts must be visible before retiring their sources. Old completed work remains
 * recoverable from archived checkpoints/transcript under the existing omittedCounts contract.
 * Never use that exception to evict active constraints or silently prune new candidate facts. */
export function retainsCompactionFacts(
  previous: CompactionSemanticState | undefined,
  candidate: CompactionSemanticState,
  merged: CompactionSemanticState,
): boolean {
  if (Object.values(candidate.prunedItemCounts).some((count) => count > 0)) return false;
  if (
    Object.entries(merged.prunedItemCounts).some(
      ([key, count]) =>
        key !== "completed_work" &&
        count > (previous?.prunedItemCounts[key as keyof typeof merged.prunedItemCounts] ?? 0),
    )
  ) {
    return false;
  }
  const previousItems = new Map(
    previous === undefined ? [] : textItems(previous).map((i) => [i.id, i]),
  );
  const mergedItems = new Map(textItems(merged).map((i) => [i.id, i]));
  const projection = createCheckpointSemanticReminderProjection(merged);
  const projected = new Map(projection.items.map((i) => [i.itemId, i]));
  const previousProjection =
    previous === undefined ? undefined : createCheckpointSemanticReminderProjection(previous);
  const required = [
    ...textItems(candidate).filter(
      (i) => JSON.stringify(previousItems.get(i.id)) !== JSON.stringify(i),
    ),
    // Do not displace currently visible active facts to make room for historical completions.
    ...(previousProjection?.items ?? [])
      .filter((i) => i.category !== "completed_work")
      .flatMap((i) => {
        const retained = mergedItems.get(i.itemId);
        return retained === undefined ? [] : [retained];
      }),
  ];
  return required.every((item) => {
    const visible = projected.get(item.id);
    if (visible === undefined || !mergedItems.has(item.id)) return false;
    const text = [visible.text, ...visible.sourceQuotes].join("\n").replace(/\s+/gu, " ");
    return item.sourceQuotes.every((quote) => text.includes(quote.replace(/\s+/gu, " ")));
  });
}
