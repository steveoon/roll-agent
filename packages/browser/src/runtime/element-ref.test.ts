import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserElementRef } from "../types/index.ts";
import { BrowserElementRefStore, clickElementRef, typeElementRef } from "./element-ref.ts";
import type {
  NativeCdpBoxModel,
  NativeCdpKeyEventInput,
  NativeCdpMouseEventInput,
} from "./native-cdp-controller.ts";

class FakeElementRefController {
  readonly preflightCalls: Array<{ readonly action: string; readonly target: string }> = [];
  readonly mouseEvents: NativeCdpMouseEventInput[] = [];
  readonly keyEvents: NativeCdpKeyEventInput[] = [];
  readonly scrolledBackendNodeIds: number[] = [];
  readonly evaluatedExpressions: string[] = [];
  readonly axTreeCalls: Array<{ readonly frameId?: string }> = [];
  insertedText = "";
  boxModel: NativeCdpBoxModel | undefined;
  axTree: readonly unknown[] = [];
  fallbackTarget: unknown;

  preflightAction(input: { readonly action: string; readonly target: string }): void {
    this.preflightCalls.push(input);
  }

  async scrollIntoViewByBackendNodeId(input: { readonly backendNodeId: number }): Promise<void> {
    this.scrolledBackendNodeIds.push(input.backendNodeId);
  }

  async getBoxModelByBackendNodeId(): Promise<NativeCdpBoxModel | undefined> {
    return this.boxModel;
  }

  async evaluateJson<T = unknown>(expression: string): Promise<T> {
    this.evaluatedExpressions.push(expression);
    return this.fallbackTarget as T;
  }

  async getFullAccessibilityTree(
    input: { readonly frameId?: string } = {},
  ): Promise<readonly unknown[]> {
    this.axTreeCalls.push(input);
    return this.axTree;
  }

  async dispatchMouseEvent(input: NativeCdpMouseEventInput): Promise<void> {
    this.mouseEvents.push(input);
  }

  async dispatchKeyEvent(input: NativeCdpKeyEventInput): Promise<void> {
    this.keyEvents.push(input);
  }

  async insertText(text: string): Promise<void> {
    this.insertedText += text;
  }
}

const SAVE_BUTTON_REF: BrowserElementRef = {
  ref: "@e1",
  backendNodeId: 42,
  role: "button",
  name: "Save",
  nth: 0,
  disabled: false,
};

