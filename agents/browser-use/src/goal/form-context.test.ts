import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { BrowserOperateInputSchema, BrowserOperateOutputSchema } from "./contracts.ts";
import type { GoalSnapshot } from "./observation.ts";
import { taskElements, buildTaskDecisionRequest } from "./task-policy.ts";
import {
  createExecutionContext,
  observeExecution,
  recordExecutionAction,
} from "./execution-context.ts";
import { acceptFormDecisions, formReady } from "./form-policy.ts";
import { createPickerMemory } from "./picker-state.ts";
import { runBrowserTask } from "./task-loop.ts";
import type { DecisionRequest, DecisionResult } from "./decisions.ts";

const input = BrowserOperateInputSchema.parse({
  pageId: "p",
  goal: "Set Category to New, Pay to 8; keep Address unchanged. Do not save.",
  values: [
    { name: "Category", text: "New" },
    { name: "Pay", text: "8" },
  ],
  formTask: {
    mode: "edit",
    fields: [
      { name: "Category", intent: "set", valueName: "Category" },
      { name: "Pay", intent: "set", valueName: "Pay" },
      { name: "Address", intent: "preserve" },
    ],
  },
  allowedOrigins: ["https://example.com"],
  maxSteps: 25,
});
function page(
  values = { Category: "Old", Pay: "5", Address: "East" },
  hidden: string[] = [],
  modal = false,
): GoalSnapshot {
  const names = ["Category", "Pay", "Address"] as const;
  return {
    snapshotId: `s-${JSON.stringify(values)}-${hidden.join()}`,
    documentId: "d",
    nodeCount: 3,
    maxNodes: 240,
    truncated: hidden.length > 0,
    interactiveOnly: true,
    nodes: names
      .filter((name) => !hidden.includes(name))
      .map((name) => ({
        ref: `@${name}`,
        role: "textbox",
        name,
        value: values[name],
        ignored: false,
        depth: 0,
      })),
    refs: names
      .filter((name) => !hidden.includes(name))
      .map((name) => ({
        ref: `@${name}`,
        role: "textbox",
        name,
        nth: 0,
        disabled: false,
        backendNodeId: names.indexOf(name) + 1,
      })),
    controls: Object.fromEntries(
      names
        .filter((name) => !hidden.includes(name))
        .map((name) => [
          `@${name}`,
          {
            availability: "ready" as const,
            editable: true,
            context: [],
            fieldLabel: name,
            observedValue: values[name],
            modal,
          },
        ]),
    ),
    pageState: { panels: modal ? ["Pay editor"] : [], selectedTabs: [], busy: false },
  };
}
function response(request: DecisionRequest, operation: string): DecisionResult {
  const choices: Record<string, string> = { operation };
  for (const key of Object.keys(request.questions)) {
    if (key.startsWith("form_bind_")) {
      const name = key.endsWith("f1") ? "Category" : key.endsWith("f2") ? "Pay" : "Address";
      choices[key] = Object.hasOwn(request.questions[key]!.criteria, `@${name}`)
        ? `@${name}`
        : "NONE";
    }
  }
  if (operation === "DONE") choices.completion = "COMPLETE";
  if (operation.startsWith("TYPE_TEXT:")) {
    const target = request.routing?.targets[operation];
    assert.ok(target);
    choices[target] = operation.endsWith("Category") ? "v1" : "v2";
  }
  return {
    choices,
    provider: "fixture",
    requestedModel: "fixture",
    resolvedModel: "fixture",
    elapsedMs: 0,
  };
}
function bind() {
  const context = createExecutionContext(input);
  const s = page();
  const controls = taskElements(s);
  observeExecution(context, s, controls);
  acceptFormDecisions(context, s, controls, {
    form_bind_f1: "@Category",
    form_bind_f2: "@Pay",
    form_bind_f3: "@Address",
  });
  return context;
}

