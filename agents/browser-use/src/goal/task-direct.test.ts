import assert from "node:assert/strict";
import test from "node:test";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { runBrowserTask } from "./task-loop.ts";
import { buildTaskDecisionRequest } from "./task-policy.ts";
import { taskSources } from "./task-sources.ts";
import { validateChoices } from "./decisions.ts";
import type { DecisionProvider, DecisionRequest } from "./decisions.ts";
import type { GoalSnapshot } from "./observation.ts";

const input = BrowserOperateInputSchema.parse({
  pageId: "p",
  goal: "城市填写上海，保留其他字段，停止在发布前。",
  values: [{ name: "城市", text: "上海" }],
  allowedOrigins: ["https://example.com"],
  blockedNames: ["发布"],
  maxSteps: 8,
});
function page(value = "", backend = 1): GoalSnapshot {
  return {
    snapshotId: `s-${value}-${backend}`,
    documentId: "d",
    nodeCount: 2,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
    nodes: [
      { ref: "@e1", role: "textbox", name: "城市", value, ignored: false, depth: 0 },
      { ref: "@e2", role: "button", name: "发布", ignored: false, depth: 0 },
    ],
    refs: [
      {
        ref: "@e1",
        role: "textbox",
        name: "城市",
        nth: 0,
        disabled: false,
        backendNodeId: backend,
      },
      { ref: "@e2", role: "button", name: "发布", nth: 0, disabled: false, backendNodeId: 2 },
    ],
    controls: { "@e1": { availability: "ready", editable: true, context: [], required: true } },
  };
}
function answer(choices: Record<string, string>): Awaited<ReturnType<DecisionProvider>> {
  const targetHead = (choices.operation ?? "").toLowerCase() + "_target";
  const target = choices[targetHead];
  if (target) {
    choices = { ...choices, operation: `${choices.operation}:${target}` };
    delete choices[targetHead];
  }
  if (choices.operation === "DONE" && !choices.completion) choices.completion = "COMPLETE";
  return { choices, requestedModel: "test", resolvedModel: "test", provider: "test", elapsedMs: 0 };
}
function type(request: DecisionRequest, ref = "@e1", source = "v1") {
  const head = request.routing?.targets[`TYPE_TEXT:${ref}`];
  assert.ok(head);
  return answer({ operation: "TYPE_TEXT", type_text_target: ref, [head]: source });
}

test("task loop fills caller text without any helper and returns an unverified final observation", async () => {
  let value = "";
  let actions = 0;
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(value),
      invoke: async (method, args) => {
        assert.equal(method, "fill");
        value = String(args[1]);
        actions++;
      },
      actionExecuted: () => true,
    },
    async (request) => (value ? answer({ operation: "DONE" }) : type(request)),
    new AbortController().signal,
  );
  assert.equal(value, "上海");
  assert.equal(actions, 1);
  assert.equal(result.status, "model_done");
  assert.equal(result.verified, false);
  assert.deepEqual(result.textCalls, []);
  assert.equal(result.recoveryDecisions, 0);
  assert.ok(result.finalObservation);
  assert.equal(result.resolvedValues?.[0]?.text, "上海");
});

test("only the selected field's value answer is required; unused speculative answers are ignored", () => {
  const request = buildTaskDecisionRequest(input, page(), []);
  validateChoices(request, type(request).choices);
  validateChoices(request, {
    operation: "DONE",
    completion: "COMPLETE",
    type_text_target: "unoffered",
  });
  assert.throws(() =>
    validateChoices(request, { operation: "TYPE_TEXT", type_text_target: "@e1" }),
  );
  const choices = type(request, "@e1", "invented").choices;
  assert.throws(() => validateChoices(request, choices));
});

test("missing source returns the affected field to Roll without inventing or invoking helpers", async () => {
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(),
      invoke: async () => assert.fail("no mutation"),
      actionExecuted: () => false,
    },
    async (request) => type(request, "@e1", "NONE"),
    new AbortController().signal,
  );
  assert.equal(result.status, "needs_input");
  assert.match(result.question ?? "", /城市/);
  assert.deepEqual(result.textCalls, []);
});

