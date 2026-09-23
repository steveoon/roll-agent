import assert from "node:assert/strict";
import test from "node:test";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { createExecutionContext, observeExecution } from "./execution-context.ts";
import { acceptFormDecisions, formReady, formActionOwner } from "./form-policy.ts";
import { taskElements, buildTaskDecisionRequest } from "./task-policy.ts";
import { createPickerMemory } from "./picker-state.ts";
import { compactTaskRequest } from "./compact-request.ts";
import { PickerEvidenceSchema } from "./picker-observation.ts";
import type { GoalSnapshot } from "./observation.ts";

const input = BrowserOperateInputSchema.parse({
  pageId: "p",
  allowedOrigins: ["https://example.com"],
  goal: "Set minimum length to 4 and maximum length to 9; preserve address. Do not Delete.",
  blockedNames: ["Delete"],
  values: [
    { name: "low", text: "4" },
    { name: "high", text: "9" },
  ],
  formTask: {
    mode: "edit",
    fields: [
      { name: "Minimum length", intent: "set", valueName: "low" },
      { name: "Maximum length", intent: "set", valueName: "high" },
      { name: "Address", intent: "preserve" },
    ],
  },
});
function page(text = "Length: 2–6", open = false): GoalSnapshot {
  const names = open
    ? ["Minimum length", "Maximum length", "Apply", "Address"]
    : [text, "Delete", "Other settings", "Address"];
  return {
    snapshotId: `${text}-${open}`,
    documentId: "d",
    maxNodes: 240,
    nodeCount: 4,
    truncated: false,
    interactiveOnly: true,
    refs: names.map((name, i) => ({
      ref: `@e${i}`,
      role: (open && i < 2) || i === 3 ? "textbox" : "clickable",
      name,
      nth: 0,
      disabled: false,
      backendNodeId: (open && i < 3 ? 10 : 1) + i,
    })),
    nodes: names.map((name, i) => ({
      ref: `@e${i}`,
      role: (open && i < 2) || i === 3 ? "textbox" : "clickable",
      name,
      ignored: false,
      depth: 0,
    })),
    controls: Object.fromEntries(
      names.map((name, i) => [
        `@e${i}`,
        {
          availability: "ready",
          editable: (open && i < 2) || i === 3,
          readable: true,
          context: [i === 3 ? "Delivery" : "Dimensions"],
          ...(open && i < 3 ? { modal: true } : {}),
          ...((open && i < 2) || i === 3
            ? { fieldLabel: name, observedValue: i === 3 ? "East" : i === 0 ? "4" : "8" }
            : { displayText: name }),
        },
      ]),
    ),
    pageState: { panels: open ? ["Edit dimensions"] : [], selectedTabs: [], busy: false },
  };
}
function setup() {
  const c = createExecutionContext(input);
  const s = page();
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f3: "@e3" });
  return { c, s };
}
function request(c: ReturnType<typeof createExecutionContext>, s: GoalSnapshot) {
  return buildTaskDecisionRequest(
    input,
    s,
    [],
    "",
    new Set(),
    [],
    createPickerMemory().observe(s),
    undefined,
    c,
  );
}
test("display-only entries survive compaction but need a field relation before clicking", () => {
  const { c, s } = setup();
  const r = compactTaskRequest(request(c, s));
  assert.ok(r.questions.form_bind_f1!.criteria["ENTRY:@e0"]);
  assert.equal(r.questions.form_bind_f1!.criteria["ENTRY:@e1"], undefined);
  assert.equal(r.questions.form_bind_f3?.criteria["ENTRY:@e0"], undefined);
  assert.ok(JSON.stringify(r.state).includes("Length: 2–6"));
  assert.equal(r.questions.operation!.criteria["CLICK:@e0"], undefined);
  acceptFormDecisions(c, s, taskElements(s), {
    form_bind_f1: "ENTRY:@e0",
    form_bind_f2: "ENTRY:@e0",
  });
  assert.equal(c.form!.fields[0]!.binding, undefined);
  assert.equal(c.form!.fields[0]!.status, "unknown");
  const bound = request(c, s);
  assert.ok(bound.questions.operation!.criteria["CLICK:@e0"]);
  assert.equal(bound.questions.operation!.criteria["CLICK:@e2"], undefined);
  assert.equal(bound.questions.operation!.criteria["TYPE_TEXT:@e0"], undefined);
  assert.equal(bound.questions.operation!.criteria.DONE, undefined);
});
test("a shared generic entry exposes both delegated inputs in its editor, preserving unrelated scope", () => {
  const { c, s } = setup();
  acceptFormDecisions(c, s, taskElements(s), {
    form_bind_f1: "ENTRY:@e0",
    form_bind_f2: "ENTRY:@e0",
  });
  c.form!.focus = "f1";
  const modal = page("Length: 2–6", true);
  observeExecution(c, modal, taskElements(modal));
  const r = request(c, modal);
  assert.ok(r.questions.form_bind_f1);
  assert.ok(r.questions.form_bind_f2);
  assert.equal(r.questions.form_bind_f3, undefined);
  assert.equal(r.questions.form_summary_f1, undefined);
  assert.equal(
    acceptFormDecisions(c, modal, taskElements(modal), {
      form_panel: "MATCH",
      form_bind_f1: "@e0",
      form_bind_f2: "@e1",
    }).error,
    undefined,
  );
  assert.ok(request(c, modal).questions.operation!.criteria["TYPE_TEXT:@e1"]);
  assert.equal(request(c, modal).questions.operation!.criteria["TYPE_TEXT:@e3"], undefined);
  assert.equal(formReady(c, modal, createPickerMemory().observe(modal)), false);
});
test("fresh summary judgments are field-specific, survive stable observations, and expire on change", () => {
  const { c } = setup();
  let s = page("Length: 4–8");
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), {
    form_bind_f1: "ENTRY:@e0",
    form_bind_f2: "ENTRY:@e0",
  });
  const r = request(c, s);
  assert.match(r.questions.form_summary_f2!.instructions, /Maximum length.*4–8.*9/u);
  acceptFormDecisions(c, s, taskElements(s), {
    form_summary_f1: "satisfied",
    form_summary_f2: "unsatisfied",
  });
  observeExecution(c, s, taskElements(s));
  assert.deepEqual(
    c.form!.fields.slice(0, 2).map((f) => f.status),
    ["satisfied", "unsatisfied"],
  );
  assert.equal(formReady(c, s, createPickerMemory().observe(s)), false);
  assert.equal(request(c, s).questions.form_summary_f1, undefined);
  s = page("Length: 4–9");
  observeExecution(c, s, taskElements(s));
  assert.ok(c.form!.fields[0]!.entry);
  assert.equal(request(c, s).questions.form_bind_f1, undefined);
  assert.ok(request(c, s).questions.form_summary_f1);
  acceptFormDecisions(c, s, taskElements(s), {
    form_summary_f1: "satisfied",
    form_summary_f2: "satisfied",
  });
  assert.ok(formReady(c, s, createPickerMemory().observe(s)));
  s.refs[0]!.backendNodeId = 999;
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form!.fields[0]!.status, "unknown");
  assert.equal(request(c, s).questions.operation!.criteria["CLICK:@e0"], undefined);
});
test("covered, hidden, disabled and preserve targets cannot become editor entries", () => {
  for (const kind of ["covered", "hidden", "disabled", "preserve"] as const) {
    const { c, s } = setup();
    if (kind === "covered" || kind === "hidden") s.controls!["@e0"]!.availability = kind;
    if (kind === "disabled") s.refs[0]!.disabled = true;
    const key = kind === "preserve" ? "form_bind_f3" : "form_bind_f1";
    const r = acceptFormDecisions(c, s, taskElements(s), { [key]: "ENTRY:@e0" });
    assert.ok(r.error, kind);
  }
});

