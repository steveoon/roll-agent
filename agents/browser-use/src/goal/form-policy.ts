import { z } from "zod";
import type { DecisionRequest } from "./decisions.ts";
import type { GoalSnapshot } from "./observation.ts";
import type { PickerState } from "./picker-state.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { executionSummary } from "./execution-context.ts";
import {
  formValuesSatisfied,
  updateFormState,
  controlFingerprint,
  controlBindingKey,
  formOptions,
  formTargetKey,
  formOptionsKey,
  usesSemanticComparison,
  comparableControl,
  currentFormEntry,
  entryFingerprint,
  entryBindingKey,
  editorFieldIds,
  preserveDisplayValue,
} from "./form-context.ts";
import type { FormControl } from "./form-context.ts";

const isEditorEntry = (c: FormControl): boolean =>
  ["ready", "offscreen"].includes(c.availability) &&
  !c.disabled &&
  !c.editable &&
  c.valueKind === "display-only" &&
  ["clickable", "button", "link"].includes(c.role.toLowerCase());

export function formReady(
  context: ExecutionContext,
  snapshot: GoalSnapshot,
  pickers: PickerState,
): boolean {
  return Boolean(
    context.form &&
    context.documentId &&
    context.documentId === snapshot.documentId &&
    context.summary.latestObservation === snapshot.snapshotId &&
    !context.summary.documentChanged &&
    formValuesSatisfied(context.form) &&
    snapshot.pageState &&
    (context.form.stopAt === "current-view"
      ? !snapshot.pageState.panels.length || context.form.panel?.status === "accepted"
      : snapshot.pageState.panels.length === 0) &&
    !snapshot.pageState.busy &&
    !pickers.fields.some((p) => p.panelVisible === true),
  );
}
export function formActionOwner(
  context: ExecutionContext,
  ref: string,
  controls: readonly FormControl[],
  pickers: PickerState,
): string | undefined {
  const form = context.form;
  const c = controls.find((c) => c.ref === ref);
  if (!form || !c) return undefined;
  const field = form.fields.find((f) => f.binding?.identity === c.identity);
  if (field) return field.intent === "set" ? field.id : undefined;
  const entryOwner = form.fields.find(
    (f) =>
      f.intent === "set" &&
      f.status !== "satisfied" &&
      currentFormEntry(f, controls)?.identity === c.identity,
  );
  if (entryOwner) return entryOwner.id;
  const owner = pickers.parts[ref]?.fieldId;
  if (owner) {
    const trigger = pickers.fields.find((f) => f.id === owner)?.triggerRef;
    const triggerControl = controls.find((c) => c.ref === trigger);
    const bound = form.fields.find(
      (f) => f.binding?.identity === triggerControl?.identity && f.intent === "set",
    );
    if (bound) return bound.id;
    // An accepted multi-control editor does not grant ownership of every picker.
    // Navigation inside a selector with no locally bound value control is separate.
    if (
      controls.some(
        (local) =>
          local.modal &&
          local.pickerIdentity &&
          form.fields.some((f) => f.binding?.identity === local.identity),
      )
    ) {
      return undefined;
    }
  }
  if (
    form.panel?.status === "accepted" &&
    form.focus &&
    c.modal &&
    (c.editable !== true || c.identity === form.panel.queryIdentity)
  ) {
    return form.focus;
  }
  return undefined;
}
export function withFormContext(
  request: DecisionRequest,
  context: ExecutionContext | undefined,
  snapshot: GoalSnapshot,
  controls: readonly FormControl[],
  pickers: PickerState,
  entryCandidates: readonly FormControl[],
): DecisionRequest {
  if (!context) return request;
  const form = context.form;
  const summary = executionSummary(context);
  const editorFields = form ? editorFieldIds(form) : [];
  // Discovery may bind an entry that needs scrolling first. Dispatch eligibility
  // remains separate; entryCandidates has already excluded forbidden controls.
  const entries = entryCandidates.filter(isEditorEntry);
  const displays = form?.fields.some((f) => f.intent === "preserve")
    ? controls.filter((c) => preserveDisplayValue(c) !== undefined)
    : [];
  const peerKeys = [...new Set(controls.flatMap((c) => (c.peerGroup ? [c.peerGroup.key] : [])))];
  const fieldInventory = (form ? controls : [])
    .filter(
      (c) =>
        c.valueKind !== "option-label" &&
        (comparableControl(c) ||
          c.pickerIdentity ||
          c.editable ||
          entries.includes(c) ||
          displays.includes(c)),
    )
    .map((c) => ({
      ref: c.ref,
      label: c.fieldLabel || undefined,
      value: (c.value ?? preserveDisplayValue(c))?.slice(0, 80),
      name: c.name.slice(0, 80),
      context: c.context.filter((t) => t.length <= 100).slice(0, 2),
      role: c.role,
      availability: c.availability,
      ...(entries.includes(c) ? { editorEntryCandidate: true } : {}),
      ...(c.peerGroup
        ? {
            group: `g${peerKeys.indexOf(c.peerGroup.key) + 1}`,
            position: c.peerGroup.position,
            groupSize: c.peerGroup.count,
          }
        : {}),
    }));
  request.state = {
    ...z.record(z.unknown()).parse(request.state),
    ...(form ? { formControls: fieldInventory } : {}),
    executionContext: {
      ...summary,
      changes: summary.changes.slice(-12).map(({ identity: _identity, ...c }) => ({
        ...c,
        before: c.before?.slice(0, 200),
        after: c.after?.slice(0, 200),
      })),
      ...(form
        ? {
            form: {
              ...form,
              ...(form.panel
                ? {
                    panel: {
                      key: form.panel.key,
                      status: form.panel.status,
                      queryRef: controls.find((c) => c.identity === form.panel?.queryIdentity)?.ref,
                    },
                  }
                : {}),
              fields: form.fields.map(
                ({
                  binding,
                  entry,
                  entryProof: _entryProof,
                  target,
                  fingerprint: _fingerprint,
                  semanticProof: _proof,
                  ...f
                }) => ({
                  ...f,
                  ...(target ? { target: { label: target.label } } : {}),
                  ...(binding
                    ? {
                        binding: {
                          ref: controls.find((c) => c.identity === binding.identity)?.ref,
                          name: binding.name,
                          role: binding.role,
                          fieldLabel: binding.fieldLabel,
                        },
                      }
                    : {}),
                  ...(entry
                    ? {
                        entry: {
                          ref: currentFormEntry({ ...f, entry }, controls)?.ref,
                          name: currentFormEntry({ ...f, entry }, controls)?.name ?? entry.name,
                        },
                      }
                    : {}),
                  initial: f.initial?.slice(0, 500),
                  initialLength: f.initial?.length,
                  expected: f.expected?.slice(0, 500),
                  current: f.current?.slice(0, 500),
                  expectedLength: f.expected?.length,
                  currentLength: f.current?.length,
                }),
              ),
            },
          }
        : {}),
    },
  };
  if (!form) return request;
  const routing: Record<string, Record<string, string[]>> = { ...request.evidenceRouting };
  const candidates = controls.filter(
    (c) =>
      (["ready", "offscreen"].includes(c.availability) || comparableControl(c)) &&
      c.valueKind !== "option-label" &&
      !isEditorEntry(c) &&
      !["rootwebarea", "document", "iframe"].includes(c.role.toLowerCase()) &&
      (c.editable ||
        c.pickerIdentity ||
        c.nativeSelect ||
        c.fieldLabel ||
        ["input", "query", "committed", "placeholder"].includes(c.valueKind) ||
        c.role.toLowerCase() === "button"),
  );
  request.observationRefs = controls
    .filter((c) =>
      form.fields.some(
        (f) => f.binding?.identity === c.identity || f.entry?.identity === c.identity,
      ),
    )
    .map((c) => c.ref);
  if (snapshot.pageState?.panels.length) {
    request.observationRefs.push(...controls.filter((c) => c.modal).map((c) => c.ref));
  }
  for (const field of form.fields) {
    if (snapshot.pageState?.panels.length && form.focus && !editorFields.includes(field.id)) {
      continue;
    }
    const bound = controls.find((c) => c.identity === field.binding?.identity);
    const entry = currentFormEntry(field, controls);
    if (
      (!bound && (!entry || snapshot.pageState?.panels.length)) ||
      (bound && ["hidden", "unavailable"].includes(bound.availability)) ||
      (bound &&
        !comparableControl(bound) &&
        !bound.pickerIdentity &&
        !bound.editable &&
        !bound.nativeSelect &&
        snapshot.pageState?.panels.length) ||
      (snapshot.pageState?.panels.length &&
        form.focus === field.id &&
        !bound?.modal &&
        controls.some((c) => c.modal && (c.fieldLabel === field.name || c.name === field.name)))
    ) {
      request.observationRefs.push(...candidates.map((c) => c.ref));
      if (field.intent === "set") request.observationRefs.push(...entries.map((c) => c.ref));
      else request.observationRefs.push(...displays.map((c) => c.ref));
      const key = `form_bind_${field.id}`;
      routing[key] = {};
      request.questions[key] = {
        type: "choice",
        instructions:
          field.intent === "set"
            ? `Locate the control for ${field.name}. Select its input/picker (including a read-only field that may open an editor on click), or ENTRY for a button opening an editor for this field. The button can cover a broader group of settings (e.g. Dimensions opens minimum and maximum length); the individual input need not be visible yet. Use observed names and local context. For shared-label ranges, use explicit labels first, then visual peer order within the matching field group. A current value alone does not identify a field. NONE only if neither a control nor a related editor entry is observed; AMBIGUOUS if indistinguishable. Never choose unrelated navigation or submit controls.`
            : `Locate the CURRENT value of preserve field ${field.name}. Select its input/picker trigger, or DISPLAY for a read-only value established by local label/context. The control's OWN complete text must be the field value, not an editing invitation, aggregate summary or surrounding context. Values are current, never desired. NONE if not observed; AMBIGUOUS if indistinguishable. Never choose navigation, options or submit controls.`,
        criteria: {
          ...Object.fromEntries(
            candidates.map((c) => [
              c.ref,
              [
                c.fieldLabel || c.name.slice(0, 60),
                ...c.context.filter((text) => text.length <= 100).slice(0, 2),
                ...(c.peerGroup
                  ? [
                      `group g${peerKeys.indexOf(c.peerGroup.key) + 1}, position ${c.peerGroup.position} of ${c.peerGroup.count}`,
                    ]
                  : []),
              ].join("; "),
            ]),
          ),
          ...(field.intent === "set"
            ? Object.fromEntries(
                entries.map((c) => [`ENTRY:${c.ref}`, `${c.name.slice(0, 160)} [open editor]`]),
              )
            : {}),
          ...(field.intent === "preserve"
            ? Object.fromEntries(
                displays.map((c) => [
                  `DISPLAY:${c.ref}`,
                  `Read-only value ${JSON.stringify(c.displayText)}; label/context: ${[c.fieldLabel, ...c.context].filter(Boolean).join("; ")}`,
                ]),
              )
            : {}),
          NONE: "No observed control, read-only value or editor entry for this field",
          AMBIGUOUS: "Cannot uniquely bind this field",
        },
      };
    } else if (
      bound &&
      usesSemanticComparison(field, bound) &&
      !field.target &&
      formOptions(bound, controls).length > 0
    ) {
      const options = formOptions(bound, controls).filter((o) => o.label.length <= 500);
      const key = `form_target_${field.id}`;
      routing[key] = {};
      request.observationRefs.push(...options.map((o) => o.id).filter((id) => id.startsWith("@")));
      request.questions[key] = {
        type: "choice",
        instructions: `For delegated field ${field.name}, which currently observed option represents the requested setting ${JSON.stringify(field.expected)} under originalGoal? Select the exact intended setting, preserving units and bounds. This establishes a target mapping, not proof that it is applied. Use ONLY this field's options below; NONE if not present yet, AMBIGUOUS if no unique equivalent.`,
        criteria: {
          ...Object.fromEntries(options.map((o) => [o.id, o.label])),
          NONE: "Requested setting is not in the observed options",
          AMBIGUOUS: "No unique equivalent option",
        },
      };
    } else if (
      bound &&
      field.reason === "needs_current_semantic_judgment" &&
      field.current !== undefined &&
      field.expected !== undefined &&
      field.current.length <= 500 &&
      field.expected.length <= 500
    ) {
      const key = `form_value_${field.id}`;
      routing[key] = {};
      request.questions[key] = {
        type: "choice",
        instructions: `Does CURRENT observed applied value ${JSON.stringify(field.current)} on ${field.name} (bound control: ${bound.name}, role ${bound.role}) mean the same intended field setting as ${JSON.stringify(field.expected)} under originalGoal? Preserve units, bounds and meaning; a different value that merely satisfies a broad predicate is not equivalent. Use current element evidence, never a previous write, query, placeholder or menu option. UNKNOWN if not enough evidence.`,
        criteria: {
          satisfied: "Same requested applied setting",
          unsatisfied: "Different applied setting",
          unknown: "Insufficient evidence",
        },
      };
    }
    if (
      entry &&
      field.reason === "needs_entry_summary_judgment" &&
      field.current &&
      field.current.length <= 500 &&
      field.expected !== undefined &&
      field.expected.length <= 500
    ) {
      const key = `form_summary_${field.id}`;
      routing[key] = {};
      request.questions[key] = {
        type: "choice",
        instructions: `For delegated field ${field.name}, does the CURRENT main-form summary ${JSON.stringify(field.current)} establish its requested applied value ${JSON.stringify(field.expected)}? Use only this field's part of the summary, preserving units and bounds. Interpret standard compact range notation: a trailing shared unit applies to both endpoints (for example, 2–4 cm has lower value 2 cm and upper value 4 cm). A button inviting editing, placeholder, query, available option, or previous action proves no value. UNKNOWN unless the field's current value is explicit. ${field.comparison === "literal" ? "The field value must match literally." : "An exact equivalent field value is acceptable."}`,
        criteria: {
          satisfied: "Explicit current field value matches",
          unsatisfied: "Explicit current field value differs",
          unknown: "Summary does not establish this field value",
        },
      };
    }
  }
  const focus = form.fields.find((f) => f.id === form.focus);
  if (form.panel && focus) {
    request.state = {
      ...z.record(z.unknown()).parse(request.state),
      currentEditor: {
        delegatedField: focus.name,
        relatedFields: form.fields
          .filter((f) => editorFields.includes(f.id))
          .map((f) => ({ name: f.name, expected: f.expected, status: f.status })),
        requestedValue: focus.expected,
        title: snapshot.pageState?.panels,
        controls: controls
          .filter((c) => c.modal)
          .map((c) => ({
            ref: c.ref,
            name: c.name,
            role: c.role,
            editable: c.editable,
            value: c.value,
          })),
      },
    };
  }
  if (form.panel && focus && !form.panel.queryIdentity) {
    const inputs = controls.filter(
      (c) => c.modal && c.editable && ["ready", "offscreen"].includes(c.availability),
    );
    if (inputs.length) {
      routing.form_search = {};
      request.questions.form_search = {
        type: "choice",
        instructions: `Assuming state.currentEditor is the related selector, which input would you type into to FIND its requestedValue among the available choices? The input may say enter a name rather than search. Interpret it within this selector, not as editing the main form name. NONE if there is no lookup input, only actual field editors.`,
        criteria: {
          ...Object.fromEntries(
            inputs.map((c) => [
              c.ref,
              `Use the input ${JSON.stringify(c.name)} to look up an option in this selector`,
            ]),
          ),
          NONE: "No search/filter input",
        },
      };
    }
  }
  if (form.panel?.status === "pending") {
    routing.form_panel = {};
    request.questions.form_panel = {
      type: "choice",
      instructions: `Does state.currentEditor show a selector/editor for its delegatedField? Judge what the dialog is FOR, not whether requestedValue is visible in the currently selected category. Different labels, default subcategories and search navigation are normal within a related selector. MATCH when the title and controls establish the same field concept; OTHER only for a different purpose; UNKNOWN when insufficient.`,
      criteria: {
        MATCH: "Editor for the delegated local operation",
        OTHER: "Unrelated panel",
        UNKNOWN: "Panel ownership cannot be established",
      },
    };
  }
  const operation = request.questions.operation!;
  // Field proofs and the delegated stop condition already define completion.
  // Do not ask a second whole-task judge to reinterpret historical changes.
  delete request.questions.completion;
  if (request.routing) delete request.routing.targets.DONE;
  if (operation.criteria.DONE) {
    operation.criteria.DONE =
      "The delegated fields are currently satisfied at form.stopAt. Return their evidence and observed changes; Roll owns the whole task and final report.";
  }
  operation.instructions +=
    " This is ONE bounded form delegation. executionContext.form.mode is supplied by Roll; an empty field does not mean create. Choose field order from prerequisites, required fields and fresh state. Keep the current related picker/editor focused until applied or blocked. satisfied means current evidence matches; unknown means OBSERVE first, not empty. Repair reset values only in set fields. Never write preserve/unassigned fields or extend the task. Changes are observations after actions, not proof of causality. No host helper exists. DONE only when delegated fields match at executionContext.form.stopAt. applied requires main-form application and closed editors; current-view preserves the requested open editor. Do not save or publish.";
  operation.criteria = Object.fromEntries(
    Object.entries(operation.criteria).filter(([key]) => {
      if (formReady(context, snapshot, pickers)) {
        return ["DONE", "REASSESS", "BLOCKED", "WAIT"].includes(key);
      }
      if (!key.includes(":")) return key !== "DONE" || formReady(context, snapshot, pickers);
      if (key.startsWith("SCROLL_")) return true;
      const parts = key.split(":");
      const ref = parts[1];
      if (!ref) return false;
      const id = formActionOwner(context, ref, controls, pickers);
      if (!id) return false;
      const field = form.fields.find((f) => f.id === id);
      const c = controls.find((c) => c.ref === ref);
      if (!field || field.intent !== "set") return false;
      if (c && field.entry?.identity === c.identity && key.split(":")[0] !== "CLICK") return false;
      const focusedField = form.fields.find((f) => f.id === form.focus);
      const focusedControl = controls.find((c) => c.identity === focusedField?.binding?.identity);
      const focusedPicker = pickers.fields.find((p) => p.triggerRef === focusedControl?.ref);
      if (!form.panel && focusedPicker?.panelVisible && field.id !== focusedField?.id) return false;
      if (field.reason === "needs_current_semantic_judgment") return false;
      if (
        pickers.parts[ref]?.part === "option" &&
        field.comparison !== "literal" &&
        !field.target
      ) {
        return false;
      }
      if (key.startsWith("SELECT:") && field.comparison !== "literal" && !field.target) {
        return false;
      }
      if (
        field.target &&
        pickers.parts[ref]?.part === "option" &&
        (pickers.parts[ref]?.optionLabel ?? pickers.parts[ref]?.optionText) !== field.target.label
      ) {
        return false;
      }
      if (
        field.target &&
        key.startsWith("SELECT:") &&
        c?.options?.[Number(parts[2])]?.label !== field.target.label
      ) {
        return false;
      }
      if (
        field.status === "unknown" &&
        (key.startsWith("TYPE_TEXT:") || key.startsWith("SELECT:")) &&
        !(c?.valueKind === "query" && form.focus === field.id) &&
        c?.identity !== form.panel?.queryIdentity
      ) {
        return false;
      }

      if (form.panel && form.panel.status !== "accepted") return false;
      if (snapshot.pageState?.panels.length && !c?.modal) return false;
      const pickerId = pickers.parts[ref]?.fieldId;
      const picker = pickers.fields.find((p) => p.id === pickerId);
      if (
        field.status === "satisfied" &&
        c?.identity === field.binding?.identity &&
        !(key.startsWith("CLICK:") && picker?.panelVisible && picker.triggerRef === ref)
      ) {
        return false;
      }
      if (field.status === "satisfied" && pickers.parts[ref]?.part === "option") return false;

      if (field.status === "satisfied" && !form.panel && !picker?.panelVisible) return false;
      return true;
    }),
  );
  // Form scope removed these actions; their speculative value heads are unused.
  if (request.routing) {
    request.routing.targets = Object.fromEntries(
      Object.entries(request.routing.targets).filter(([action]) =>
        Object.hasOwn(operation.criteria, action),
      ),
    );
    const used = new Set(Object.values(request.routing.targets));
    for (const key of Object.keys(request.questions)) {
      if (key.startsWith("type_value_") && !used.has(key)) delete request.questions[key];
    }
  }
  // A local editor decision needs its controls, not the surrounding record page.
  // The full delegation remains in ExecutionContext and is checked before dispatch.
  if (form.panel && focus) {
    const view = z.record(z.unknown()).parse(request.state);
    const refs = new Set(
      controls.filter((c) => c.modal || c.identity === focus.binding?.identity).map((c) => c.ref),
    );
    const rows = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((row) => {
            const record = z.record(z.unknown()).parse(row);
            return typeof record.ref === "string" && refs.has(record.ref);
          })
        : value;
    const executionView = z.record(z.unknown()).parse(view.executionContext);
    const formView = z.record(z.unknown()).parse(executionView.form);
    const fields = z.array(z.record(z.unknown())).parse(formView.fields);
    request.state = {
      ...view,
      pageText: undefined,
      pageTextTruncated: true,
      elements: rows(view.elements),
      formControls: rows(view.formControls),
      executionContext: {
        ...executionView,
        changes: [],
        form: {
          ...formView,
          fields: fields.filter((f) => typeof f.id === "string" && editorFields.includes(f.id)),
          deferredFieldCount: fields.length - editorFields.length,
        },
      },
      observationScope:
        "Current delegated field editor; the execution loop retains and rechecks all other fields when this editor closes.",
    };
  }
  request.observationRefs = [...new Set(request.observationRefs)];
  request.evidenceRouting = routing;
  return request;
}