test("initial values, applied changes, unknown observations and resets remain distinct", () => {
  const c = bind();
  assert.equal(c.form?.mode, "edit");
  assert.equal(c.form?.fields[0]?.initial, "Old");
  assert.equal(c.form?.fields[2]?.status, "satisfied");
  recordExecutionAction(c, { operation: "TYPE_TEXT", target: "Pay", executed: true }, "f2");
  let s = page({ Category: "Old", Pay: "8", Address: "East" });
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[1]?.status, "satisfied");
  s = page({ Category: "New", Pay: "8", Address: "East" }, ["Pay"]);
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[1]?.status, "unknown");
  assert.ok(c.summary.changes.some((x) => x.kind === "became_unknown"));
  s = page({ Category: "New", Pay: "", Address: "East" });
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f2: "@Pay" });
  assert.equal(c.form?.fields[1]?.status, "unsatisfied");
  assert.ok(
    c.summary.changes.some((x) => x.kind === "changed" && x.before === "8" && x.after === ""),
  );
});

test("scope excludes preserve and unassigned controls; unknown values cannot offer DONE", () => {
  const c = bind();
  const s = page();
  const p = createPickerMemory().observe(s);
  const request = buildTaskDecisionRequest(input, s, [], "", new Set(), [], p, undefined, c);
  assert.ok(request.questions.operation!.criteria["TYPE_TEXT:@Pay"]);
  assert.equal(request.questions.operation!.criteria["TYPE_TEXT:@Address"], undefined);
  assert.equal(request.questions.operation!.criteria.DONE, undefined);
});

test("in-scope dependency resets are repaired locally without rewriting unchanged fields", async () => {
  const values = { Category: "Old", Pay: "5", Address: "East" };
  const writes: string[] = [];
  let decision = 0;
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(values),
      checkTarget: async () => true,
      actionExecuted: () => true,
      invoke: async (method, params) => {
        assert.equal(method, "fill");
        const target = params[0] as { ref: string };
        const key = target.ref.slice(1) as keyof typeof values;
        assert.notEqual(key, "Address");
        values[key] = String(params[1]);
        writes.push(key);
        if (key === "Category") values.Pay = "";
      },
    },
    async (request) => {
      decision++;
      if (decision === 1) return response(request, "WAIT");
      if (values.Category === "Old" && values.Pay === "5") {
        return response(request, "TYPE_TEXT:@Pay");
      }
      if (values.Category === "Old") return response(request, "TYPE_TEXT:@Category");
      if (values.Pay !== "8") return response(request, "TYPE_TEXT:@Pay");
      return response(request, "DONE");
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "interaction_done");
  assert.deepEqual(writes, ["Pay", "Category", "Pay"]);
  assert.deepEqual(values, { Category: "New", Pay: "8", Address: "East" });
  assert.deepEqual(result.textCalls, []);
  assert.ok(
    result.execution?.changes.some((c) => c.field === "Pay" && c.before === "8" && c.after === ""),
  );
  BrowserOperateOutputSchema.parse(result);
});

test("preserve-only indirect change is reported, not automatically restored", async () => {
  const values = { Category: "Old", Pay: "5", Address: "East" };
  let count = 0;
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(values),
      checkTarget: async () => true,
      actionExecuted: () => true,
      invoke: async () => {
        values.Category = "New";
        values.Address = "West";
      },
    },
    async (request) => response(request, count++ === 0 ? "WAIT" : "TYPE_TEXT:@Category"),
    new AbortController().signal,
  );
  assert.equal(result.status, "needs_reasoning");
  assert.equal(values.Address, "West");
  assert.match(result.error ?? "", /preserve-only/);
  assert.ok(result.execution?.changes.some((c) => c.scope === "preserved" && c.after === "West"));
});

test("correct values inside an unapplied editor cannot complete the delegation", () => {
  const c = bind();
  const s = page({ Category: "New", Pay: "8", Address: "East" }, [], true);
  observeExecution(c, s, taskElements(s));
  assert.equal(formReady(c, s, createPickerMemory().observe(s)), false);
});

