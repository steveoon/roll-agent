import { z } from "zod";
import type { BrowserElementRef } from "@roll-agent/browser";
import type { GoalSnapshot } from "./observation.ts";
import { PickerEvidenceSchema } from "./picker-observation.ts";
import type { PickerEvidence } from "./picker-observation.ts";

const FieldSchema = PickerEvidenceSchema.pick({
  relationship: true,
  label: true,
  expanded: true,
  panelVisible: true,
  selection: true,
  selectionEvidence: true,
  committedText: true,
  queryText: true,
}).extend({
  id: z.string(),
  triggerRef: z.string().optional(),
  labelOrigin: z.enum([
    "dom-label",
    "dom-placeholder",
    "dom-empty-display",
    "earlier-dom-label",
    "earlier-dom-placeholder",
    "earlier-dom-empty-display",
    "unknown",
  ]),
  optionRefs: z.array(z.string()),
});
const PartSchema = PickerEvidenceSchema.pick({
  part: true,
  optionText: true,
  optionLabel: true,
  optionSelected: true,
}).extend({ fieldId: z.string().optional() });
export type PickerField = z.infer<typeof FieldSchema>;
export type PickerPart = z.infer<typeof PartSchema>;
export type PickerState = { fields: PickerField[]; parts: Record<string, PickerPart> };

/** Observation memory, not a plan or approval ledger. Never infer a relation from proximity. */
export function createPickerMemory() {
  const labels = new Map<
    string,
    { text: string; source: NonNullable<PickerEvidence["labelSource"]> }
  >();
  const ids = new Map<string, string>();
  let documentKey = "";
  return {
    observe(snapshot: GoalSnapshot): PickerState {
      const scope = JSON.stringify([
        snapshot.browserInstance,
        snapshot.pageId,
        snapshot.documentId,
      ]);
      if (scope !== documentKey) {
        labels.clear();
        ids.clear();
        documentKey = scope;
      }
      const evidence = snapshot.refs.flatMap((ref) => {
        const picker = snapshot.controls?.[ref.ref]?.picker;
        return picker ? [{ ref, picker }] : [];
      });
      const pathKey = (ref: BrowserElementRef, path: string) => JSON.stringify([ref.frameId, path]);
      const triggers = new Map(
        evidence
          .filter(({ picker }) => picker.part === "trigger" && picker.triggerPath)
          .map((item) => [pathKey(item.ref, item.picker.triggerPath!), item]),
      );
      const fields = new Map<string, PickerField>();
      const parts: Record<string, PickerPart> = {};
      for (const { ref, picker } of evidence) {
        let field: PickerField | undefined;
        if (
          picker.triggerPath &&
          (picker.part === "trigger" || picker.relationship !== "unknown")
        ) {
          const path = pathKey(ref, picker.triggerPath);
          field = fields.get(path);
          if (!field) {
            const root = triggers.get(path);
            const current = root?.picker ?? picker;
            // A DOM path alone cannot establish continuity after node replacement.
            const identity =
              !snapshot.documentId || root?.ref.backendNodeId === undefined
                ? undefined
                : JSON.stringify([root.ref.frameId, root.ref.backendNodeId]);
            const key = identity ?? `observed:${path}`;
            if (!ids.has(key)) ids.set(key, `picker${ids.size + 1}`);
            if (identity && current.label && current.labelSource) {
              labels.set(identity, { text: current.label, source: current.labelSource });
            }
            const prior = identity ? labels.get(identity) : undefined;
            const label = current.label ?? prior?.text;
            const labelOrigin = current.label
              ? `dom-${current.labelSource ?? "label"}`
              : prior
                ? `earlier-dom-${prior.source}`
                : "unknown";
            field = FieldSchema.parse({
              id: ids.get(key)!,
              relationship: current.relationship,
              ...(root ? { triggerRef: root.ref.ref } : {}),
              ...(label ? { label } : {}),
              labelOrigin,
              ...(current.expanded === undefined ? {} : { expanded: current.expanded }),
              ...(current.panelVisible === undefined ? {} : { panelVisible: current.panelVisible }),
              selection: current.selection,
              selectionEvidence: current.selectionEvidence,
              ...(current.committedText === undefined
                ? {}
                : { committedText: current.committedText }),
              ...(current.queryText === undefined ? {} : { queryText: current.queryText }),
              optionRefs: [],
            });
            fields.set(path, field);
          }
          if (picker.part === "option") field.optionRefs.push(ref.ref);
        }
        parts[ref.ref] = PartSchema.parse({
          part: picker.part,
          ...(field ? { fieldId: field.id } : {}),
          ...(picker.optionText === undefined ? {} : { optionText: picker.optionText }),
          ...(picker.optionLabel === undefined ? {} : { optionLabel: picker.optionLabel }),
          ...(picker.optionSelected === undefined ? {} : { optionSelected: picker.optionSelected }),
        });
      }
      return { fields: [...fields.values()], parts };
    },
  };
}

export function pickerActionLabel(
  ref: Pick<BrowserElementRef, "ref" | "role" | "name">,
  state: PickerState,
  operation = "CLICK",
): string {
  const part = state.parts[ref.ref];
  if (!part) return `${ref.role}: ${ref.name.slice(0, 80)}`;
  const field = state.fields.find((field) => field.id === part.fieldId);
  const name = (field?.label ?? field?.id ?? "owner unknown").slice(0, 40);
  if (operation === "TYPE_TEXT") return `text/query input ${name} [${field?.id ?? "?"}]`;
  if (operation === "SELECT") return `native select ${name} [${field?.id ?? "?"}]`;
  if (operation !== "CLICK") return `${ref.role}: ${ref.name.slice(0, 80)}`;
  if (part.part === "option") {
    return `Select candidate ${JSON.stringify((part.optionText ?? ref.name).slice(0, 80))} in ${name} [${field?.id ?? "?"}]`;
  }
  return `${field?.expanded === true ? "Close OPEN" : field?.expanded === false ? "Open CLOSED" : "Toggle"} ${name} [${field?.id ?? "?"}] (trigger, NOT an option)`;
}