/** Commit only current-observation bindings/judgments; a change invalidates the old action branch. */
export function acceptFormDecisions(
  context: ExecutionContext,
  snapshot: GoalSnapshot,
  controls: readonly FormControl[],
  choices: Record<string, string>,
): { changed: boolean; error?: string } {
  const form = context.form;
  if (!form) return { changed: false };
  const before = JSON.stringify(form);
  if (choices.form_panel) {
    if (choices.form_panel !== "MATCH") {
      return {
        changed: false,
        error: "Current panel is not confirmed within this form delegation",
      };
    }
    if (form.panel) form.panel.status = "accepted";
  }
  if (choices.form_search && choices.form_search !== "NONE") {
    const c = controls.find((c) => c.ref === choices.form_search);
    if (!form.panel || !c?.modal || !c.editable) {
      return { changed: false, error: "Search input is not in the current related editor" };
    }
    form.panel.queryIdentity = c.identity;
  }
  for (const field of form.fields) {
    const selected = choices[`form_bind_${field.id}`];
    if (selected === "AMBIGUOUS") {
      // One unresolved child must not discard a sibling's usable binding.
      // Leave this field unbound; normal progress/stall handling owns escalation.
      if (field.binding) context.ownership.delete(field.binding.identity);
      delete field.binding;
      delete field.target;
      delete field.semanticProof;
      continue;
    }
    if (selected?.startsWith("DISPLAY:")) {
      const c = controls.find((c) => c.ref === selected.slice(8));
      if (field.intent !== "preserve" || !c || preserveDisplayValue(c) === undefined) {
        return {
          changed: false,
          error: "Display evidence is only valid for a readable preserve field",
        };
      }
      if (form.fields.some((f) => f.id !== field.id && f.binding?.identity === c.identity)) {
        return {
          changed: false,
          error: "Distinct delegated fields were bound to the same display",
        };
      }
      field.binding = {
        identity: c.identity,
        key: entryBindingKey(c),
        name: c.name,
        role: c.role,
        readOnlyDisplay: true,
        ...(c.fieldLabel ? { fieldLabel: c.fieldLabel } : {}),
      };
      context.ownership.set(c.identity, { field: field.name, intent: "preserve" });
    } else if (selected?.startsWith("ENTRY:")) {
      const c = controls.find((c) => c.ref === selected.slice(6));
      if (field.intent !== "set" || !c || !isEditorEntry(c)) {
        return {
          changed: false,
          error: "Editor entry is not current usable evidence for a writable field",
        };
      }
      field.entry = { identity: c.identity, key: entryBindingKey(c), name: c.name, role: c.role };
    } else if (selected && selected !== "NONE") {
      const c = controls.find((c) => c.ref === selected);
      if (
        !c ||
        (!["ready", "offscreen"].includes(c.availability) && !comparableControl(c)) ||
        c.valueKind === "option-label"
      ) {
        return { changed: false, error: "Field binding is not current usable evidence" };
      }
      const duplicate = form.fields.find(
        (f) => f.id !== field.id && f.binding?.identity === c.identity,
      );
      if (duplicate && comparableControl(c)) {
        return {
          changed: false,
          error: "Distinct delegated fields were bound to the same control",
        };
      }
      field.binding = {
        identity: c.identity,
        key: controlBindingKey(c),
        name: c.name,
        role: c.role,
        ...(c.fieldLabel ? { fieldLabel: c.fieldLabel } : {}),
      };
      context.ownership.set(c.identity, { field: field.name, intent: field.intent });
      if (field.semanticProof?.fingerprint !== controlFingerprint(c)) delete field.semanticProof;
    }
    const targetChoice = choices[`form_target_${field.id}`];
    if (targetChoice === "AMBIGUOUS") {
      delete field.target;
      continue;
    }
    if (targetChoice && targetChoice !== "NONE") {
      const c = controls.find((c) => c.identity === field.binding?.identity);
      const options = c ? formOptions(c, controls) : [];
      const option = options.find((o) => o.id === targetChoice);
      if (!c || !option || options.filter((o) => o.label === option.label).length !== 1) {
        return { changed: false, error: "Target option mapping lost its unique current evidence" };
      }
      field.target = {
        key: formTargetKey(c, field.expected),
        label: option.label,
        optionsKey: formOptionsKey(options),
      };
    }
    const status = choices[`form_value_${field.id}`];
    if (status === "satisfied" || status === "unsatisfied") {
      const c = controls.find((c) => c.identity === field.binding?.identity);
      if (!c || !comparableControl(c) || field.fingerprint !== controlFingerprint(c)) {
        return { changed: false, error: "Semantic field judgment lost its current evidence" };
      }
      field.semanticProof = { fingerprint: field.fingerprint, status };
    }
    const summaryStatus = choices[`form_summary_${field.id}`];
    if (
      summaryStatus === "satisfied" ||
      summaryStatus === "unsatisfied" ||
      summaryStatus === "unknown"
    ) {
      const entry = currentFormEntry(field, controls);
      if (
        !entry ||
        snapshot.pageState?.panels.length ||
        field.fingerprint !== entryFingerprint(entry)
      ) {
        return { changed: false, error: "Editor summary judgment lost its current evidence" };
      }
      field.entryProof = { fingerprint: field.fingerprint, status: summaryStatus };
    }
  }
  if (!form.focus && snapshot.pageState?.panels.length) {
    const field = form.fields.find((f) =>
      controls.some((c) => c.identity === f.binding?.identity && c.modal),
    );
    if (field) form.focus = field.id;
  }
  updateFormState(form, controls, context.initial, snapshot.pageState?.panels ?? []);
  return { changed: before !== JSON.stringify(form) };
}