test("document replacement and late preserve baselines fail closed", () => {
  const c = createExecutionContext(input);
  let s = page(undefined, ["Address"]);
  observeExecution(c, s, taskElements(s));
  s = page();
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f3: "@Address" });
  assert.equal(c.form?.fields[2]?.status, "unknown");
  assert.equal(c.form?.fields[2]?.expected, undefined);
  s = { ...page(), documentId: "new-document" };
  observeExecution(c, s, taskElements(s));
  assert.equal(c.summary.documentChanged, true);
  assert.equal(formReady(c, s, createPickerMemory().observe(s)), false);
});

test("semantic unknown blocks mutation; a changed value invalidates the old semantic proof", () => {
  const i = BrowserOperateInputSchema.parse({
    pageId: "p",
    goal: "Set Pay to 5.0",
    values: [{ name: "Pay", text: "5.0" }],
    formTask: {
      mode: "edit",
      fields: [{ name: "Pay", intent: "set", valueName: "Pay", comparison: "semantic" }],
    },
    allowedOrigins: ["https://example.com"],
  });
  const c = createExecutionContext(i);
  let s = page();
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f1: "@Pay" });
  let request = buildTaskDecisionRequest(
    i,
    s,
    [],
    "",
    new Set(),
    [],
    createPickerMemory().observe(s),
    undefined,
    c,
  );
  assert.equal(request.questions.operation!.criteria["TYPE_TEXT:@Pay"], undefined);
  assert.equal(
    acceptFormDecisions(c, s, taskElements(s), { form_value_f1: "satisfied" }).changed,
    true,
  );
  assert.equal(c.form?.fields[0]?.status, "satisfied");
  s = page({ Category: "Old", Pay: "6", Address: "East" });
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[0]?.status, "unknown");
  request = buildTaskDecisionRequest(
    i,
    s,
    [],
    "",
    new Set(),
    [],
    createPickerMemory().observe(s),
    undefined,
    c,
  );
  assert.equal(request.questions.operation!.criteria.DONE, undefined);
});

test("checkbox satisfaction uses checked state, not the constant input value on", () => {
  const i = BrowserOperateInputSchema.parse({
    pageId: "p",
    goal: "Enable checkbox",
    values: [{ name: "Enabled", text: "true" }],
    formTask: { mode: "edit", fields: [{ name: "Enabled", intent: "set", valueName: "Enabled" }] },
    allowedOrigins: ["https://example.com"],
  });
  const s = page();
  s.refs = [
    {
      ref: "@enabled",
      name: "Enabled",
      role: "checkbox",
      nth: 0,
      disabled: false,
      backendNodeId: 9,
    },
  ];
  s.nodes = [
    { ref: "@enabled", name: "Enabled", role: "checkbox", ignored: false, depth: 0, value: "on" },
  ];
  s.controls = {
    "@enabled": {
      availability: "ready",
      editable: false,
      context: [],
      inputType: "checkbox",
      checked: false,
      observedValue: "on",
    },
  };
  const c = createExecutionContext(i);
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f1: "@enabled" });
  assert.equal(c.form?.fields[0]?.current, "false");
  assert.equal(c.form?.fields[0]?.status, "unsatisfied");
  s.controls["@enabled"]!.checked = true;
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[0]?.status, "satisfied");
});

test("binding-only editor refs survive request compaction without backend identities", () => {
  const i = BrowserOperateInputSchema.parse({
    pageId: "p",
    goal: "Set Pay",
    values: [{ name: "Pay", text: "8" }],
    formTask: { mode: "edit", fields: [{ name: "Pay", intent: "set", valueName: "Pay" }] },
    allowedOrigins: ["https://example.com"],
  });
  const s = page();
  s.refs = [
    {
      ref: "@entry",
      role: "button",
      name: "Edit Pay",
      nth: 0,
      disabled: false,
      backendNodeId: 987654,
    },
  ];
  s.refs.push({
    ref: "@other",
    role: "button",
    name: "Other control",
    nth: 0,
    disabled: false,
    backendNodeId: 987655,
  });
  s.nodes = [];
  s.controls = {
    "@entry": { availability: "ready", editable: false, context: [], fieldLabel: "Pay" },
    "@other": { availability: "ready", editable: false, context: [] },
  };
  const c = createExecutionContext(i);
  observeExecution(c, s, taskElements(s));
  const request = buildTaskDecisionRequest(
    i,
    s,
    [],
    "",
    new Set(),
    [],
    createPickerMemory().observe(s),
    undefined,
    c,
  );
  const state = z
    .object({ elements: z.array(z.object({ ref: z.string(), name: z.string() })) })
    .parse(request.state);
  assert.ok(state.elements.some((e) => e.ref === "@entry" && e.name === "Edit Pay"));
  assert.equal(request.questions.operation!.criteria["CLICK:@entry"], undefined);
  assert.equal(JSON.stringify(request.state).includes("987654"), false);
});