test("entry labels survive their own summary changes but not a different surrounding field", () => {
  const { c } = setup();
  let s = page("Length: 2–6");
  s.controls!["@e0"]!.context = ["Dimensions Length: 2–6"];
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f1: "ENTRY:@e0" });
  s = page("Length: 4–9");
  s.controls!["@e0"]!.context = ["Dimensions Length: 4–9"];
  observeExecution(c, s, taskElements(s));
  assert.ok(c.form!.fields[0]!.entry);
  assert.ok(request(c, s).questions.form_summary_f1);
  s.controls!["@e0"]!.context = ["Unrelated configuration"];
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form!.fields[0]!.entry, undefined);
  assert.equal(request(c, s).questions.operation!.criteria["CLICK:@e0"], undefined);
});

test("binding alternatives carry surrounding field meaning, not only an ordinal", () => {
  const { c, s } = setup();
  s.controls!["@e3"]!.fieldLabel = "";
  s.refs[3]!.name = "Any";
  const r = request(createExecutionContext(input), s);
  assert.match(r.questions.form_bind_f1!.criteria["@e3"]!, /Delivery/);
  assert.equal(c.form!.fields[2]!.intent, "preserve");
});

test("an empty bound picker in an editor advances to option mapping instead of rebinding", () => {
  const { c, s } = setup();
  acceptFormDecisions(c, s, taskElements(s), {
    form_bind_f1: "ENTRY:@e0",
    form_bind_f2: "ENTRY:@e0",
  });
  c.form!.focus = "f1";
  const modal = page("", true);
  modal.refs[0]!.role = "clickable";
  modal.nodes[0]!.role = "clickable";
  modal.controls!["@e0"] = {
    availability: "ready",
    editable: false,
    context: ["Dimensions"],
    modal: true,
    picker: PickerEvidenceSchema.parse({
      part: "trigger",
      relationship: "local-dom",
      triggerPath: "/low",
      panelPaths: ["/low/menu"],
      expanded: true,
      panelVisible: true,
      selection: "empty",
      selectionEvidence: "backing-input",
      label: "Minimum length",
    }),
  };
  modal.refs.push({
    ref: "@option",
    name: "4",
    role: "clickable",
    nth: 0,
    disabled: false,
    backendNodeId: 99,
  });
  modal.nodes.push({ ref: "@option", name: "4", role: "clickable", depth: 0, ignored: false });
  modal.controls!["@option"] = {
    availability: "ready",
    editable: false,
    context: [],
    modal: true,
    picker: PickerEvidenceSchema.parse({
      part: "option",
      relationship: "local-dom",
      triggerPath: "/low",
      panelPaths: ["/low/menu"],
      optionText: "4",
      optionLabel: "4",
      selection: "unknown",
      selectionEvidence: "unknown",
    }),
  };
  observeExecution(c, modal, taskElements(modal));
  acceptFormDecisions(c, modal, taskElements(modal), { form_panel: "MATCH", form_bind_f1: "@e0" });
  const r = request(c, modal);
  assert.equal(r.questions.form_bind_f1, undefined);
  assert.equal(r.questions.form_target_f1!.criteria["@option"], "4");
  assert.equal(c.form!.fields[0]!.status, "unknown");
  acceptFormDecisions(c, modal, taskElements(modal), { form_target_f1: "@option" });
  assert.ok(request(c, modal).questions.operation!.criteria["CLICK:@option"]);
  assert.equal(formReady(c, modal, createPickerMemory().observe(modal)), false);
});