test("clickElementRef resolves by backendNodeId before dispatching mouse events", async () => {
  const controller = new FakeElementRefController();
  controller.boxModel = {
    border: [0, 0, 20, 0, 20, 40, 0, 40],
  };

  const result = await clickElementRef({ controller, elementRef: SAVE_BUTTON_REF });

  assert.equal(result.resolvedBy, "backend_node_id");
  assert.equal(result.target.x, 10);
  assert.equal(result.target.y, 20);
  assert.deepEqual(controller.preflightCalls, [{ action: "click", target: "@e1" }]);
  assert.deepEqual(controller.scrolledBackendNodeIds, [42]);
  assert.deepEqual(
    controller.mouseEvents.map((event) => event.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
});

test("typeElementRef falls back to role/name/nth and can clear existing text", async () => {
  const controller = new FakeElementRefController();
  controller.fallbackTarget = {
    found: true,
    x: 30,
    y: 50,
    role: "textbox",
    name: "Email",
    disabled: false,
  };
  const textRef: BrowserElementRef = {
    ref: "@e2",
    backendNodeId: 77,
    role: "textbox",
    name: "Email",
    nth: 1,
    disabled: false,
  };

  const result = await typeElementRef({
    controller,
    elementRef: textRef,
    text: "hello@example.com",
    options: { clear: true },
  });

  assert.equal(result.resolvedBy, "role_name_nth");
  assert.equal(controller.evaluatedExpressions.length, 1);
  assert.match(controller.evaluatedExpressions[0] ?? "", /targetNth = 1/);
  assert.deepEqual(controller.preflightCalls, [{ action: "type", target: "@e2" }]);
  assert.deepEqual(
    controller.mouseEvents.map((event) => event.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.deepEqual(
    controller.keyEvents.map((event) => `${event.type}:${event.key}`),
    ["rawKeyDown:a", "keyUp:a", "rawKeyDown:Backspace", "keyUp:Backspace"],
  );
  assert.equal(controller.insertedText, "hello@example.com");
});

test("clickElementRef falls back for DOM action refs without backendNodeId", async () => {
  const controller = new FakeElementRefController();
  controller.fallbackTarget = {
    found: true,
    x: 44,
    y: 22,
    role: "clickable",
    name: "未读",
    disabled: false,
  };

  const result = await clickElementRef({
    controller,
    elementRef: {
      ref: "@e3",
      role: "clickable",
      name: "未读",
      nth: 0,
      disabled: false,
    },
  });

  assert.equal(result.resolvedBy, "role_name_nth");
  assert.equal(result.target.name, "未读");
  assert.deepEqual(controller.scrolledBackendNodeIds, []);
  assert.match(controller.evaluatedExpressions[0] ?? "", /targetRole = "clickable"/);
  assert.deepEqual(
    controller.mouseEvents.map((event) => event.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
});

test("BrowserElementRefStore stores refs per page key", () => {
  const store = new BrowserElementRefStore();
  store.saveSnapshot("page-1", {
    nodes: [],
    refs: [SAVE_BUTTON_REF],
    nodeCount: 0,
    truncated: false,
    maxNodes: 10,
    interactiveOnly: true,
  });

  assert.deepEqual(store.getRef("page-1", "@e1"), SAVE_BUTTON_REF);
  assert.equal(store.getRef("page-2", "@e1"), undefined);
});

test("clickElementRef blocks a disabled backendNodeId target from the snapshot", async () => {
  const controller = new FakeElementRefController();
  controller.boxModel = {
    border: [0, 0, 20, 0, 20, 40, 0, 40],
  };

  await assert.rejects(
    clickElementRef({
      controller,
      elementRef: {
        ...SAVE_BUTTON_REF,
        disabled: true,
      },
    }),
    /disabled element/,
  );

  assert.deepEqual(controller.preflightCalls, [{ action: "click", target: "@e1" }]);
  assert.deepEqual(controller.mouseEvents, []);
});

test("clickElementRef falls back inside frame by re-querying frame AX tree", async () => {
  const controller = new FakeElementRefController();
  controller.boxModel = undefined;
  controller.axTree = [
    {
      nodeId: "1",
      ignored: false,
      role: { value: "RootWebArea" },
      name: { value: "Payment" },
      childIds: ["2"],
    },
    {
      nodeId: "2",
      ignored: false,
      role: { value: "button" },
      name: { value: "Pay" },
      backendDOMNodeId: 99,
    },
  ];
  let boxCallCount = 0;
  controller.getBoxModelByBackendNodeId = async () => {
    boxCallCount += 1;
    return boxCallCount === 1
      ? undefined
      : {
          border: [40, 60, 80, 60, 80, 100, 40, 100],
        };
  };

  const result = await clickElementRef({
    controller,
    elementRef: {
      ref: "@e4",
      backendNodeId: 77,
      frameId: "payment-frame",
      role: "button",
      name: "Pay",
      nth: 0,
      disabled: false,
    },
  });

  assert.equal(result.resolvedBy, "role_name_nth");
  assert.equal(result.target.frameId, "payment-frame");
  assert.equal(result.target.x, 60);
  assert.equal(result.target.y, 80);
  assert.deepEqual(controller.axTreeCalls, [{ frameId: "payment-frame" }]);
  assert.deepEqual(controller.scrolledBackendNodeIds, [77, 99]);
  assert.deepEqual(controller.evaluatedExpressions, []);
});
