import assert from "node:assert/strict";
import { test } from "node:test";
import { createExecutionContext } from "./execution-context.ts";
import { taskElements } from "./task-policy.ts";
import { validateChoices } from "./decisions.ts";
import type { DecisionRequest } from "./decisions.ts";
import type { GoalSnapshot } from "./observation.ts";
import {
  createInteractionFeedback,
  observeInteractionFeedback,
  recordInteractionAttempt,
  withInteractionFeedback,
  acceptInteractionFeedback,
} from "./interaction-feedback.ts";

function page(description = "", toast = "", refs = 0): GoalSnapshot {
  return {
    snapshotId: `s${refs}-${description}-${toast}`,
    documentId: "d",
    truncated: false,
    nodeCount: 2,
    maxNodes: 240,
    interactiveOnly: true,
    pageText: `Category\nDescription\n${toast}`,
    pageState: { panels: [], selectedTabs: [], busy: false },
    nodes: ["Category", "Description"].map((name, i) => ({
      ref: `@e${refs + i}`,
      role: "textbox",
      name,
      value: i ? description : "",
      depth: 0,
      ignored: false,
    })),
    refs: ["Category", "Description"].map((name, i) => ({
      ref: `@e${refs + i}`,
      role: "textbox",
      name,
      nth: 0,
      disabled: false,
      backendNodeId: i + 1,
      frameId: "frame",
    })),
    controls: Object.fromEntries(
      [0, 1].map((i) => [
        `@e${refs + i}`,
        { availability: "ready" as const, editable: i === 1, context: [] },
      ]),
    ),
  };
}
function context() {
  const c = createExecutionContext({
    formTask: {
      mode: "create",
      stopAt: "applied",
      fields: [
        { name: "Description", intent: "set", valueName: "description", comparison: "literal" },
      ],
    },
    values: [{ name: "description", text: "Prepared description" }],
  });
  c.form!.fields[0]!.current = "";
  c.form!.fields[0]!.status = "unsatisfied";
  return c;
}
const request = (ref = "@e0"): DecisionRequest => ({
  state: {},
  questions: {
    operation: {
      type: "choice",
      instructions: "Choose next action",
      criteria: { [`CLICK:${ref}`]: "Open category", WAIT: "Wait" },
    },
  },
  routing: { head: "operation", targets: {} },
});
function click(memory: ReturnType<typeof createInteractionFeedback>, p: GoalSnapshot) {
  recordInteractionAttempt(memory, p, {
    operation: "CLICK",
    identity: taskElements(p)[0]!.identity,
    target: "Category",
    executed: true,
  });
}

test("page prerequisite evidence is retained after toast and refs change; values release the block", () => {
  const m = createInteractionFeedback();
  const c = context();
  let s = page();
  observeInteractionFeedback(m, s, c);
  click(m, s);
  s = page("", "Complete Description before choosing Category");
  observeInteractionFeedback(m, s, c);
  let q = withInteractionFeedback(request(), m, s, c);
  assert.ok(q.questions.execution_prerequisite);
  validateChoices(q, { operation: "CLICK:@e0", execution_prerequisite: "f1" });
  assert.equal(acceptInteractionFeedback(m, c, { execution_prerequisite: "f1" }), true);
  s = page("", "", 10);
  observeInteractionFeedback(m, s, c);
  q = withInteractionFeedback(request("@e10"), m, s, c);
  assert.equal(q.questions.operation!.criteria["CLICK:@e10"], undefined);
  assert.match(JSON.stringify(q.state), /Complete Description/);
  assert.equal(q.questions.execution_prerequisite, undefined);
  c.form!.fields[0]!.current = "Prepared description";
  s = page("Prepared description", "", 20);
  observeInteractionFeedback(m, s, c);
  assert.ok(
    withInteractionFeedback(request("@e20"), m, s, c).questions.operation!.criteria["CLICK:@e20"],
  );
});

