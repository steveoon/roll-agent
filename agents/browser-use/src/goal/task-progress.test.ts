import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { BrowserOperateInputSchema, BrowserOperateOutputSchema } from "./contracts.ts";
import { ReadTaskSchema, createTaskProgress, reconcileTaskProgress } from "./task-progress.ts";
import { evidenceCandidates, commitEvidence } from "./task-evidence.ts";
import { buildTaskDecisionRequest } from "./task-policy.ts";
import { validateChoices } from "./decisions.ts";
import { runBrowserTask } from "./task-loop.ts";
import type { GoalSnapshot } from "./observation.ts";
import type { DecisionRequest, DecisionResult } from "./decisions.ts";

const contract = ReadTaskSchema.parse({
  target: "Record A",
  captureView: "Record A detail panel",
  outputs: ["Pay", "Location"],
  terminal: { view: "Records list", selectedTab: "Pending" },
});
function snapshot(open = false, tab = "Pending", pay = "5–6K"): GoalSnapshot {
  return {
    snapshotId: `s-${open}-${tab}-${pay}`,
    documentId: "doc",
    nodeCount: 2,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
    nodes: [],
    refs: [
      {
        ref: "@open",
        role: "button",
        name: "Preview Record A",
        nth: 0,
        disabled: false,
        backendNodeId: 1,
      },
      { ref: "@close", role: "button", name: "Close", nth: 0, disabled: false, backendNodeId: 2 },
    ],
    controls: {
      "@open": { availability: open ? "covered" : "ready", editable: false, context: [] },
      "@close": {
        availability: open ? "ready" : "hidden",
        editable: false,
        context: [],
        modal: true,
      },
    },
    pageState: { panels: open ? ["Record A"] : [], selectedTabs: [tab], busy: false },
    readDocuments: [
      {
        frameId: "root",
        url: "https://example.com/list",
        panelsComplete: true,
        observedAt: "2026-09-22T00:00:00.000Z",
        regions: open
          ? [
              {
                id: "panel",
                name: "Record A",
                kind: "panel",
                text: `Record A\nPay\n${pay}\nLocation\nEast Road`,
                truncated: false,
              },
            ]
          : [],
      },
    ],
    pageText: open ? `Record A ${pay} East Road` : "Records list",
  };
}
const input = BrowserOperateInputSchema.parse({
  pageId: "p",
  goal: "Read Record A pay and location from its preview, then close and return to Pending",
  readTask: contract,
  allowedOrigins: ["https://example.com"],
  maxSteps: 30,
});
function choices(request: DecisionRequest, operation: string, region = "NONE"): DecisionResult {
  const answers: Record<string, string> = { operation };
  if (operation === "DONE") answers.completion = "COMPLETE";
  if (request.questions.capture_region) {
    answers.capture_region = region;
    if (region !== "NONE") {
      for (const key of request.evidenceRouting?.capture_region?.[region] ?? []) {
        const field = key.endsWith("_0") ? "5–6K" : "East Road";
        answers[key] =
          Object.entries(request.questions[key]!.criteria).find(
            ([, text]) => text === field,
          )?.[0] ?? "NONE";
      }
    }
  }
  if (request.questions.progress_terminal) {
    answers.progress_terminal = operation === "DONE" ? "READY" : "NOT_READY";
  }
  return {
    choices: answers,
    elapsedMs: 0,
    provider: "test",
    requestedModel: "test",
    resolvedModel: "test",
  };
}

