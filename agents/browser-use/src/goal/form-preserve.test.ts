import assert from "node:assert/strict";
import test from "node:test";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { createExecutionContext, observeExecution } from "./execution-context.ts";
import { acceptFormDecisions, formActionOwner, formReady } from "./form-policy.ts";
import { buildTaskDecisionRequest, taskElements } from "./task-policy.ts";
import { compactTaskRequest } from "./compact-request.ts";
import { createPickerMemory } from "./picker-state.ts";
import type { GoalSnapshot } from "./observation.ts";

const input = BrowserOperateInputSchema.parse({
  pageId: "p",
  goal: "Keep the account tier unchanged. Do not save.",
  allowedOrigins: ["https://example.com"],
  values: [],
  formTask: { mode: "edit", fields: [{ name: "Account tier", intent: "preserve" }] },
});
function page(
  value = "Standard",
  availability: "ready" | "covered" | "hidden" | "offscreen" = "ready",
): GoalSnapshot {
  return {
    documentId: "d",
    snapshotId: `${value}-${availability}`,
    nodeCount: 1,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
    refs: [
      { ref: "@tier", role: "clickable", name: value, nth: 0, disabled: false, backendNodeId: 1 },
    ],
    nodes: [{ ref: "@tier", role: "clickable", name: value, ignored: false, depth: 0 }],
    controls: {
      "@tier": {
        availability,
        readable: true,
        editable: false,
        context: [`Account tier ${value}`],
        displayText: value,
      },
    },
    pageState: { panels: [], selectedTabs: [], busy: false },
  };
}
function setup(s = page()) {
  const c = createExecutionContext(input);
  observeExecution(c, s, taskElements(s));
  return c;
}
function bind(c: ReturnType<typeof setup>, s: GoalSnapshot) {
  return acceptFormDecisions(c, s, taskElements(s), { form_bind_f1: "DISPLAY:@tier" });
}
function request(c: ReturnType<typeof setup>, s: GoalSnapshot) {
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
test("display preserve binds own text, compares code-side and grants no click or write", () => {
  const s = page();
  const c = setup(s);
  assert.ok(request(c, s).questions.form_bind_f1?.criteria["DISPLAY:@tier"]);
  const compact = compactTaskRequest(request(c, s));
  assert.ok(compact.questions.form_bind_f1?.criteria["DISPLAY:@tier"]);
  assert.ok(compact.observationRefs?.includes("@tier"));
  assert.equal(bind(c, s).error, undefined);
  assert.equal(c.form?.fields[0]?.initial, "Standard");
  assert.equal(c.form?.fields[0]?.status, "satisfied");
  assert.equal(
    formActionOwner(c, "@tier", taskElements(s), createPickerMemory().observe(s)),
    undefined,
  );
  assert.equal(request(c, s).questions.operation?.criteria["CLICK:@tier"], undefined);
  assert.equal(formReady(c, s, createPickerMemory().observe(s)), true);
  const changed = page("Enterprise");
  observeExecution(c, changed, taskElements(changed));
  assert.equal(c.form?.fields[0]?.status, "unsatisfied");
  assert.equal(c.form?.fields[0]?.expected, "Standard");
  assert.equal(c.form?.fields[0]?.current, "Enterprise");
  assert.ok(c.summary.changes.some((x) => x.kind === "changed" && x.scope === "preserved"));
  assert.equal(request(c, changed).questions.operation?.criteria["CLICK:@tier"], undefined);
});
test("covered and hidden static evidence becomes unknown even when readable flag is true", () => {
  for (const visibility of ["covered", "hidden"] as const) {
    const s = page();
    const c = setup(s);
    bind(c, s);
    const next = page("Standard", visibility);
    observeExecution(c, next, taskElements(next));
    assert.equal(c.form?.fields[0]?.status, "unknown");
    assert.equal(request(c, next).questions.operation?.criteria.DONE, undefined);
    observeExecution(c, s, taskElements(s));
    assert.equal(c.form?.fields[0]?.status, "satisfied");
  }
});
test("disappearing static evidence cannot complete; returning evidence uses original baseline", () => {
  const s = page();
  const c = setup(s);
  bind(c, s);
  const absent = { ...s, snapshotId: "absent", refs: [], nodes: [], controls: {} };
  observeExecution(c, absent, []);
  assert.equal(c.form?.fields[0]?.status, "unknown");
  const next = page("Enterprise");
  observeExecution(c, next, taskElements(next));
  bind(c, next);
  assert.equal(c.form?.fields[0]?.status, "unsatisfied");
  assert.equal(c.form?.fields[0]?.expected, "Standard");
});
test("first seen after invocation start does not invent the preserve baseline", () => {
  const absent = { ...page(), refs: [], nodes: [], controls: {} };
  const c = setup(absent);
  const s = page();
  observeExecution(c, s, taskElements(s));
  bind(c, s);
  assert.equal(c.form?.fields[0]?.status, "unknown");
  assert.equal(c.form?.fields[0]?.reason, "initial_value_unavailable");
});
test("context text never substitutes for own display text and unrelated links are not evidence", () => {
  const s = page();
  delete s.controls!["@tier"]!.displayText;
  const c = setup(s);
  assert.equal(request(c, s).questions.form_bind_f1?.criteria["DISPLAY:@tier"], undefined);
  assert.ok(bind(c, s).error);
  const link = page();
  link.refs[0]!.role = "link";
  link.nodes[0]!.role = "link";
  const c2 = setup(link);
  assert.ok(bind(c2, link).error);
});
test("display evidence cannot bind a set field or be reused across a document change", () => {
  const s = page();
  const c = createExecutionContext({
    values: [{ name: "tier", text: "Enterprise" }],
    formTask: {
      mode: "edit",
      stopAt: "applied",
      fields: [{ name: "Account tier", intent: "set", valueName: "tier", comparison: "literal" }],
    },
  });
  observeExecution(c, s, taskElements(s));
  assert.ok(bind(c, s).error);
  const preserved = setup(s);
  bind(preserved, s);
  const navigated = { ...s, documentId: "new" };
  observeExecution(preserved, navigated, taskElements(navigated));
  bind(preserved, navigated);
  assert.equal(preserved.form?.fields[0]?.status, "unknown");
  assert.equal(preserved.form?.fields[0]?.expected, undefined);
  assert.equal(formReady(preserved, navigated, createPickerMemory().observe(navigated)), false);
});

test("changing context identity or truncated display text invalidates preservation evidence", () => {
  const s = page();
  const c = setup(s);
  bind(c, s);
  const unrelated = page();
  unrelated.controls!["@tier"]!.context = ["Unrelated field"];
  observeExecution(c, unrelated, taskElements(unrelated));
  bind(c, unrelated);
  assert.equal(c.form?.fields[0]?.status, "unknown");
  const truncated = page("x".repeat(2000));
  const other = setup(truncated);
  assert.ok(bind(other, truncated).error);
});
