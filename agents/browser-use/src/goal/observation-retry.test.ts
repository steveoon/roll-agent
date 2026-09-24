import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserElementRefStore, BrowserScriptError } from "@roll-agent/browser";
import { createRetryingGoalObserver } from "./observation-retry.ts";
import type { GoalSnapshot } from "./observation.ts";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { runBrowserGoal } from "./loop.ts";
import { runBrowserTask } from "./task-loop.ts";
import type { GoalDriver } from "./loop.ts";
import type { DecisionProvider } from "./decisions.ts";

const transient = () => new Error("Could not find node with given id (-32000)");
function snapshot(ref = "@e2", id = "fresh"): GoalSnapshot {
  return {
    snapshotId: id,
    documentId: "doc",
    browserInstance: "instance",
    pageId: "page",
    nodeCount: 1,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
    refs: [
      {
        ref,
        backendNodeId: 2,
        frameId: "f",
        role: "button",
        name: "展开字段",
        disabled: false,
        nth: 0,
      },
    ],
    nodes: [
      {
        ref,
        backendNodeId: 2,
        frameId: "f",
        role: "button",
        name: "展开字段",
        depth: 0,
        ignored: false,
      },
    ],
    controls: { [ref]: { availability: "ready", editable: false, context: [] } },
  };
}

test("detached-node observation retries once with original dependency identities and discards partial refs", async () => {
  const store = new BrowserElementRefStore();
  const unrelated = { ...snapshot("@e99", "other"), pageId: "other-page" };
  store.saveSnapshot("other-page", unrelated);
  const mutableReceived: string[][] = [];
  const dependencies = ["field-1"];
  let reads = 0;
  let discarded = 0;
  const observe = createRetryingGoalObserver(
    async (ids) => {
      mutableReceived.push([...(ids ?? [])]);
      reads += 1;
      const result = snapshot(reads === 1 ? "@e1" : "@e2", reads === 1 ? "partial" : "fresh");
      store.saveSnapshot("page", result);
      if (reads === 1) {
        dependencies.push("caller-mutated");
        throw transient();
      }
      return result;
    },
    new AbortController().signal,
    () => {
      discarded += 1;
      store.clear("page");
    },
  );
  const started = performance.now();
  const result = await observe(dependencies);
  assert.ok(performance.now() - started >= 40, "settle time stays inside the awaited observation");
  assert.equal(reads, 2);
  assert.equal(discarded, 1);
  assert.deepEqual(mutableReceived, [["field-1"], ["field-1"]]);
  assert.equal(result.snapshotId, "fresh");
  assert.deepEqual(
    result.refs.map((ref) => ref.ref),
    ["@e2"],
  );
  assert.equal(
    store.getScopedRef({
      browserInstance: "instance",
      pageId: "page",
      documentId: "doc",
      snapshotId: "partial",
      ref: "@e1",
    }),
    undefined,
  );
  assert.ok(
    store.getScopedRef({
      browserInstance: "instance",
      pageId: "other-page",
      documentId: "doc",
      snapshotId: "other",
      ref: "@e99",
    }),
  );
});

test("a second detached-node failure propagates without a third observation", async () => {
  let reads = 0;
  let discarded = 0;
  const last = new Error("No node with given id found (-32000)");
  const observe = createRetryingGoalObserver(
    async () => {
      reads += 1;
      throw reads === 1 ? transient() : last;
    },
    new AbortController().signal,
    () => {
      discarded += 1;
    },
  );
  await assert.rejects(observe(), (error) => error === last);
  assert.equal(reads, 2);
  assert.equal(discarded, 2);
});

test("policy, cancellation, transport, navigation and unknown failures are never retryable", async () => {
  for (const error of [
    new BrowserScriptError("domain_denied", transient().message),
    new Error("Document changed while observing. Take a new snapshot."),
    new Error("Native CDP command timed out"),
    new Error("WebSocket closed"),
    new Error("Could not find node with given id (-32602)"),
    new Error("Could not find node with given id"),
    new Error("node detached"),
    new DOMException(transient().message, "AbortError"),
    transient().message,
  ]) {
    let reads = 0;
    const observe = createRetryingGoalObserver(async () => {
      reads += 1;
      throw error;
    }, new AbortController().signal);
    await assert.rejects(observe(), (actual) => actual === error);
    assert.equal(reads, 1);
  }
});

