import { createHash } from "node:crypto";
import type { GoalSnapshot } from "./observation.ts";
import type { BrowserOperateOutput } from "./contracts.ts";
import type { FormState } from "./form-context.ts";
import { taskElements } from "./task-policy.ts";

export function createFormLoopProgress() {
  return { documentId: "", visits: new Map<string, number>() };
}

/** Detect revisiting the same form/option state, not merely a long sequence of actions. */
export function observeFormLoopProgress(
  memory: ReturnType<typeof createFormLoopProgress>,
  snapshot: GoalSnapshot,
  form: FormState,
  previousAction?: Pick<BrowserOperateOutput["steps"][number], "operation" | "executed" | "error">,
): boolean {
  const documentId = snapshot.documentId ?? "";
  if (memory.documentId !== documentId) {
    memory.documentId = documentId;
    memory.visits.clear();
  }
  // Planning/binding judgments and waiting do not spend the action-cycle budget.
  if (
    previousAction &&
    (!previousAction.executed ||
      previousAction.error ||
      !["CLICK", "SCROLL_UP", "SCROLL_DOWN", "ESCAPE"].includes(previousAction.operation))
  ) {
    return false;
  }
  if (snapshot.pageState?.busy) return false;
  const state = {
    fields: form.fields.map((f) => [f.id, f.status, f.current, f.binding?.name, f.entry?.name]),
    panels: snapshot.pageState?.panels,
    tabs: snapshot.pageState?.selectedTabs,
    truncated: snapshot.truncated,
    // Semantic labels and values survive recreated DOM nodes. Refs, backend IDs,
    // coordinates, proof fingerprints and invocation revision are not progress.
    controls: taskElements(snapshot)
      .map((c) =>
        JSON.stringify([
          c.role,
          c.name,
          c.fieldLabel,
          c.valueKind,
          c.value,
          c.displayText,
          c.checked,
          c.selected,
          c.disabled,
          c.expanded,
          c.availability,
          c.options,
          c.optionsTruncated,
          c.validationErrors,
        ]),
      )
      .sort(),
  };
  const key = createHash("sha256").update(JSON.stringify(state)).digest("hex");
  const count = (memory.visits.get(key) ?? 0) + 1;
  memory.visits.set(key, count);
  // One invocation has at most 100 steps; keep the helper bounded independently.
  if (memory.visits.size > 100) memory.visits.delete(memory.visits.keys().next().value!);
  return count >= 3;
}
