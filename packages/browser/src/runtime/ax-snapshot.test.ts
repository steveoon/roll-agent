import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserAxSnapshot, isBrowserElementRefHandle } from "./ax-snapshot.ts";

type FakeAxController = {
  readonly getFullAccessibilityTree: (options?: {
    readonly frameId?: string;
  }) => Promise<readonly unknown[]>;
};

function axValue(value: string | number | boolean): { readonly value: string | number | boolean } {
  return { value };
}

test("createBrowserAxSnapshot returns interactive @eN refs by default", async () => {
  const controller: FakeAxController = {
    getFullAccessibilityTree: async () => [
      {
        nodeId: "1",
        ignored: false,
        role: axValue("RootWebArea"),
        name: axValue("Demo"),
        childIds: ["2", "3", "4"],
      },
      {
        nodeId: "2",
        ignored: false,
        role: axValue("button"),
        name: axValue("Save"),
        backendDOMNodeId: 11,
        properties: [{ name: "focusable", value: axValue(true) }],
      },
      {
        nodeId: "3",
        ignored: false,
        role: axValue("StaticText"),
        name: axValue("Body copy"),
      },
      {
        nodeId: "4",
        ignored: false,
        role: axValue("button"),
        name: axValue("Save"),
        backendDOMNodeId: 12,
        properties: [{ name: "disabled", value: axValue(true) }],
      },
    ],
  };

  const snapshot = await createBrowserAxSnapshot(controller, { maxNodes: 10 });

  assert.equal(snapshot.interactiveOnly, true);
  assert.equal(snapshot.nodeCount, 2);
  assert.deepEqual(
    snapshot.refs.map((ref) => ({
      ref: ref.ref,
      backendNodeId: ref.backendNodeId,
      nth: ref.nth,
      disabled: ref.disabled,
    })),
    [
      { ref: "@e1", backendNodeId: 11, nth: 0, disabled: false },
      { ref: "@e2", backendNodeId: 12, nth: 1, disabled: true },
    ],
  );
  assert.deepEqual(
    snapshot.nodes.map((node) => ({ ref: node.ref, role: node.role, name: node.name })),
    [
      { ref: "@e1", role: "button", name: "Save" },
      { ref: "@e2", role: "button", name: "Save" },
    ],
  );
  assert.equal(isBrowserElementRefHandle("@e12"), true);
  assert.equal(isBrowserElementRefHandle("@e0"), false);
  assert.equal(isBrowserElementRefHandle("@c12"), false);
});

test("createBrowserAxSnapshot can preserve tree structure and apply maxNodes", async () => {
  const controller: FakeAxController = {
    getFullAccessibilityTree: async () => [
      {
        nodeId: "1",
        ignored: false,
        role: axValue("RootWebArea"),
        name: axValue("Demo"),
        childIds: ["2", "3"],
      },
      {
        nodeId: "2",
        ignored: false,
        role: axValue("group"),
        name: axValue("Toolbar"),
        childIds: ["4"],
      },
      {
        nodeId: "3",
        ignored: false,
        role: axValue("link"),
        name: axValue("Docs"),
        backendDOMNodeId: 21,
      },
      {
        nodeId: "4",
        ignored: false,
        role: axValue("textbox"),
        name: axValue("Search"),
        backendDOMNodeId: 22,
      },
    ],
  };

  const snapshot = await createBrowserAxSnapshot(controller, {
    interactiveOnly: false,
    maxNodes: 3,
  });

  assert.equal(snapshot.interactiveOnly, false);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.nodeCount, 3);
  assert.equal(snapshot.nodes[0]?.role, "rootwebarea");
  assert.equal(snapshot.nodes[0]?.children?.[0]?.role, "group");
  assert.equal(snapshot.refs.length, 1);
  assert.equal(snapshot.refs[0]?.ref, "@e1");
  assert.equal(snapshot.refs[0]?.role, "textbox");
});

test("createBrowserAxSnapshot promotes DOM action hints into ref-bearing nodes", async () => {
  const controller: FakeAxController = {
    getFullAccessibilityTree: async () => [
      {
        nodeId: "1",
        ignored: false,
        role: axValue("RootWebArea"),
        name: axValue("Demo"),
        childIds: ["2"],
      },
      {
        nodeId: "2",
        ignored: false,
        role: axValue("StaticText"),
        name: axValue("未读"),
        backendDOMNodeId: 44,
      },
    ],
  };

  const snapshot = await createBrowserAxSnapshot(controller, {
    domActionHints: [
      {
        backendNodeId: 44,
        kind: "clickable",
        name: "未读",
        hints: ["cursor:pointer"],
        disabled: false,
      },
    ],
    interactiveOnly: true,
    maxNodes: 10,
  });

  assert.equal(snapshot.refs.length, 1);
  assert.deepEqual(snapshot.refs[0], {
    ref: "@e1",
    backendNodeId: 44,
    role: "clickable",
    name: "未读",
    nth: 0,
    disabled: false,
  });
  assert.deepEqual(snapshot.nodes[0], {
    ref: "@e1",
    role: "clickable",
    name: "未读",
    ignored: false,
    depth: 1,
    backendNodeId: 44,
    properties: {
      domActionable: true,
      domActionKind: "clickable",
      domActionHints: "cursor:pointer",
      originalRole: "statictext",
    },
  });
});

test("createBrowserAxSnapshot carries frame context and ref offsets", async () => {
  const requestedFrameIds: Array<string | undefined> = [];
  const controller: FakeAxController = {
    getFullAccessibilityTree: async (options) => {
      requestedFrameIds.push(options?.frameId);
      return [
        {
          nodeId: "1",
          ignored: false,
          role: axValue("RootWebArea"),
          name: axValue("Frame"),
          childIds: ["2"],
        },
        {
          nodeId: "2",
          ignored: false,
          role: axValue("button"),
          name: axValue("Pay"),
          backendDOMNodeId: 88,
        },
      ];
    },
  };

  const snapshot = await createBrowserAxSnapshot(controller, {
    depthOffset: 3,
    frameId: "payment-frame",
    initialRefCount: 5,
    maxNodes: 10,
  });

  assert.deepEqual(requestedFrameIds, ["payment-frame"]);
  assert.deepEqual(snapshot.refs[0], {
    ref: "@e6",
    backendNodeId: 88,
    frameId: "payment-frame",
    role: "button",
    name: "Pay",
    nth: 0,
    disabled: false,
  });
  assert.equal(snapshot.nodes[0]?.ref, "@e6");
  assert.equal(snapshot.nodes[0]?.frameId, "payment-frame");
  assert.equal(snapshot.nodes[0]?.depth, 4);
});
