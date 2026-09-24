import assert from "node:assert/strict";
import test from "node:test";
import { createDependencyObserver } from "./dependency-observation.ts";
import type { GoalSnapshot } from "./observation.ts";
import { taskControlIdentity } from "./task-policy.ts";

function snapshot(modal = false): GoalSnapshot {
  return {
    documentId: "doc",
    nodes: modal
      ? [{ role: "dialog", name: "Pick", depth: 0, ignored: false, properties: { modal: true } }]
      : [],
    refs: modal
      ? []
      : [
          {
            ref: "@e1",
            backendNodeId: 1,
            frameId: "root",
            role: "button",
            name: "Field",
            disabled: false,
            nth: 0,
          },
        ],
    nodeCount: 1,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
  };
}

test("dependency observation only inspects retained live nodes in an allowed modal document", async () => {
  let detached = false;
  let frameId = "root";
  let inspections = 0;
  const controller: Parameters<typeof createDependencyObserver>[0] = {
    getFrameTree: async () => ({ frame: { id: frameId, url: "https://example.test/form" } }),
    resolveBackendNode: async () => {
      if (detached) throw new Error("detached");
      return "object";
    },
    callFunctionOnObject: async () => {
      inspections++;
      return {
        availability: "covered",
        context: ["Field"],
        domSemantics: { tag: "button", role: "", disabled: false, readOnly: false },
      };
    },
    releaseObject: async () => {},
  };
  const observe = createDependencyObserver(
    controller,
    ["https://example.test"],
    new AbortController().signal,
  );
  const visible = snapshot();
  const identity = taskControlIdentity(visible.refs[0]!);
  await observe(visible);
  const ordinary = { ...snapshot(), refs: [] };
  assert.equal((await observe(ordinary, [identity])).dependencyControls, undefined);
  assert.equal(inspections, 0);
  const modal = snapshot(true);
  const result = await observe(modal, [identity]);
  assert.ok(result.dependencyControls?.[identity]);
  assert.deepEqual(result.refs, []);
  assert.equal(result.nodes.length, 1);
  assert.equal(inspections, 1);
  detached = true;
  assert.deepEqual((await observe(modal, [identity])).dependencyControls, {});
  detached = false;
  frameId = "replaced-frame";
  assert.deepEqual((await observe(modal, [identity])).dependencyControls, {});
  assert.equal(inspections, 1);
  frameId = "root";
  assert.equal(
    (await observe({ ...modal, documentId: "new-doc" }, [identity])).dependencyControls,
    undefined,
  );
  assert.equal(
    (await observe(modal, [identity])).dependencyControls,
    undefined,
    "Old document handles cannot revive after navigation back",
  );
  assert.equal(inspections, 1);
});