test("editor entry descriptions lead with observed labels under compact previews", () => {
  const { c, s } = setup();
  const r = request(c, s);
  assert.ok(r.questions.form_bind_f1!.criteria["ENTRY:@e0"]!.startsWith("Length: 2–6"));
  assert.match(r.questions.form_bind_f1!.instructions, /broader group of settings/);
});

test("scroll-revealable editor entries remain bindable without gaining direct click permission", () => {
  const { c, s } = setup();
  s.controls!["@e0"]!.availability = "offscreen";
  s.controls!["@e0"]!.revealViaScroll = true;
  s.controls!["@e0"]!.scrollContainerPaths = ["/main"];
  s.controls!["@e3"]!.scrollContainerPaths = ["/main"];
  const r = request(c, s);
  assert.ok(r.questions.form_bind_f1!.criteria["ENTRY:@e0"]);
  assert.equal(r.questions.form_bind_f1!.criteria["ENTRY:@e1"], undefined);
  assert.equal(r.questions.operation!.criteria["CLICK:@e0"], undefined);
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f1: "ENTRY:@e0" });
  const bound = request(c, s);
  assert.equal(bound.questions.operation!.criteria["CLICK:@e0"], undefined);
  assert.ok(bound.questions.operation!.criteria["SCROLL_DOWN:@e3"]);
  s.controls!["@e0"]!.availability = "ready";
  delete s.controls!["@e0"]!.revealViaScroll;
  observeExecution(c, s, taskElements(s));
  assert.ok(request(c, s).questions.operation!.criteria["CLICK:@e0"]);
});

