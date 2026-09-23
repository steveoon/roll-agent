import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { createExecutionContext, observeExecution } from "./execution-context.ts";
import { acceptFormDecisions } from "./form-policy.ts";
import { buildTaskDecisionRequest, taskElements } from "./task-policy.ts";
import { createPickerMemory } from "./picker-state.ts";
import { runBrowserTask } from "./task-loop.ts";
import type { GoalSnapshot } from "./observation.ts";

const input = BrowserOperateInputSchema.parse({
  pageId: "p",
  allowedOrigins: ["https://example.com"],
  goal: "Set Experience to Any experience, Pay to 8; keep Address unchanged.",
  values: [
    { name: "experience", text: "Any experience" },
    { name: "pay", text: "8" },
  ],
  formTask: {
    mode: "edit",
    fields: [
      { name: "Experience", intent: "set", valueName: "experience", comparison: "semantic" },
      { name: "Pay", intent: "set", valueName: "pay" },
      { name: "Address", intent: "preserve" },
    ],
  },
});
function page(name = "不限", value = "不限", pay = "5"): GoalSnapshot {
  const labels = [name, "Pay", "Address"];
  return {
    snapshotId: `${name}/${value}/${pay}`,
    documentId: "doc",
    nodeCount: 3,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
    nodes: labels.map((name, i) => ({
      ref: `@e${i}`,
      name,
      role: i ? "textbox" : "clickable",
      ignored: false,
      depth: 0,
      ...(i ? { value: i === 1 ? pay : "East" } : {}),
    })),
    refs: labels.map((name, i) => ({
      ref: `@e${i}`,
      name,
      role: i ? "textbox" : "clickable",
      nth: 0,
      disabled: false,
      backendNodeId: i + 1,
      frameId: "frame",
    })),
    controls: {
      "@e0": {
        availability: "ready",
        readable: true,
        editable: false,
        context: [],
        picker: {
          part: "trigger",
          relationship: "local-dom",
          triggerPath: "/experience",
          panelPaths: [],
          selection: "value",
          selectionEvidence: "backing-input",
          committedText: value,
        },
      },
      "@e1": {
        availability: "ready",
        readable: true,
        editable: true,
        context: [],
        fieldLabel: "Pay",
        observedValue: pay,
      },
      "@e2": {
        availability: "ready",
        readable: true,
        editable: true,
        context: [],
        fieldLabel: "Address",
        observedValue: "East",
      },
    },
    pageState: { panels: [], selectedTabs: [], busy: false },
  };
}
function bound() {
  const c = createExecutionContext(input);
  const s = page();
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), {
    form_bind_f1: "@e0",
    form_bind_f2: "@e1",
    form_bind_f3: "@e2",
  });
  acceptFormDecisions(c, s, taskElements(s), { form_value_f1: "satisfied" });
  return c;
}
test("picker presentation changes preserve identity and semantic proof; value and owner changes do not", () => {
  const c = bound();
  let s = page("不限 \uE003");
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[0]?.status, "satisfied");
  const request = buildTaskDecisionRequest(
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
  assert.equal(request.questions.form_bind_f1, undefined);
  assert.equal(request.questions.form_value_f1, undefined);
  s = page("1 year", "1 year");
  observeExecution(c, s, taskElements(s));
  assert.ok(c.form?.fields[0]?.binding);
  assert.equal(c.form?.fields[0]?.reason, "needs_current_semantic_judgment");
  s.controls!["@e0"]!.picker!.triggerPath = "/another-field";
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[0]?.binding, undefined);
  assert.equal(c.form?.fields[0]?.status, "unknown");
});
test("a covered fresh applied readback remains evidence but is never directly actionable", () => {
  const c = bound();
  const s = page();
  s.controls!["@e2"]!.availability = "covered";
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[2]?.status, "satisfied");
  const request = buildTaskDecisionRequest(
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
  assert.equal(request.questions.operation!.criteria["CLICK:@e2"], undefined);
  s.controls!["@e2"]!.readable = false;
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[2]?.status, "unknown");
});
test("an unrelated semantic judgment does not discard the same request's valid field write", async () => {
  let pay = "5";
  let calls = 0;
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page("不限", "不限", pay),
      checkTarget: async () => true,
      actionExecuted: () => true,
      invoke: async (method, params) => {
        assert.equal(method, "fill");
        assert.equal(params[1], "8");
        pay = "8";
      },
    },
    async (request) => {
      calls++;
      const operation = calls === 1 ? "WAIT" : pay === "5" ? "TYPE_TEXT:@e1" : "DONE";
      const choices: Record<string, string> = { operation };
      for (const [key, question] of Object.entries(request.questions)) {
        if (key.startsWith("form_bind_")) choices[key] = `@e${Number(key.at(-1)) - 1}`;
        else if (key.startsWith("form_value_")) choices[key] = "satisfied";
        else if (key.startsWith("type_value_")) {
          choices[key] = Object.hasOwn(question.criteria, "v2") ? "v2" : "NONE";
        }
      }
      return {
        choices,
        elapsedMs: 0,
        provider: "test",
        requestedModel: "test",
        resolvedModel: "test",
      };
    },
    AbortSignal.timeout(5000),
  );
  assert.equal(result.status, "interaction_done");
  assert.equal(calls, 3);
  assert.equal(result.steps.filter((s) => s.operation === "UPDATE_EXECUTION_CONTEXT").length, 1);
});
test("explicit literal comparison remains strict even on an enum", () => {
  const strict = BrowserOperateInputSchema.parse({
    ...input,
    formTask: {
      mode: "edit",
      fields: [
        { name: "Experience", intent: "set", valueName: "experience", comparison: "literal" },
      ],
    },
  });
  const c = createExecutionContext(strict);
  const s = page();
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f1: "@e0" });
  assert.equal(c.form?.fields[0]?.reason, "current_value_differs");
});