test("an editor can be opened without resolving a value for its trigger", async () => {
  const snapshot = page();
  snapshot.refs[0]!.role = "button";
  snapshot.refs[0]!.name = "补充薪资明细";
  snapshot.nodes[0]!.role = "button";
  snapshot.nodes[0]!.name = "补充薪资明细";
  snapshot.controls!["@e1"]!.editable = false;
  let opened = false;
  const result = await runBrowserTask(
    input,
    {
      observe: async () => snapshot,
      invoke: async (method) => {
        assert.equal(method, "click");
        opened = true;
      },
      actionExecuted: () => true,
    },
    async () =>
      opened ? answer({ operation: "DONE" }) : answer({ operation: "CLICK", click_target: "@e1" }),
    new AbortController().signal,
  );
  assert.ok(opened);
  assert.equal(result.status, "model_done");
  assert.deepEqual(result.textCalls, []);
});

test("required fields and dependencies are supplied to Jev without prescribing a fixed field order", () => {
  const request = buildTaskDecisionRequest(input, page(), []);
  const state = request.state as { elements: { required?: boolean; editable?: boolean }[] };
  assert.equal(state.elements[0]?.required, true);
  assert.equal(state.elements[0]?.editable, true);
  assert.match(request.questions.operation!.instructions, /prerequisite/i);
  assert.equal(request.questions.operation?.criteria["CLICK:@e2"], undefined);
});

test("stale target cannot dispatch, unrelated page text does not block a stable target", async () => {
  for (const replaced of [true, false]) {
    let observed = 0;
    let actions = 0;
    const result = await runBrowserTask(
      { ...input, maxSteps: 1 },
      {
        observe: async () => ({
          ...page("", replaced && observed++ ? 3 : 1),
          pageText: `clock ${observed++}`,
        }),
        invoke: async () => {
          actions++;
        },
        actionExecuted: () => true,
      },
      async (request) => type(request),
      new AbortController().signal,
    );
    assert.equal(actions, replaced ? 0 : 1);
    if (replaced) assert.equal(result.steps[0]?.operation, "STALE_DECISION");
  }
});

test("uncertain mutation terminates without replay", async () => {
  let actions = 0;
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(),
      invoke: async () => {
        actions++;
        throw new Error("readback failed after fill");
      },
      actionExecuted: () => true,
    },
    async (request) => type(request),
    new AbortController().signal,
  );
  assert.equal(actions, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.executed, true);
});

test("cancellation after inference cannot dispatch a late action", async () => {
  const controller = new AbortController();
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(),
      invoke: async () => assert.fail("no late action"),
      actionExecuted: () => false,
    },
    async (request) => {
      controller.abort();
      return type(request);
    },
    controller.signal,
  );
  assert.equal(result.status, "cancelled");
});

test("stagnation returns to Roll without a hidden fallback model", async () => {
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(),
      invoke: async () => undefined,
      actionExecuted: () => false,
    },
    async () => answer({ operation: "WAIT" }),
    new AbortController().signal,
  );
  assert.equal(result.status, "needs_reasoning");
  assert.deepEqual(result.textCalls, []);
  assert.ok(result.steps.length <= 4);
});

test("sources preserve full caller text and only extract verbatim user goal spans", () => {
  const text = "第一行\n  第二行\n" + "正文".repeat(900);
  const sources = taskSources({
    ...input,
    values: [{ name: "说明", text }],
    goal: "标题“门店助理”；邮箱 a@example.com。",
  });
  assert.equal(sources.values.v1?.text, text);
  assert.ok(Object.values(sources.values).some((value) => value.text === "门店助理"));
  for (const [id, value] of Object.entries(sources.values)) {
    if (id !== "v1") assert.ok("标题“门店助理”；邮箱 a@example.com。".includes(value.text));
  }
});