test("an ambiguous child remains unbound while a known sibling can make local progress", () => {
  const { c } = setup();
  c.form!.focus = "f1";
  const s = page("", true);
  s.controls!["@e0"]!.observedValue = "2";
  observeExecution(c, s, taskElements(s));
  const accepted = acceptFormDecisions(c, s, taskElements(s), {
    form_panel: "MATCH",
    form_bind_f1: "@e0",
    form_bind_f2: "AMBIGUOUS",
  });
  assert.equal(accepted.error, undefined);
  assert.ok(accepted.changed);
  assert.ok(c.form!.fields[0]!.binding);
  assert.equal(c.form!.fields[1]!.binding, undefined);
  assert.equal(c.form!.fields[1]!.status, "unknown");
  const r = request(c, s);
  assert.ok(r.questions.operation!.criteria["TYPE_TEXT:@e0"]);
  assert.equal(r.questions.operation!.criteria["TYPE_TEXT:@e1"], undefined);
  assert.equal(r.questions.operation!.criteria.DONE, undefined);
});

test("a multi-control editor cannot use its focus as blanket ownership of unrelated pickers", () => {
  const { c, s } = setup();
  acceptFormDecisions(c, s, taskElements(s), {
    form_bind_f1: "ENTRY:@e0",
    form_bind_f2: "ENTRY:@e0",
  });
  c.form!.focus = "f1";
  const modal = page("Length: 2–6", true);
  for (const i of [0, 1, 2]) {
    modal.refs[i]!.role = "clickable";
    const control = modal.controls![`@e${i}`]!;
    control.editable = false;
    control.picker = {
      part: "trigger",
      relationship: "local-dom",
      triggerPath: `/picker${i}`,
      panelPaths: [],
      selection: "value",
      selectionEvidence: "backing-input",
      committedText: i === 0 ? "2" : "6",
    };
  }
  const controls = taskElements(modal);
  observeExecution(c, modal, controls);
  acceptFormDecisions(c, modal, controls, {
    form_panel: "MATCH",
    form_bind_f1: "@e0",
    form_bind_f2: "@e1",
  });
  const pickers = createPickerMemory().observe(modal);
  assert.equal(formActionOwner(c, "@e0", controls, pickers), "f1");
  assert.equal(formActionOwner(c, "@e1", controls, pickers), "f2");
  assert.equal(formActionOwner(c, "@e2", controls, pickers), undefined);
  assert.equal(request(c, modal).questions.operation!.criteria["CLICK:@e2"], undefined);
});
