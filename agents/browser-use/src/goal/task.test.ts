import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { buildTaskDecisionRequest, taskState, taskControlIdentity } from "./task-policy.ts";
import type { GoalSnapshot } from "./observation.ts";
import { validateChoices, createJevProvider, createSamplingProvider } from "./decisions.ts";

const input = BrowserOperateInputSchema.parse({
  pageId: "p",
  goal: "工作地址在上海。填写城市后停止，不发布。",
  values: [],
  allowedOrigins: ["https://example.com"],
  blockedNames: ["发布"],
  maxSteps: 4,
});
test("Jev is the default engine and the removed OpenRouter engine is rejected", () => {
  assert.equal(input.engine, "jev");
  assert.equal(
    BrowserOperateInputSchema.safeParse({
      pageId: "p",
      goal: "Read the page",
      allowedOrigins: ["https://example.com"],
      engine: "openrouter",
    }).success,
    false,
  );
});
const page = (value = "", backendNodeId = 1): GoalSnapshot => ({
  snapshotId: "s" + backendNodeId + value,
  documentId: "doc",
  nodeCount: 2,
  maxNodes: 240,
  truncated: false,
  interactiveOnly: true,
  nodes: [
    { ref: "@e1", role: "textbox", name: "城市", value, ignored: false, depth: 0 },
    { ref: "@e2", role: "button", name: "发布", ignored: false, depth: 0 },
  ],
  refs: [
    { ref: "@e1", role: "textbox", name: "城市", nth: 0, disabled: false, backendNodeId },
    { ref: "@e2", role: "button", name: "发布", nth: 0, disabled: false, backendNodeId: 2 },
  ],
});
test("matching text on another identically named field is not resolved evidence", () => {
  const snapshot = page("上海");
  snapshot.refs.push({ ...snapshot.refs[0]!, ref: "@e3", backendNodeId: 3 });
  snapshot.nodes.push({ ...snapshot.nodes[0]!, ref: "@e3" });
  const state = taskState(input, snapshot, [], "", [
    {
      text: "上海",
      source: "derived",
      sourceIds: [],
      evidence: "工作地址在上海",
      field: "城市",
      targetKey: JSON.stringify([snapshot.documentId, taskControlIdentity(snapshot.refs[0]!)]),
    },
  ]);
  assert.deepEqual(state.elements.find((element) => element.ref === "@e1")?.writtenValueMatches, [
    "r1",
  ]);
  assert.deepEqual(
    state.elements.find((element) => element.ref === "@e3")?.writtenValueMatches,
    [],
  );
});

test("only the selected operation's speculative target is required and authorized", () => {
  const request = buildTaskDecisionRequest(input, page(), []);
  assert.doesNotThrow(() =>
    validateChoices(request, {
      operation: "TYPE_TEXT:@e1",
      [request.routing!.targets["TYPE_TEXT:@e1"]!]: "NONE",
    }),
  );
  assert.doesNotThrow(() =>
    validateChoices(request, { operation: "DONE", completion: "COMPLETE", click_target: "@e2" }),
  );
  assert.throws(() => validateChoices(request, { operation: "CLICK:@e2" }));
  assert.throws(() =>
    validateChoices(request, { operation: "TYPE_TEXT:@e1", click_target: "@e1" }),
  );
});

test("both adapters accept routed answers and host routing metadata never reaches Jev HTTP", async () => {
  const request = buildTaskDecisionRequest(input, page(), []);
  const expected = {
    operation: "TYPE_TEXT:@e1",
    [request.routing!.targets["TYPE_TEXT:@e1"]!]: "NONE",
  };
  let samplingLimit: number | undefined;
  const sampling = createSamplingProvider({
    llm: {
      generateText: async (_prompt, options) => {
        samplingLimit = options?.maxOutputTokens;
        return JSON.stringify(expected);
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  assert.deepEqual((await sampling(request, new AbortController().signal)).choices, expected);
  assert.equal(samplingLimit, 8192);
  const jev = createJevProvider({
    apiKey: "test",
    model: "test",
    fetch: async (_url, init) => {
      assert.equal(typeof init?.body, "string");
      const body: unknown = JSON.parse(String(init!.body));
      assert.ok(body && typeof body === "object" && !("routing" in body));
      const answers = Object.fromEntries(
        Object.entries(expected).map(([key, choice]) => [
          key,
          {
            type: "choice",
            choice,
            probabilities: Object.fromEntries(
              Object.keys(request.questions[key]!.criteria).map((id) => [
                id,
                id === choice ? 1 : 0,
              ]),
            ),
          },
        ]),
      );
      return new Response(JSON.stringify({ model: "test", answers }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.deepEqual((await jev(request, new AbortController().signal)).choices, expected);
});

test("repeated DOM context is sent once without exposing backend identities to the model", () => {
  const snapshot = page("上海");
  snapshot.refs.push({ ...snapshot.refs[0]!, ref: "@e3", backendNodeId: 300 });
  snapshot.controls = {
    "@e1": { availability: "ready", editable: true, context: ["Shared field context"] },
    "@e3": { availability: "ready", editable: true, context: ["Shared field context"] },
  };
  const state = taskState(input, snapshot, []);
  assert.deepEqual(Object.values(state.contexts), ["Shared field context"]);
  assert.deepEqual(state.elements.find((element) => element.ref === "@e1")?.context, ["c1"]);
  assert.deepEqual(state.elements.find((element) => element.ref === "@e3")?.context, ["c1"]);
  assert.ok(!("identity" in state.elements[0]!));
});

test("token-limit errors expose only the recognized code and are not blindly retried", async () => {
  let calls = 0;
  const provider = createJevProvider({
    apiKey: "test",
    model: "test",
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: 'private-echo {"error_type":"max_tokens_exceeded"}' } }),
        { status: 400 },
      );
    },
  });
  await assert.rejects(
    provider(buildTaskDecisionRequest(input, page(), []), new AbortController().signal),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /max_tokens_exceeded/);
      assert.ok(!error.message.includes("private-echo"));
      return true;
    },
  );
  assert.equal(calls, 1);
});
