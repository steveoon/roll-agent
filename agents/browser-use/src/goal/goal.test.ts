import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserScriptLocatorSchema } from "@roll-agent/browser";
import type { BrowserAxSnapshot } from "@roll-agent/browser";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { createJevProvider, createSamplingProvider } from "./decisions.ts";
import type { DecisionProvider } from "./decisions.ts";
import { buildDecisionRequest, runBrowserGoal } from "./loop.ts";
import { permittedFrames } from "./host.ts";

const input = BrowserOperateInputSchema.parse({
  pageId: "page",
  goal: "Fill name, do not publish",
  allowedOrigins: ["https://example.com"],
  values: [{ name: "Name", text: "A\nB" }],
  blockedNames: ["Publish"],
  maxSteps: 4,
});
const snapshot: BrowserAxSnapshot = {
  snapshotId: "s1",
  nodeCount: 2,
  maxNodes: 240,
  truncated: false,
  interactiveOnly: true,
  nodes: [{ ref: "@e1", role: "textbox", name: "Name", value: "", ignored: false, depth: 0 }],
  refs: [
    { ref: "@e1", role: "textbox", name: "Name", nth: 0, disabled: false },
    { ref: "@e2", role: "button", name: "Publish", nth: 0, disabled: false },
  ],
};
const provider: DecisionProvider = async () => ({
  choices: { status: "CONTINUE", next: "TYPE_TEXT:@e1:v1" },
  requestedModel: "test",
  resolvedModel: "test",
  provider: "test",
  elapsedMs: 1,
});

test("excluded publication targets are not offered as choices", () => {
  const request = buildDecisionRequest(input, snapshot, []);
  assert.equal(request.questions.next?.criteria["CLICK:@e2"], undefined);
  assert.equal(request.questions.next?.criteria["TYPE_TEXT:@e1:v1"]?.includes("Name"), true);
});

test("readonly textboxes offer clicks but never typing choices", () => {
  const readonlySnapshot = {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({ ...node, properties: { readonly: true } })),
  };
  const criteria = buildDecisionRequest(input, readonlySnapshot, []).questions.next!.criteria;
  assert.equal(criteria["TYPE_TEXT:@e1:v1"], undefined);
  assert.notEqual(criteria["CLICK:@e1"], undefined);
});

test("covered background controls are excluded while popup context remains available", () => {
  const criteria = buildDecisionRequest(
    input,
    {
      ...snapshot,
      controls: {
        "@e1": { availability: "covered", editable: true, context: ["Underlying form"] },
        "@e2": { availability: "ready", editable: false, context: [] },
      },
    },
    [],
  ).questions.next!.criteria;
  assert.equal(criteria["CLICK:@e1"], undefined);
  assert.equal(criteria["TYPE_TEXT:@e1:v1"], undefined);
  const ready = buildDecisionRequest(
    input,
    {
      ...snapshot,
      controls: {
        "@e1": {
          availability: "ready",
          editable: true,
          context: ["Minimum monthly salary"],
          layer: "Salary details",
        },
      },
    },
    [],
  ).questions.next!.criteria;
  assert.ok(ready["TYPE_TEXT:@e1:v1"]);
});

test("an unoffered complete action never reaches the driver", async () => {
  let calls = 0;
  const result = await runBrowserGoal(
    input,
    {
      observe: async () => snapshot,
      invoke: async () => {
        calls++;
      },
      actionExecuted: () => false,
    },
    async () => ({
      choices: { next: "CLICK:@e2" },
      requestedModel: "test",
      resolvedModel: "test",
      provider: "test",
      elapsedMs: 0,
    }),
    new AbortController().signal,
  );
  assert.equal(calls, 0);
  assert.equal(result.status, "failed");
});