test("two no-effect clicks are suppressed across toast and layout changes even without a judgment", () => {
  const m = createInteractionFeedback();
  const c = context();
  let s = page();
  observeInteractionFeedback(m, s, c);
  click(m, s);
  s = page("", "notice", 10);
  observeInteractionFeedback(m, s, c);
  click(m, s);
  s = page("", "", 20);
  observeInteractionFeedback(m, s, c);
  assert.equal(
    withInteractionFeedback(request("@e20"), m, s, c).questions.operation!.criteria["CLICK:@e20"],
    undefined,
  );
  s = page("new content", "", 30);
  observeInteractionFeedback(m, s, c);
  assert.ok(
    withInteractionFeedback(request("@e30"), m, s, c).questions.operation!.criteria["CLICK:@e30"],
  );
});

test("changed target or opened panel is progress, but executed alone is not", () => {
  const m = createInteractionFeedback();
  const c = context();
  const before = page();
  observeInteractionFeedback(m, before, c);
  click(m, before);
  const after = page();
  after.pageState!.panels = ["Category picker"];
  observeInteractionFeedback(m, after, c);
  assert.equal(m.attempts.size, 0);
});

test("unknown execution is never queued for automatic replay, and navigation clears memory", () => {
  const m = createInteractionFeedback();
  const c = context();
  const s = page();
  observeInteractionFeedback(m, s, c);
  recordInteractionAttempt(m, s, {
    operation: "CLICK",
    identity: taskElements(s)[0]!.identity,
    target: "Category",
    executed: true,
    error: "timeout",
  });
  assert.equal(m.pending, undefined);
  click(m, s);
  observeInteractionFeedback(m, page("", "rejected"), c);
  assert.equal(m.attempts.size, 1);
  const next = page();
  next.documentId = "other";
  observeInteractionFeedback(m, next, c);
  assert.equal(m.attempts.size, 0);
});

test("feedback selects only an offered unmet set field and cannot grant new scope", () => {
  const m = createInteractionFeedback();
  const c = context();
  const s = page();
  observeInteractionFeedback(m, s, c);
  click(m, s);
  const next = page("", "First change the account owner");
  observeInteractionFeedback(m, next, c);
  const q = withInteractionFeedback(request(), m, next, c);
  assert.deepEqual(Object.keys(q.questions.execution_prerequisite!.criteria), ["NONE", "f1"]);
  assert.throws(() =>
    validateChoices(q, { operation: "WAIT", execution_prerequisite: "account-owner" }),
  );
  assert.equal(acceptInteractionFeedback(m, c, { execution_prerequisite: "NONE" }), false);
  assert.equal([...m.attempts.values()][0]!.prerequisite, undefined);
});

test(
  "official Jev identifies the supplied prerequisite from observed Chinese feedback",
  {
    skip: process.env["RUN_FEEDBACK_JEV"] !== "1",
    timeout: 30000,
  },
  async () => {
    const { createJevProvider } = await import("./decisions.ts");
    const m = createInteractionFeedback();
    const c = context();
    const s = page();
    c.form!.fields[0]!.name = "职位描述";
    observeInteractionFeedback(m, s, c);
    click(m, s);
    const after = page("", "请先填写职位名称和职位描述");
    observeInteractionFeedback(m, after, c);
    const q = withInteractionFeedback(request(), m, after, c);
    q.state = {
      ...(q.state as Record<string, unknown>),
      originalGoal: "填写职位名称、职位描述，再选职类。职位名称已经填写。",
    };
    const answer = await createJevProvider({
      apiKey: process.env["TYPESAFE_API_KEY"]!,
      model: "jev-1.13.0",
    })(q, AbortSignal.timeout(25000));
    assert.equal(answer.choices.execution_prerequisite, "f1");
  },
);

