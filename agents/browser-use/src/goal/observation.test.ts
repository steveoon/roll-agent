import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { INSPECT_GOAL_CONTROL, inspectGoalControls, GoalControlSchema } from "./observation.ts";

test("origin guard runs before reading foreign DOM or styles", () => {
  const inspect: (this: unknown, origins: string[]) => unknown = runInNewContext(
    `(${INSPECT_GOAL_CONTROL})`,
  );
  const foreign = {
    ownerDocument: { defaultView: { location: { origin: "https://foreign.test" } } },
    get nodeType(): never {
      throw new Error("must not read foreign node");
    },
  };
  assert.equal(
    JSON.stringify(inspect.call(foreign, ["https://allowed.test"])),
    '{"availability":"unavailable"}',
  );
});

test("inspection failure excludes the stale control and releases its object", async () => {
  const released: string[] = [];
  const result = await inspectGoalControls(
    {
      resolveBackendNode: async () => "object-1",
      callFunctionOnObject: async () => {
        throw new Error("node detached");
      },
      releaseObject: async (id) => {
        released.push(id);
      },
    },
    {
      nodes: [],
      refs: [
        { ref: "@e1", role: "button", name: "Click", disabled: false, nth: 0, backendNodeId: 123 },
      ],
      nodeCount: 1,
      maxNodes: 10,
      truncated: false,
      interactiveOnly: true,
    },
    ["https://allowed.test"],
    new AbortController().signal,
  );
  assert.equal(result.controls?.["@e1"]?.availability, "unavailable");
  assert.deepEqual(released, ["object-1"]);
});

test("optional observation evidence stays unknown unless explicitly supplied", () => {
  const unknown = GoalControlSchema.parse({ availability: "ready" });
  assert.equal(unknown.required, undefined);
  assert.equal(unknown.requiredSource, undefined);
  assert.equal(unknown.position, undefined);
  assert.equal(unknown.ownerPaths, undefined);
  assert.equal(unknown.displayText, undefined);
  assert.equal(unknown.actionValue, undefined);
  assert.equal(unknown.constraints, undefined);
  const observed = GoalControlSchema.parse({
    availability: "ready",
    position: { top: 20, left: 10 },
    ownerPaths: ["/html[1]/body[1]/section[1]"],
    ancestorPaths: ["/html[1]/body[1]/section[1]"],
    required: true,
    requiredSource: "label-required",
    fieldLabel: "Daily rate",
    observedName: "Daily rate",
    displayText: "500元/天",
    actionValue: "submit-token",
    constraints: { maxlength: "20", pattern: "[A-Z]+", multiple: true },
  });
  assert.equal(observed.requiredSource, "label-required");
  assert.equal(observed.displayText, "500元/天");
  assert.equal(observed.observedName, "Daily rate");
  assert.equal(observed.actionValue, "submit-token");
  assert.equal(observed.observedValue, undefined);
  assert.deepEqual(observed.constraints, { maxlength: "20", pattern: "[A-Z]+", multiple: true });
  assert.throws(() =>
    GoalControlSchema.parse({ availability: "ready", constraints: { unsupported: "value" } }),
  );
  assert.throws(() =>
    GoalControlSchema.parse({ availability: "ready", constraints: { multiple: "false" } }),
  );
  assert.throws(() =>
    GoalControlSchema.parse({ availability: "ready", position: { top: Infinity, left: 0 } }),
  );
  assert.throws(() =>
    GoalControlSchema.parse({
      availability: "ready",
      required: false,
      requiredSource: "guessed-from-missing-attribute",
    }),
  );
});
