import { createHash } from "node:crypto";
import { z } from "zod";
import type { taskElements } from "./task-policy.ts";

export const FormFieldSchema = z.discriminatedUnion("intent", [
  z
    .object({
      name: z.string().min(1).max(200),
      intent: z.literal("set"),
      valueName: z.string().min(1).max(200),
      comparison: z.enum(["auto", "literal", "semantic"]).default("auto"),
    })
    .strict(),
  z.object({ name: z.string().min(1).max(200), intent: z.literal("preserve") }).strict(),
]);
export const FormTaskSchema = z
  .object({
    mode: z.enum(["create", "edit"]),
    stopAt: z.enum(["applied", "current-view"]).default("applied"),
    fields: z
      .array(FormFieldSchema)
      .min(1)
      .max(16)
      .refine(
        (fields) => new Set(fields.map((f) => f.name)).size === fields.length,
        "Field names must be unique",
      ),
  })
  .strict();
export type FormTask = z.infer<typeof FormTaskSchema>;
export type FormControl = ReturnType<typeof taskElements>[number];
const FormBindingSchema = z.object({
  identity: z.string(),
  readOnlyDisplay: z.literal(true).optional(),
  key: z.string().optional(),
  name: z.string(),
  role: z.string(),
  fieldLabel: z.string().optional(),
});
export const FormFieldStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  intent: z.enum(["set", "preserve"]),
  comparison: z.enum(["auto", "literal", "semantic"]),
  expected: z.string().optional(),
  binding: FormBindingSchema.optional(),
  // A judged route to an editor, not an input and never itself write permission.
  entry: FormBindingSchema.optional(),
  entryProof: z
    .object({ fingerprint: z.string(), status: z.enum(["satisfied", "unsatisfied", "unknown"]) })
    .optional(),
  initial: z.string().optional(),
  current: z.string().optional(),
  status: z.enum(["unknown", "unsatisfied", "satisfied"]),
  reason: z.string(),
  fingerprint: z.string().optional(),
  target: z.object({ key: z.string(), label: z.string(), optionsKey: z.string() }).optional(),
  semanticProof: z
    .object({ fingerprint: z.string(), status: z.enum(["satisfied", "unsatisfied"]) })
    .optional(),
});
export const FormStateSchema = z.object({
  mode: z.enum(["create", "edit"]),
  stopAt: z.enum(["applied", "current-view"]),
  fields: z.array(FormFieldStateSchema),
  focus: z.string().optional(),
  panel: z
    .object({
      key: z.string(),
      status: z.enum(["pending", "accepted", "rejected"]),
      queryIdentity: z.string().optional(),
    })
    .optional(),
});
export type FormState = z.infer<typeof FormStateSchema>;
export const formControlValue = (c: FormControl): string | undefined =>
  c.checked !== undefined
    ? String(c.checked)
    : ["input", "committed"].includes(c.valueKind)
      ? c.value
      : undefined;
export const comparableControl = (c: FormControl): boolean =>
  (["ready", "offscreen"].includes(c.availability) ||
    (c.availability === "covered" && c.readable === true)) &&
  formControlValue(c) !== undefined &&
  !["password", "file", "hidden"].includes(c.inputType ?? "");
/** Presentation text on a picker is its mutable value, never its identity. */
export const controlBindingKey = (c: FormControl): string =>
  JSON.stringify([
    c.identity,
    c.role,
    c.fieldLabel || null,
    c.inputType,
    c.pickerIdentity ?? (c.fieldLabel ? null : c.name),
    !c.fieldLabel && c.peerGroup
      ? [c.peerGroup.key, c.peerGroup.position, c.peerGroup.count]
      : undefined,
  ]);
export const usesSemanticComparison = (
  field: FormState["fields"][number],
  c: FormControl,
): boolean =>
  field.comparison === "semantic" ||
  (field.comparison === "auto" && Boolean(c.pickerIdentity || c.nativeSelect));
export const formOptions = (c: FormControl, controls: readonly FormControl[]) =>
  c.nativeSelect
    ? c.optionsTruncated
      ? []
      : (c.options ?? [])
          .filter((o) => !o.disabled)
          .map((o, i) => ({ id: `o${i}`, label: o.label }))
    : [
        ...new Map(
          controls
            .filter(
              (o) =>
                o.pickerOwnerPath &&
                o.pickerOwnerPath === c.pickerIdentity &&
                o.valueKind === "option-label" &&
                !o.disabled &&
                !["hidden", "unavailable"].includes(o.availability),
            )
            .map((o) => [
              o.pickerOptionPath ?? o.identity,
              { id: o.ref, label: o.pickerOptionLabel ?? o.displayText ?? o.name },
            ]),
        ).values(),
      ];