test("form scroll anchors follow the unfinished control's container instead of the sidebar", async () => {
  const { buildTaskDecisionRequest } = await import("./task-policy.ts");
  const { BrowserOperateInputSchema } = await import("./contracts.ts");
  const c = context();
  const s = page();
  c.form!.fields[0]!.binding = {
    identity: taskElements(s)[1]!.identity,
    name: "Description",
    role: "textbox",
  };
  s.controls!["@e1"]!.scrollContainerPaths = ["/frame!/main"];
  s.controls!["@e0"]!.scrollContainerPaths = ["/aside"];
  const input = BrowserOperateInputSchema.parse({
    pageId: "p",
    goal: "Fill Description",
    allowedOrigins: ["https://example.com"],
    values: [],
  });
  const q = buildTaskDecisionRequest(input, s, [], "", new Set(), [], undefined, undefined, c);
  assert.ok(q.questions.operation!.criteria["SCROLL_DOWN:@e1"]);
  assert.equal(q.questions.operation!.criteria["SCROLL_DOWN:@e0"], undefined);
});

test("a footer-covered reveal target remains bindable but is not clicked before a wheel reveal", async () => {
  const { buildTaskDecisionRequest } = await import("./task-policy.ts");
  const { BrowserOperateInputSchema } = await import("./contracts.ts");
  const s = page();
  s.controls!["@e0"]!.availability = "offscreen";
  s.controls!["@e0"]!.revealViaScroll = true;
  s.controls!["@e0"]!.scrollContainerPaths = ["/main"];
  s.controls!["@e1"]!.scrollContainerPaths = ["/main"];
  const input = BrowserOperateInputSchema.parse({
    pageId: "p",
    goal: "Select Category",
    allowedOrigins: ["https://example.com"],
  });
  const q = buildTaskDecisionRequest(input, s, []);
  assert.equal(q.questions.operation!.criteria["CLICK:@e0"], undefined);
  assert.ok(q.questions.operation!.criteria["SCROLL_DOWN:@e1"]);
});

test("an inner scroller is not offered to reveal a field in an outer container", async () => {
  const { buildTaskDecisionRequest } = await import("./task-policy.ts");
  const { BrowserOperateInputSchema } = await import("./contracts.ts");
  const c = context();
  const s = page();
  c.form!.fields[0]!.binding = {
    identity: taskElements(s)[0]!.identity,
    name: "Category",
    role: "clickable",
  };
  s.controls!["@e0"]!.scrollContainerPaths = ["/main"];
  s.controls!["@e1"]!.scrollContainerPaths = ["/main/textarea", "/main"];
  const input = BrowserOperateInputSchema.parse({
    pageId: "p",
    goal: "Set Category",
    allowedOrigins: ["https://example.com"],
  });
  const q = buildTaskDecisionRequest(input, s, [], "", new Set(), [], undefined, undefined, c);
  assert.ok(q.questions.operation!.criteria["SCROLL_DOWN:@e0"]);
  assert.equal(q.questions.operation!.criteria["SCROLL_DOWN:@e1"], undefined);
});

test("ordinary read navigation remains actionable when progress is outside form values", () => {
  const c = createExecutionContext({ values: [] });
  const m = createInteractionFeedback();
  let s = page();
  observeInteractionFeedback(m, s, c);
  for (const text of ["Result 1\nResult 2", "Result 1\nResult 2\nResult 3"]) {
    click(m, s);
    s = { ...page(), pageText: text };
    observeInteractionFeedback(m, s, c);
  }
  assert.ok(withInteractionFeedback(request(), m, s, c).questions.operation!.criteria["CLICK:@e0"]);
});

test("a successful expansion clears prior ineffective attempt history", () => {
  const m = createInteractionFeedback();
  const c = context();
  let s = page();
  observeInteractionFeedback(m, s, c);
  click(m, s);
  observeInteractionFeedback(m, s, c);
  assert.equal(m.attempts.size, 1);
  click(m, s);
  s = page();
  s.controls!["@e0"]!.expanded = true;
  observeInteractionFeedback(m, s, c);
  assert.equal(m.attempts.size, 0);
});