test("exact multiline values pass through native locator schema, then model DONE stays unverified", async () => {
  let calls = 0;
  const result = await runBrowserGoal(
    input,
    {
      observe: async () => snapshot,
      invoke: async (method, params) => {
        calls++;
        assert.equal(method, "fill");
        BrowserScriptLocatorSchema.parse(params[0]);
        assert.equal(params[1], "A\nB");
      },
      actionExecuted: () => true,
    },
    async (request, signal) => {
      const response = await provider(request, signal);
      if (calls) response.choices.status = "DONE";
      return response;
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "model_done");
  assert.equal(result.verified, false);
});

test("field strategy advances only the current requirement and performs a final whole-goal review", async () => {
  const focused: unknown[] = [];
  const result = await runBrowserGoal(
    { ...input, strategy: "fields" },
    {
      observe: async () => snapshot,
      invoke: async () => {
        assert.fail("No action expected when values are already satisfied");
      },
      actionExecuted: () => false,
    },
    async (request) => {
      focused.push((request.state as { currentRequirement?: unknown }).currentRequirement);
      return {
        choices: { status: "DONE", next: "WAIT" },
        requestedModel: "test",
        resolvedModel: "test",
        provider: "test",
        elapsedMs: 0,
      };
    },
    new AbortController().signal,
  );
  assert.deepEqual(focused, [input.values[0], undefined]);
  assert.deepEqual(
    result.steps.map((step) => step.operation),
    ["REQUIREMENT_DONE", "DONE"],
  );
  assert.equal(result.verified, false);
});

test("an open address picker cannot advance into an unrelated requirement", async () => {
  const task = {
    ...input,
    strategy: "fields" as const,
    values: [
      { name: "Workplace", text: "Existing address" },
      { name: "Experience", text: "Unlimited" },
    ],
    maxSteps: 4,
  };
  const picker = {
    ...snapshot,
    refs: [
      { ref: "@e1", role: "textbox", name: "City search", nth: 0, disabled: false },
      { ref: "@e2", role: "button", name: "Use selected address", nth: 0, disabled: false },
    ],
    controls: {
      "@e1": {
        availability: "ready" as const,
        editable: true,
        context: ["Address search"],
        layer: "Addresses",
        layerKey: "address-dialog",
        modal: true,
      },
      "@e2": {
        availability: "ready" as const,
        editable: false,
        context: [],
        layer: "Addresses",
        layerKey: "address-dialog",
        modal: true,
      },
    },
  };
  let closed = false;
  const requirements: unknown[] = [];
  const result = await runBrowserGoal(
    task,
    {
      observe: async () => (closed ? snapshot : picker),
      invoke: async (method, params) => {
        assert.equal(method, "click");
        assert.deepEqual(params[0], { ref: "@e2", snapshotId: "s1" });
        closed = true;
      },
      actionExecuted: () => true,
    },
    async (request) => {
      requirements.push(
        (request.state as { currentRequirement?: { name: string } }).currentRequirement?.name,
      );
      if (!closed) assert.equal(request.questions.next!.criteria["TYPE_TEXT:@e1:v2"], undefined);
      return {
        choices: { status: "DONE", next: closed ? "WAIT" : "CLICK:@e2" },
        requestedModel: "test",
        resolvedModel: "test",
        provider: "test",
        elapsedMs: 0,
      };
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "model_done");
  assert.deepEqual(requirements, ["Workplace", "Workplace", "Experience", undefined]);
});

test("unchanged clicks are suppressed across regenerated ref ids but restored after page changes", async () => {
  let observed = 0;
  let dispatched = 0;
  const sawSuppression: boolean[] = [];
  const result = await runBrowserGoal(
    { ...input, maxSteps: 4 },
    {
      observe: async () => {
        const ref = `@e${++observed}`;
        return {
          ...snapshot,
          snapshotId: `s${observed}`,
          nodes: [
            {
              ...snapshot.nodes[0]!,
              ref,
              backendNodeId: 42,
              value: observed === 4 ? "changed" : "",
            },
          ],
          refs: [{ ...snapshot.refs[0]!, ref, backendNodeId: 42 }],
        };
      },
      invoke: async () => {
        dispatched++;
      },
      actionExecuted: () => true,
    },
    async (request) => {
      const next = `CLICK:@e${observed}`;
      const available = Object.hasOwn(request.questions.next!.criteria, next);
      sawSuppression.push(!available);
      return {
        choices: { status: "CONTINUE", next: available ? next : "WAIT" },
        requestedModel: "test",
        resolvedModel: "test",
        provider: "test",
        elapsedMs: 0,
      };
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "step_limit");
  assert.equal(dispatched, 3);
  assert.deepEqual(sawSuppression, [false, false, true, false]);
});

test("oscillating page states stop even when rerendering changes backend ids", async () => {
  let observations = 0;
  let actions = 0;
  const result = await runBrowserGoal(
    { ...input, maxSteps: 20 },
    {
      observe: async () => {
        observations++;
        return {
          ...snapshot,
          nodes: [
            {
              ...snapshot.nodes[0]!,
              value: observations % 2 ? "alpha" : "beta",
              backendNodeId: observations,
            },
          ],
          refs: [{ ...snapshot.refs[0]!, backendNodeId: observations }],
        };
      },
      invoke: async () => {
        actions++;
      },
      actionExecuted: () => true,
    },
    async () => ({
      choices: { status: "CONTINUE", next: "CLICK:@e1" },
      requestedModel: "test",
      resolvedModel: "test",
      provider: "test",
      elapsedMs: 0,
    }),
    new AbortController().signal,
  );
  assert.equal(result.status, "blocked");
  assert.equal(actions, 8);
  assert.match(result.error!, /Repeated page state/);
});

test("closing a picker verifies its unique readonly display without reopening it", async () => {
  let closed = false;
  let modelCalls = 0;
  const base = {
    ...snapshot,
    nodes: [
      { ...snapshot.nodes[0]!, value: input.values[0]!.text, properties: { readonly: true } },
    ],
    refs: [{ ...snapshot.refs[0]! }, { ...snapshot.refs[1]!, name: "Apply" }],
  };
  const result = await runBrowserGoal(
    { ...input, strategy: "fields" },
    {
      observe: async () =>
        closed
          ? base
          : {
              ...base,
              controls: {
                "@e2": {
                  availability: "ready",
                  editable: false,
                  context: [],
                  modal: true,
                  layer: "Picker",
                  layerKey: "picker",
                },
              },
            },
      invoke: async () => {
        closed = true;
      },
      actionExecuted: () => true,
    },
    async () => {
      modelCalls++;
      return {
        choices: { status: "DONE", next: closed ? "WAIT" : "CLICK:@e2" },
        requestedModel: "test",
        resolvedModel: "test",
        provider: "test",
        elapsedMs: 0,
      };
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "model_done");
  assert.equal(modelCalls, 2);
  assert.deepEqual(
    result.steps.map((step) => step.operation),
    ["CLICK", "REQUIREMENT_VERIFIED", "DONE"],
  );
});

test("uncertain dispatched action failure stops without replay", async () => {
  let calls = 0;
  const result = await runBrowserGoal(
    input,
    {
      observe: async () => snapshot,
      invoke: async () => {
        calls++;
        throw new Error("lost connection after input");
      },
      actionExecuted: () => true,
    },
    provider,
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.executed, true);
});

test("cancellation after decision prevents dispatch", async () => {
  const abort = new AbortController();
  let calls = 0;
  const result = await runBrowserGoal(
    input,
    {
      observe: async () => snapshot,
      invoke: async () => {
        calls++;
      },
      actionExecuted: () => false,
    },
    async (request, signal) => {
      const response = await provider(request, signal);
      abort.abort();
      return response;
    },
    abort.signal,
  );
  assert.equal(calls, 0);
  assert.equal(result.status, "cancelled");
});

test("Jev sends native decisions with exact model and validates distribution", async () => {
  const request = {
    state: "safe fixture",
    questions: {
      next: {
        type: "choice" as const,
        instructions: "Choose",
        criteria: { A: "first", B: "second" },
      },
    },
  };
  const make = (probabilities: Record<string, number>) =>
    createJevProvider({
      apiKey: "test-key",
      model: "typesafe/jev-1.13",
      fetch: async (url, options) => {
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(JSON.parse(String(options?.body)).model, "jev-1.13.0");
        return Response.json({
          model: "typesafe/resolved",
          answers: { next: { type: "choice", choice: "A", probabilities } },
        });
      },
    });
  const result = await make({ A: 0.9, B: 0.1 })(request, new AbortController().signal);
  assert.equal(result.resolvedModel, "typesafe/resolved");
  await assert.rejects(
    make({ A: 0.9, C: 0.1 })(request, new AbortController().signal),
    /distribution/,
  );
  await assert.rejects(
    make({ A: 0.2, B: 0.1 })(request, new AbortController().signal),
    /distribution/,
  );
});

test("HTTP errors do not include provider body", async () => {
  const decide = createJevProvider({
    apiKey: "secret",
    model: "test",
    fetch: async () => new Response("secret echo", { status: 401 }),
  });
  await assert.rejects(decide({ state: {}, questions: {} }, new AbortController().signal), {
    message: "TypeSafe decisions returned HTTP 401",
  });
});

test("transient inference errors retry with a finite budget before any UI dispatch", async () => {
  let calls = 0;
  const waits: number[] = [];
  const decide = createJevProvider({
    apiKey: "key",
    model: "jev",
    pause: async (ms) => {
      waits.push(ms);
    },
    fetch: async () => {
      if (++calls < 3) return new Response("upstream unavailable", { status: 520 });
      return Response.json({
        model: "jev",
        answers: { next: { type: "choice", choice: "A", probabilities: { A: 1 } } },
      });
    },
  });
  const result = await decide(
    {
      state: {},
      questions: { next: { type: "choice", instructions: "Choose", criteria: { A: "A" } } },
    },
    new AbortController().signal,
  );
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.deepEqual(waits, [250, 500]);
  let failures = 0;
  const exhausted = createJevProvider({
    apiKey: "key",
    model: "jev",
    pause: async () => {},
    fetch: async () => {
      failures++;
      return new Response(null, { status: 503 });
    },
  });
  await assert.rejects(
    exhausted({ state: {}, questions: {} }, new AbortController().signal),
    /HTTP 503/,
  );
  assert.equal(failures, 3);
});

test("sampling cancellation settles even if the upstream model never returns", async () => {
  const controller = new AbortController();
  const decide = createSamplingProvider({
    llm: { generateText: async () => new Promise<string>(() => {}) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  const pending = decide({ state: {}, questions: {} }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("frame scope excludes descendants reached through forbidden ancestors", () => {
  const tree = {
    frame: { id: "root", url: "https://example.com" },
    childFrames: [
      { frame: { id: "allowed", url: "https://example.com/form" } },
      {
        frame: { id: "foreign", url: "https://other.com" },
        childFrames: [{ frame: { id: "nested", url: "https://example.com" } }],
      },
    ],
  };
  assert.deepEqual([...permittedFrames(tree, input.allowedOrigins)], ["root", "allowed"]);
});