export const formTargetKey = (c: FormControl, expected: string | undefined): string =>
  JSON.stringify([controlBindingKey(c), expected, c.constraints, c.inputType]);
export const formOptionsKey = (options: ReturnType<typeof formOptions>): string =>
  JSON.stringify(options.map((o) => o.label).sort());
export const controlFingerprint = (c: FormControl): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        controlBindingKey(c),
        c.valueKind,
        c.checked,
        c.value,
        c.inputType,
        c.constraints,
        c.invalid,
        c.validationErrors,
      ]),
    )
    .digest("hex");
/** Keep the surrounding label, excluding this entry's mutable displayed summary. */
export const entryBindingKey = (c: FormControl): string =>
  JSON.stringify([
    c.identity,
    c.role,
    c.fieldLabel,
    c.context.map((text) => {
      for (const ownText of [c.displayText, c.name]) {
        if (ownText) text = text.split(ownText).join("");
      }
      return text.trim();
    }),
  ]);
export const entryFingerprint = (c: FormControl): string =>
  createHash("sha256")
    .update(JSON.stringify([controlBindingKey(c), c.valueKind, c.displayText, c.name]))
    .digest("hex");
/** Only the node's own displayed text is evidence; surrounding context is never a value. */
export const preserveDisplayValue = (c: FormControl): string | undefined =>
  c.valueKind === "display-only" &&
  !c.editable &&
  !c.modal &&
  ["ready", "offscreen"].includes(c.availability) &&
  !["link", "rootwebarea", "document", "iframe"].includes(c.role.toLowerCase()) &&
  Boolean(c.fieldLabel || c.context.length) &&
  Boolean(c.displayText?.trim()) &&
  (c.displayText?.length ?? 0) < 2000
    ? c.displayText
    : undefined;
export const preserveDisplayInitialKey = (c: FormControl): string =>
  `display:${entryBindingKey(c)}`;
export const currentFormEntry = (
  field: FormState["fields"][number],
  controls: readonly FormControl[],
) =>
  controls.find(
    (c) => c.identity === field.entry?.identity && entryBindingKey(c) === field.entry.key,
  );