test("uncertain dispatched form action stops without replay even if the final readback matches", async () => {
  const values = { Category: "Old", Pay: "5", Address: "East" };
  let decisions = 0;
  let writes = 0;
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(values),
      checkTarget: async () => true,
      actionExecuted: () => true,
      invoke: async () => {
        writes++;
        values.Pay = "8";
        throw Error("uncertain transport outcome");
      },
    },
    async (request) => response(request, decisions++ === 0 ? "WAIT" : "TYPE_TEXT:@Pay"),
    new AbortController().signal,
  );
  assert.equal(result.status, "failed");
  assert.equal(writes, 1);
  assert.equal(result.execution?.lastAction?.executed, true);
  assert.match(result.execution?.lastAction?.error ?? "", /uncertain/);
});

test("an explicitly invalid field is not satisfied merely because its text matches", () => {
  const c = bind();
  const s = page({ Category: "New", Pay: "8", Address: "East" });
  s.nodes.find((n) => n.ref === "@Pay")!.properties = { invalid: true };
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[1]?.status, "unsatisfied");
  assert.equal(c.form?.fields[1]?.reason, "page_rejected_value");
  assert.equal(formReady(c, s, createPickerMemory().observe(s)), false);
});

test("equal requested values do not allow two delegated fields to share one actual control", () => {
  const i = BrowserOperateInputSchema.parse({
    pageId: "p",
    goal: "Set Pay and Address separately",
    values: [{ name: "same", text: "8" }],
    formTask: {
      mode: "edit",
      fields: [
        { name: "Pay", intent: "set", valueName: "same" },
        { name: "Address", intent: "set", valueName: "same" },
      ],
    },
    allowedOrigins: ["https://example.com"],
  });
  const c = createExecutionContext(i);
  const s = page();
  observeExecution(c, s, taskElements(s));
  const outcome = acceptFormDecisions(c, s, taskElements(s), {
    form_bind_f1: "@Pay",
    form_bind_f2: "@Pay",
  });
  assert.match(outcome.error ?? "", /same control/);
  assert.equal(formReady(c, s, createPickerMemory().observe(s)), false);
});

test("a late in-scope reset at final readback is repaired inside the same invocation", async () => {
  const values = { Category: "Old", Pay: "5", Address: "East" };
  let decisions = 0;
  let reset = false;
  const writes: string[] = [];
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(values),
      checkTarget: async () => true,
      actionExecuted: () => true,
      invoke: async (_method, params) => {
        const locator = params[0];
        assert.ok(locator && typeof locator === "object" && "ref" in locator);
        const key = String(locator.ref).slice(1);
        assert.ok(key === "Category" || key === "Pay");
        values[key] = String(params[1]);
        writes.push(key);
      },
    },
    async (request) => {
      if (decisions++ === 0) return response(request, "WAIT");
      if (values.Category !== "New") return response(request, "TYPE_TEXT:@Category");
      if (values.Pay !== "8") return response(request, "TYPE_TEXT:@Pay");
      if (!reset) {
        reset = true;
        values.Pay = "7";
      }
      return response(request, "DONE");
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "interaction_done");
  assert.deepEqual(writes, ["Category", "Pay", "Pay"]);
  assert.equal(result.execution?.form?.fields.find((f) => f.name === "Pay")?.current, "8");
});
