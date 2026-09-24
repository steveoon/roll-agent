import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { attachTaskText, READ_GOAL_TEXT } from "./task-observation.ts";
import type { GoalSnapshot } from "./observation.ts";

test("text collection keeps the control snapshot/ref budget intact and reads each allowed frame once", async () => {
  const snapshot: GoalSnapshot = {
    documentId: "doc",
    snapshotId: "controls",
    nodeCount: 3,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
    nodes: [],
    refs: [
      {
        ref: "@e1",
        role: "button",
        name: "Root",
        nth: 0,
        disabled: false,
        backendNodeId: 1,
        frameId: "root",
      },
      {
        ref: "@e2",
        role: "textbox",
        name: "Child",
        nth: 0,
        disabled: false,
        backendNodeId: 2,
        frameId: "child",
      },
      {
        ref: "@e3",
        role: "textbox",
        name: "Other",
        nth: 0,
        disabled: false,
        backendNodeId: 3,
        frameId: "child",
      },
    ],
  };
  const reads: string[] = [];
  const released: string[] = [];
  const result = await attachTaskText(
    {
      resolveBackendNode: async ({ backendNodeId }) => String(backendNodeId),
      callFunctionOnObject: async ({ objectId }) => {
        reads.push(objectId);
        return {
          text: `text-${objectId}`,
          truncated: false,
          pageState: {
            panels: objectId === "1" ? ["Notice"] : [],
            selectedTabs: objectId === "2" ? ["Closed"] : [],
            busy: false,
          },
        };
      },
      releaseObject: async (id) => {
        released.push(id);
      },
    },
    snapshot,
    ["https://example.com"],
    new AbortController().signal,
  );
  assert.deepEqual(reads, ["1", "2"]);
  assert.deepEqual(released, reads);
  assert.equal(result.snapshotId, "controls");
  assert.equal(result.refs, snapshot.refs);
  assert.equal(result.pageText, "text-1\ntext-2");
  assert.equal(result.truncated, false);
  assert.deepEqual(result.pageState, { panels: ["Notice"], selectedTabs: ["Closed"], busy: false });
});

test("text collection checks the origin before accessing a foreign body", () => {
  const read: (this: unknown, origins: string[], limit: number) => unknown = runInNewContext(
    `(${READ_GOAL_TEXT})`,
  );
  const foreign = {
    ownerDocument: {
      defaultView: { location: { origin: "https://foreign.test" } },
      get body(): never {
        throw new Error("Foreign DOM must not be read");
      },
    },
  };
  assert.equal(
    JSON.stringify(read.call(foreign, ["https://example.com"], 6000)),
    '{"text":"","truncated":true}',
  );
});