/** Fields independently assigned to the same observed entry share only that local editor. */
export const editorFieldIds = (form: FormState): string[] => {
  const focus = form.fields.find((f) => f.id === form.focus);
  return focus
    ? form.fields
        .filter(
          (f) =>
            f.id === focus.id ||
            (focus.entry && f.entry?.identity === focus.entry.identity && f.intent === "set"),
        )
        .map((f) => f.id)
    : [];
};
export function createFormState(
  contract: FormTask,
  values: readonly { name: string; text: string }[],
): FormState {
  return {
    mode: contract.mode,
    stopAt: contract.stopAt,
    fields: contract.fields.map((field, index) => {
      const value = field.intent === "set" ? values.filter((v) => v.name === field.valueName) : [];
      if (field.intent === "set" && value.length !== 1) {
        throw Error(
          `Form field ${field.name} requires exactly one supplied value named ${field.valueName}`,
        );
      }
      return {
        id: `f${index + 1}`,
        name: field.name,
        intent: field.intent,
        comparison: field.intent === "set" ? field.comparison : "literal",
        ...(value[0] ? { expected: value[0].text } : {}),
        status: "unknown",
        reason: "not_bound",
      };
    }),
  };
}
export function updateFormState(
  form: FormState,
  controls: readonly FormControl[],
  initial: ReadonlyMap<string, string>,
  panelKeys: readonly string[],
): boolean {
  const before = JSON.stringify(form);
  for (const field of form.fields) {
    const entry = currentFormEntry(field, controls);
    if (field.entry && !entry && !panelKeys.length) {
      delete field.entry;
      delete field.entryProof;
    }
    const c = controls.find((c) => c.identity === field.binding?.identity);
    if (
      !c ||
      !field.binding ||
      c.role !== field.binding.role ||
      (field.binding.key !== undefined
        ? (field.binding.readOnlyDisplay ? entryBindingKey(c) : controlBindingKey(c)) !==
          field.binding.key
        : field.binding.fieldLabel
          ? c.fieldLabel !== field.binding.fieldLabel
          : c.name !== field.binding.name)
    ) {
      delete field.binding;
      delete field.current;
      delete field.fingerprint;
      delete field.semanticProof;
      delete field.target;
      field.status = "unknown";
      field.reason = "binding_missing_or_changed";
      // A fresh summary may describe this field after its editor closes. Ask Jev
      // for the field-specific meaning; never copy aggregate text into an input.
      if (
        entry &&
        !panelKeys.length &&
        !entry.modal &&
        (["ready", "offscreen"].includes(entry.availability) ||
          (entry.availability === "covered" && entry.readable === true))
      ) {
        field.current = entry.displayText ?? entry.name;
        field.fingerprint = entryFingerprint(entry);
        const proof = field.entryProof;
        field.status = proof?.fingerprint === field.fingerprint ? proof.status : "unknown";
        field.reason =
          proof?.fingerprint === field.fingerprint
            ? "current_entry_summary_judgment"
            : "needs_entry_summary_judgment";
      }
      continue;
    }
    if (field.binding.readOnlyDisplay) {
      const baseline = initial.get(preserveDisplayInitialKey(c));
      const current = preserveDisplayValue(c);
      delete field.fingerprint;
      delete field.current;
      field.status = "unknown";
      field.reason = "not_currently_readable_or_applied";
      if (field.intent !== "preserve" || current === undefined) continue;
      field.current = current;
      if (baseline === undefined) {
        field.reason = "initial_value_unavailable";
        continue;
      }
      field.initial ??= baseline;
      field.expected ??= baseline;
      field.fingerprint = entryFingerprint(c);
      field.status = current === field.expected ? "satisfied" : "unsatisfied";
      field.reason =
        current === field.expected ? "current_display_unchanged" : "current_display_differs";
      continue;
    }
    if (field.initial === undefined && initial.has(c.identity)) {
      field.initial = initial.get(c.identity)!;
    }
    if (field.intent === "preserve" && field.expected === undefined && initial.has(c.identity)) {
      field.expected = initial.get(c.identity)!;
    }
    if (!comparableControl(c)) {
      delete field.current;
      delete field.fingerprint;
      field.status = "unknown";
      field.reason = "not_currently_readable_or_applied";
      continue;
    }
    const options = formOptions(c, controls);
    if (
      field.target &&
      (field.target.key !== formTargetKey(c, field.expected) ||
        (options.length > 0 && field.target.optionsKey !== formOptionsKey(options)))
    ) {
      delete field.target;
    }
    field.current = formControlValue(c)!;
    field.fingerprint = controlFingerprint(c);
    if (field.expected === undefined) {
      field.status = "unknown";
      field.reason = "initial_value_unavailable";
      continue;
    }
    if (field.intent === "set" && (c.invalid === true || c.invalid === "true")) {
      field.status = "unsatisfied";
      field.reason = "page_rejected_value";
      continue;
    }
    if (field.current === field.expected) {
      field.status = "satisfied";
      field.reason = "current_literal_match";
      continue;
    }
    if (!usesSemanticComparison(field, c)) {
      field.status = "unsatisfied";
      field.reason = "current_value_differs";
      continue;
    }
    if (field.target) {
      field.status = field.current === field.target.label ? "satisfied" : "unsatisfied";
      field.reason =
        field.status === "satisfied" ? "current_mapped_option_match" : "mapped_option_differs";
      continue;
    }
    if (field.comparison === "auto" && (c.pickerIdentity || c.nativeSelect)) {
      field.status = "unknown";
      field.reason = "needs_option_mapping";
      continue;
    }
    if (field.semanticProof?.fingerprint === field.fingerprint) {
      field.status = field.semanticProof.status;
      field.reason = "current_semantic_judgment";
      continue;
    }
    field.status = "unknown";
    field.reason = "needs_current_semantic_judgment";
  }
  if (form.focus) {
    if (panelKeys.length) {
      const key = JSON.stringify([...panelKeys].sort());
      if (form.panel?.key !== key) form.panel = { key, status: "pending" };
    } else {
      delete form.panel;
      const focus = form.fields.find((f) => f.id === form.focus);
      if (!focus || focus.status === "satisfied") delete form.focus;
    }
  }
  return before !== JSON.stringify(form);
}
export function formValuesSatisfied(form: FormState): boolean {
  return form.fields.every((f) => f.status === "satisfied");
}