test("enum mappings survive display changes and resets but expire when options or owner change", () => {
  const auto = BrowserOperateInputSchema.parse({
    ...input,
    formTask: {
      mode: "edit",
      fields: [{ name: "Experience", intent: "set", valueName: "experience" }],
    },
  });
  const c = createExecutionContext(auto);
  const s = page();
  const options = (labels: string[]) => {
    s.refs = s.refs.filter((r) => !r.ref.startsWith("@option"));
    s.nodes = s.nodes.filter((r) => !r.ref?.startsWith("@option"));
    for (const key of Object.keys(s.controls!)) {
      if (key.startsWith("@option")) delete s.controls![key];
    }
    labels.forEach((label, i) => {
      const ref = `@option${i}`;
      s.refs.push({
        ref,
        name: label,
        role: "option",
        frameId: "frame",
        nth: 0,
        backendNodeId: i + 20,
        disabled: false,
      });
      s.nodes.push({ ref, name: label, role: "option", ignored: false, depth: 0 });
      s.controls![ref] = {
        availability: "offscreen",
        editable: false,
        readable: true,
        context: [],
        displayText: label,
        picker: {
          part: "option",
          relationship: "local-dom",
          triggerPath: "/experience",
          panelPaths: [],
          selection: "unknown",
          selectionEvidence: "unknown",
          optionText: label,
        },
      };
    });
  };
  options(["不限", "1年以内"]);
  observeExecution(c, s, taskElements(s));
  acceptFormDecisions(c, s, taskElements(s), { form_bind_f1: "@e0" });
  const request = buildTaskDecisionRequest(
    auto,
    s,
    [],
    "",
    new Set(),
    [],
    createPickerMemory().observe(s),
    undefined,
    c,
  );
  assert.ok(request.questions.form_target_f1?.criteria["@option0"]);
  assert.equal(request.questions.operation!.criteria["CLICK:@option0"], undefined);
  acceptFormDecisions(c, s, taskElements(s), { form_target_f1: "@option0" });
  assert.equal(c.form?.fields[0]?.reason, "current_mapped_option_match");
  const next = page("1年以内", "1年以内");
  observeExecution(c, next, taskElements(next));
  assert.equal(c.form?.fields[0]?.reason, "mapped_option_differs");
  assert.equal(c.form?.fields[0]?.target?.label, "不限");
  s.refs[0]!.name = "不限 \uE003";
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[0]?.status, "satisfied");
  const wire = JSON.stringify(
    buildTaskDecisionRequest(
      auto,
      s,
      [],
      "",
      new Set(),
      [],
      createPickerMemory().observe(s),
      undefined,
      c,
    ).state,
  );
  assert.ok(!wire.includes(c.form!.fields[0]!.binding!.key!));
  options(["不限", "2年以上"]);
  observeExecution(c, s, taskElements(s));
  assert.equal(c.form?.fields[0]?.target, undefined);
  assert.equal(c.form?.fields[0]?.reason, "needs_option_mapping");
});