test("aborting during the bounded settle cancels the retry before any second read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const abort = new AbortController();
  const observe = createRetryingGoalObserver(async () => {
    reads += 1;
    throw transient();
  }, abort.signal);
  const pending = observe();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  abort.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  t.mock.timers.tick(1000);
  assert.equal(reads, 1);
});

test("a changed disallowed URL is checked again by the full observation and never accepted", async () => {
  let url = "https://allowed.test";
  let reads = 0;
  const denied = new BrowserScriptError("domain_denied", "Page navigated outside goal origins");
  const observe = createRetryingGoalObserver(async () => {
    reads += 1;
    if (url !== "https://allowed.test") throw denied;
    url = "https://foreign.test";
    throw transient();
  }, new AbortController().signal);
  await assert.rejects(observe(), (error) => error === denied);
  assert.equal(reads, 2);
});

async function runLoop(strategy: "fields" | "task", actionError = false, failAfterAction = false) {
  const input = BrowserOperateInputSchema.parse({
    pageId: "page",
    goal: "展开字段",
    allowedOrigins: ["https://example.com"],
    strategy,
    maxSteps: failAfterAction ? 2 : 1,
  });
  const signal = new AbortController().signal;
  let reads = 0;
  let decisions = 0;
  let actions = 0;
  let failedAfterAction = false;
  const observe = createRetryingGoalObserver(async () => {
    reads += 1;
    if (!failAfterAction && reads === 1) throw transient();
    if (failAfterAction && actions && !failedAfterAction) {
      failedAfterAction = true;
      throw transient();
    }
    return snapshot();
  }, signal);
  const driver: GoalDriver = {
    observe,
    invoke: async (method, args) => {
      actions += 1;
      assert.equal(method, "click");
      assert.deepEqual(args[0], { ref: "@e2", snapshotId: "fresh" });
      if (actionError) throw transient();
    },
    actionExecuted: () => actions > 0,
  };
  const decide: DecisionProvider = async (request) => {
    decisions += 1;
    return {
      choices:
        strategy === "fields"
          ? { status: actions ? "DONE" : "CONTINUE", next: "CLICK:@e2" }
          : Object.fromEntries(
              Object.entries(request.questions).map(([name, question]) => [
                name,
                name === "operation"
                  ? actions
                    ? "DONE"
                    : "CLICK:@e2"
                  : Object.keys(question.criteria)[0]!,
              ]),
            ),
      provider: "test",
      requestedModel: "test",
      resolvedModel: "test",
      elapsedMs: 0,
    };
  };
  const result =
    strategy === "fields"
      ? await runBrowserGoal(input, driver, decide, signal)
      : await runBrowserTask(input, driver, decide, signal);
  return { result, reads, decisions, actions };
}

for (const strategy of ["fields", "task"] as const) {
  test(`${strategy} loop makes one decision and one action after a fresh readonly retry`, async () => {
    const { result, actions, decisions } = await runLoop(strategy);
    assert.equal(actions, 1);
    assert.equal(decisions, 1);
    assert.equal(result.status, "step_limit");
    assert.equal(result.steps[0]?.executed, true);
    assert.ok((result.steps[0]?.observationMs ?? 0) >= 40);
  });
  test(`${strategy} loop never retries an action-dispatched detached-node error`, async () => {
    const { result, actions, decisions } = await runLoop(strategy, true);
    assert.equal(actions, 1);
    assert.equal(decisions, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.steps[0]?.executed, true);
    assert.equal(result.steps[0]?.error, transient().message);
  });
  test(`${strategy} loop recovers the next observation after a completed action without replay`, async () => {
    const { result, actions, decisions } = await runLoop(strategy, false, true);
    assert.equal(actions, 1);
    assert.equal(decisions, 2);
    assert.equal(result.status, "model_done", JSON.stringify(result));
    assert.equal(result.steps[0]?.executed, true);
  });
}