test("same list before and after visit: retain exact read quotes, discard old-phase action and finish without reopening", async () => {
  let open = false;
  let executed = false;
  let decisions = 0;
  const actions: string[] = [];
  const result = await runBrowserTask(
    input,
    {
      observe: async () => snapshot(open),
      checkTarget: async () => true,
      actionExecuted: () => executed,
      invoke: async (method, params) => {
        executed = true;
        actions.push(
          String(
            params[0] && typeof params[0] === "object" && "ref" in params[0]
              ? params[0].ref
              : method,
          ),
        );
        open = !open;
      },
    },
    async (request) => {
      decisions++;
      if (decisions === 1) return choices(request, "CLICK:@open");
      if (decisions === 2) return choices(request, "CLICK:@close", "r0_0");
      if (decisions === 3) {
        assert.equal(actions.length, 1, "old collect action was discarded");
        assert.ok(!request.questions.operation!.criteria["CLICK:@open"]);
        return choices(request, "CLICK:@close");
      }
      return choices(request, "DONE");
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "interaction_done");
  assert.equal(result.verified, false);
  assert.deepEqual(actions, ["@open", "@close"]);
  assert.deepEqual(
    result.progress?.evidence.map((e) => e.text),
    ["5–6K", "East Road"],
  );
  assert.equal(result.progress?.phase, "done");
  assert.ok(result.steps.some((s) => s.operation === "CAPTURE_EVIDENCE" && !s.executed));
  BrowserOperateOutputSchema.parse(result);
});

test("click success and model DONE cannot fabricate a visit or read evidence", async () => {
  const result = await runBrowserTask(
    { ...input, maxSteps: 3 },
    {
      observe: async () => snapshot(false),
      checkTarget: async () => true,
      invoke: async () => {},
      actionExecuted: () => false,
    },
    async (request) => choices(request, "DONE"),
    new AbortController().signal,
  );
  assert.notEqual(result.status, "interaction_done");
  assert.equal(result.progress?.evidence.length, 0);
});

test("missing, cross-region and truncated spans cannot produce a complete packet", () => {
  for (const mode of ["missing", "foreign", "truncated"]) {
    const progress = createTaskProgress(contract);
    const c = evidenceCandidates(snapshot(true).readDocuments!)[0]!;
    if (mode === "truncated") c.region.truncated = true;
    assert.equal(
      commitEvidence(
        progress,
        contract,
        c,
        [
          c.spans[2]!.id,
          mode === "missing" ? "NONE" : mode === "foreign" ? "r9_9s4" : c.spans[4]!.id,
        ],
        "s",
        "d",
      ),
      false,
    );
    assert.equal(progress.phase, "collect");
    assert.deepEqual(progress.evidence, []);
  }
});

test("all consumed evidence answers are validated even if operation is WAIT", () => {
  const request = buildTaskDecisionRequest(
    input,
    snapshot(true),
    [],
    "",
    new Set(),
    [],
    undefined,
    createTaskProgress(contract),
  );
  const answer = choices(request, "WAIT", "r0_0").choices;
  validateChoices(request, answer);
  delete answer.capture_r0_0_1;
  assert.throws(() => validateChoices(request, answer), /capture_r0_0_1/);
  validateChoices(request, { operation: "WAIT", capture_region: "NONE" });
});

test("changed source invalidates read progress, closed source preserves it; tasks have separate identities", () => {
  const p = createTaskProgress(contract);
  const other = createTaskProgress(contract);
  assert.notEqual(p.taskRunId, other.taskRunId);
  const c = evidenceCandidates(snapshot(true).readDocuments!)[0]!;
  assert.equal(commitEvidence(p, contract, c, [c.spans[2]!.id, c.spans[4]!.id], "s", "doc"), true);
  assert.equal(reconcileTaskProgress(p, contract, "doc", snapshot(false).readDocuments!), false);
  assert.equal(p.phase, "return");
  assert.equal(
    reconcileTaskProgress(p, contract, "doc", snapshot(true, "Pending", "8–9K").readDocuments!),
    true,
  );
  assert.equal(p.phase, "collect");
});

test("final handoff re-observes terminal and refuses completion after a new overlay appears", async () => {
  let open = true;
  let observations = 0;
  const result = await runBrowserTask(
    input,
    {
      observe: async () => {
        observations++;
        return snapshot(observations >= 4 ? true : open);
      },
      checkTarget: async () => true,
      invoke: async () => {
        open = false;
      },
      actionExecuted: () => true,
    },
    async (request) => {
      if (request.questions.capture_region) return choices(request, "WAIT", "r0_0");
      return choices(request, open ? "CLICK:@close" : "DONE");
    },
    new AbortController().signal,
  );
  assert.equal(result.status, "needs_reasoning");
  assert.equal(result.progress?.phase, "return");
  assert.equal(result.progress?.evidence.length, 2);
});

test("plain forms still use live field values even when earlier written-value evidence exists", () => {
  const form = BrowserOperateInputSchema.parse({
    pageId: "p",
    goal: "Fill City with Shanghai",
    values: [{ name: "City", text: "Shanghai" }],
    allowedOrigins: ["https://example.com"],
  });
  const page = snapshot(false);
  page.refs = [
    { ref: "@city", role: "textbox", name: "City", nth: 0, disabled: false, backendNodeId: 3 },
  ];
  page.nodes = [
    { ref: "@city", role: "textbox", name: "City", value: "", ignored: false, depth: 0 },
  ];
  page.controls = {
    "@city": { availability: "ready", editable: true, context: [], observedValue: "" },
  };
  const request = buildTaskDecisionRequest(form, page, [], "", new Set(), [
    {
      field: "City",
      text: "Shanghai",
      source: "supplied",
      sourceIds: ["v1"],
      evidence: "Previously written",
      targetKey: JSON.stringify(["doc", JSON.stringify([undefined, 3])]),
    },
  ]);
  assert.ok(request.questions.operation!.criteria["TYPE_TEXT:@city"]);
  const state = z
    .object({
      elements: z.array(
        z.object({
          value: z.string().optional(),
          writtenValueMatches: z.array(z.string()).optional(),
        }),
      ),
      taskProgress: z.unknown().optional(),
    })
    .parse(request.state);
  assert.equal(state.elements[0]?.value, "");
  assert.equal(state.elements[0]?.writtenValueMatches?.length ?? 0, 0);
  assert.equal(state.taskProgress, undefined);
});

test("RETURN never offers DONE while the required filter is still wrong", () => {
  const progress = createTaskProgress(contract);
  const c = evidenceCandidates(snapshot(true).readDocuments!)[0]!;
  commitEvidence(progress, contract, c, [c.spans[2]!.id, c.spans[4]!.id], "s", "doc");
  const current = snapshot(false, "All");
  const request = buildTaskDecisionRequest(
    input,
    current,
    [],
    "",
    new Set(),
    [],
    undefined,
    progress,
  );
  assert.equal(request.questions.operation!.criteria.DONE, undefined);
});