test("Roll can correct an existing value on a subsequent call without rewriting a correct field", async () => {
  let value = "错误城市";
  const writes: string[] = [];
  const result = await runBrowserTask(
    { ...input, goal: "仅把城市改为上海；其他正确内容保持不变。" },
    {
      observe: async () => {
        const snapshot = page(value);
        snapshot.refs.push({
          ref: "@e3",
          role: "textbox",
          name: "已正确的说明",
          nth: 0,
          disabled: false,
          backendNodeId: 3,
        });
        snapshot.nodes.push({
          ref: "@e3",
          role: "textbox",
          name: "已正确的说明",
          value: "原样保留",
          depth: 0,
          ignored: false,
        });
        snapshot.controls!["@e3"] = { availability: "ready", editable: true, context: [] };
        return snapshot;
      },
      invoke: async (_method, args) => {
        assert.deepEqual(args[0], { ref: "@e1", snapshotId: `s-${value}-1` });
        value = String(args[1]);
        writes.push(value);
      },
      actionExecuted: () => true,
    },
    async (request) => (value === "上海" ? answer({ operation: "DONE" }) : type(request)),
    new AbortController().signal,
  );
  assert.deepEqual(writes, ["上海"]);
  assert.equal(result.status, "model_done");
  assert.equal(result.verified, false);
  assert.deepEqual(result.textCalls, []);
});

test("unoffered actions and values never reach native dispatch", async () => {
  for (const decide of [
    async () => answer({ operation: "CLICK:@e2" }),
    async (request: DecisionRequest) => type(request, "@e1", "fabricated"),
  ]) {
    const result = await runBrowserTask(
      input,
      {
        observe: async () => page(),
        invoke: async () => assert.fail("Unvalidated choice must not execute"),
        actionExecuted: () => false,
      },
      decide,
      new AbortController().signal,
    );
    assert.equal(result.status, "failed");
    assert.deepEqual(result.textCalls, []);
  }
});

test("same-request incomplete judgment prevents a premature DONE without invoking a helper", async () => {
  let calls = 0;
  let value = "";
  const result = await runBrowserTask(
    input,
    {
      observe: async () => page(value),
      invoke: async (_method, args) => {
        value = String(args[1]);
      },
      actionExecuted: () => true,
    },
    async (request) => {
      calls++;
      if (calls === 1) return answer({ operation: "DONE", completion: "INCOMPLETE" });
      return value ? answer({ operation: "DONE", completion: "COMPLETE" }) : type(request);
    },
    new AbortController().signal,
  );
  assert.equal(value, "上海");
  assert.equal(result.steps[0]?.operation, "CONTINUE_TASK");
  assert.equal(result.status, "model_done");
  assert.deepEqual(result.textCalls, []);
});

test("completion identifies an open panel and the next primary decision closes it without a helper", async () => {
  let calls = 0;
  let open = true;
  const methods: string[] = [];
  const result = await runBrowserTask(
    input,
    {
      observe: async () => ({ ...page("上海"), pageText: open ? "Open editor" : "Closed editor" }),
      invoke: async (method, args) => {
        methods.push(method);
        assert.deepEqual(args, ["Escape"]);
        open = false;
      },
      actionExecuted: () => true,
    },
    async (request) => {
      calls++;
      if (calls === 1) return answer({ operation: "DONE", completion: "OPEN_PANEL" });
      if (open) {
        assert.match(JSON.stringify(request.state), /Close the unwanted panel/);
        return answer({ operation: "ESCAPE" });
      }
      return answer({ operation: "DONE", completion: "COMPLETE" });
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "model_done");
  assert.deepEqual(methods, ["press"]);
  assert.deepEqual(result.textCalls, []);
});

test("native selects and search inputs expose distinct complete actions", () => {
  const snapshot = page();
  snapshot.refs[0]!.role = "combobox";
  snapshot.nodes[0]!.role = "combobox";
  let request = buildTaskDecisionRequest(input, snapshot, []);
  assert.ok(request.questions.operation?.criteria["TYPE_TEXT:@e1"]);
  assert.equal(
    Object.keys(request.questions.operation!.criteria).some((key) => key.startsWith("SELECT:")),
    false,
  );
  snapshot.controls!["@e1"] = {
    availability: "ready",
    editable: false,
    context: [],
    nativeSelect: true,
    options: [{ label: "上海", value: "sh", disabled: false, selected: false }],
  };
  request = buildTaskDecisionRequest(input, snapshot, []);
  assert.equal(request.questions.operation?.criteria["TYPE_TEXT:@e1"], undefined);
  assert.ok(request.questions.operation?.criteria["SELECT:@e1:0"]);
});
