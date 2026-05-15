import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentContext } from "@roll-agent/sdk";
import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
  NativeCdpController,
  NativeCdpMouseEventInput,
} from "@roll-agent/browser";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import { browserElementRefStore } from "../element-ref-store.ts";
import { browserSnapshot } from "./browser-snapshot.ts";
import { clickRef } from "./click-ref.ts";
import { typeRef } from "./type-ref.ts";

type FakeNativeController = Pick<
  NativeCdpController,
  | "bringToFront"
  | "close"
  | "dispatchKeyEvent"
  | "dispatchMouseEvent"
  | "describeNode"
  | "evaluateJson"
  | "getBoxModelByBackendNodeId"
  | "getDocument"
  | "getFullAccessibilityTree"
  | "insertText"
  | "preflightAction"
  | "querySelectorAllByNodeId"
  | "scrollIntoViewByBackendNodeId"
>;

function axValue(value: string | number | boolean): { readonly value: string | number | boolean } {
  return { value };
}

function createTestContext(): AgentContext {
  return {
    llm: {
      generateText: async () => "",
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

function createNativePage(targetId: string): BrowserInspectablePage {
  return {
    targetId,
    type: "page",
    url: "https://example.com",
    title: "Example",
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${targetId}`,
  };
}

function createFakeContextManager(selectedTargetId = "target-1"): BrowserContextManager {
  return {
    getBoundPlatformForNativePage() {
      return undefined;
    },
    isNativePageSelected(targetId: string) {
      return targetId === selectedTargetId;
    },
  } as unknown as BrowserContextManager;
}

function createFakeRuntime(input: {
  readonly page: BrowserInspectablePage;
  readonly controller: FakeNativeController;
  readonly maxSnapshotNodes?: number;
  readonly actionPolicy?: "log" | "deny" | "confirm";
}): BrowserRuntime {
  return {
    getConfig() {
      return BrowserRuntimeConfigSchema.parse({
        security: {
          ...(input.maxSnapshotNodes !== undefined
            ? { maxSnapshotNodes: input.maxSnapshotNodes }
            : {}),
          ...(input.actionPolicy !== undefined ? { actionPolicy: input.actionPolicy } : {}),
        },
      });
    },
    async listNativePages() {
      return [input.page];
    },
    async connectNativePage() {
      return input.controller as NativeCdpController;
    },
  } as unknown as BrowserRuntime;
}

function createFakeController(): FakeNativeController & {
  readonly mouseEvents: NativeCdpMouseEventInput[];
  readonly preflightCalls: Array<{ readonly action: string; readonly target: string }>;
  readonly scrollCalls: number[];
  readonly closeCalls: string[];
  readonly evaluateExpressions: string[];
  readonly insertedTexts: string[];
  readonly axTreeCalls: Array<{ readonly frameId?: string }>;
  domActionCandidates: unknown;
  fallbackTarget: unknown;
  includeIframe: boolean;
  includeNestedIframe: boolean;
} {
  const mouseEvents: NativeCdpMouseEventInput[] = [];
  const preflightCalls: Array<{ readonly action: string; readonly target: string }> = [];
  const scrollCalls: number[] = [];
  const closeCalls: string[] = [];
  const evaluateExpressions: string[] = [];
  const insertedTexts: string[] = [];
  const axTreeCalls: Array<{ readonly frameId?: string }> = [];
  let domActionMarkerAttribute = "data-roll-browser-action-test";
  let domActionCandidates: unknown = [];
  let fallbackTarget: unknown = {
    found: true,
    x: 20,
    y: 30,
    role: "text",
    name: "未读",
    disabled: false,
  };
  let includeIframe = false;
  let includeNestedIframe = false;

  return {
    mouseEvents,
    preflightCalls,
    scrollCalls,
    closeCalls,
    evaluateExpressions,
    insertedTexts,
    axTreeCalls,
    get domActionCandidates() {
      return domActionCandidates;
    },
    set domActionCandidates(value: unknown) {
      domActionCandidates = value;
    },
    get fallbackTarget() {
      return fallbackTarget;
    },
    set fallbackTarget(value: unknown) {
      fallbackTarget = value;
    },
    get includeIframe() {
      return includeIframe;
    },
    set includeIframe(value: boolean) {
      includeIframe = value;
    },
    get includeNestedIframe() {
      return includeNestedIframe;
    },
    set includeNestedIframe(value: boolean) {
      includeNestedIframe = value;
    },
    async getFullAccessibilityTree(input: { readonly frameId?: string } = {}) {
      axTreeCalls.push(input);
      if (input.frameId === "payment-frame") {
        return [
          {
            nodeId: "frame-1",
            ignored: false,
            role: axValue("RootWebArea"),
            name: axValue("Payment"),
            childIds: includeNestedIframe ? ["frame-2", "frame-3"] : ["frame-2"],
          },
          {
            nodeId: "frame-2",
            ignored: false,
            role: axValue("button"),
            name: axValue("Pay"),
            backendDOMNodeId: 88,
          },
          ...(includeNestedIframe
            ? [
                {
                  nodeId: "frame-3",
                  ignored: false,
                  role: axValue("Iframe"),
                  name: axValue("Security iframe"),
                  backendDOMNodeId: 51,
                },
              ]
            : []),
        ];
      }
      if (input.frameId === "security-frame") {
        return [
          {
            nodeId: "security-1",
            ignored: false,
            role: axValue("RootWebArea"),
            name: axValue("Security"),
            childIds: ["security-2"],
          },
          {
            nodeId: "security-2",
            ignored: false,
            role: axValue("button"),
            name: axValue("Confirm"),
            backendDOMNodeId: 89,
          },
        ];
      }

      return [
        {
          nodeId: "1",
          ignored: false,
          role: axValue("RootWebArea"),
          name: axValue("Example"),
          childIds: includeIframe ? ["2", "3", "4"] : ["2", "3"],
        },
        {
          nodeId: "2",
          ignored: false,
          role: axValue("button"),
          name: axValue("Save"),
          backendDOMNodeId: 42,
        },
        {
          nodeId: "3",
          ignored: false,
          role: axValue("button"),
          name: axValue("Cancel"),
          backendDOMNodeId: 43,
        },
        ...(includeIframe
          ? [
              {
                nodeId: "4",
                ignored: false,
                role: axValue("Iframe"),
                name: axValue("Payment iframe"),
                backendDOMNodeId: 50,
              },
            ]
          : []),
      ];
    },
    async bringToFront() {},
    async evaluateJson<T = unknown>(expression: string): Promise<T> {
      evaluateExpressions.push(expression);
      if (expression.includes("removeAttribute")) {
        return true as T;
      }
      if (expression.includes("data-roll-browser-action-")) {
        return domActionCandidates as T;
      }
      if (expression.includes("targetRole")) {
        return fallbackTarget as T;
      }
      return true as T;
    },
    async getDocument() {
      return {
        root: {
          nodeId: 1,
        },
      };
    },
    async querySelectorAllByNodeId(input: { readonly selector: string }) {
      domActionMarkerAttribute = input.selector.replace(/^\[|\]$/g, "");
      return [101];
    },
    async describeNode(input: { readonly backendNodeId?: number }) {
      if (input.backendNodeId === 50) {
        return {
          backendNodeId: 50,
          nodeName: "IFRAME",
          contentDocumentFrameId: "payment-frame",
        };
      }
      if (input.backendNodeId === 51) {
        return {
          backendNodeId: 51,
          nodeName: "IFRAME",
          contentDocumentFrameId: "security-frame",
        };
      }

      return {
        nodeId: 101,
        backendNodeId: 44,
        attributes: [domActionMarkerAttribute, "0"],
      };
    },
    preflightAction(input: { readonly action: string; readonly target: string }) {
      preflightCalls.push(input);
    },
    async scrollIntoViewByBackendNodeId(input: { readonly backendNodeId: number }) {
      scrollCalls.push(input.backendNodeId);
    },
    async getBoxModelByBackendNodeId() {
      return {
        border: [10, 20, 30, 20, 30, 40, 10, 40],
      };
    },
    async dispatchMouseEvent(input: NativeCdpMouseEventInput) {
      mouseEvents.push(input);
    },
    async dispatchKeyEvent() {},
    async insertText(text: string) {
      insertedTexts.push(text);
    },
    close() {
      closeCalls.push("close");
    },
  };
}

afterEach(() => {
  setRuntimeStateForTests({});
  browserElementRefStore.clear();
});

describe("browser generic ref tools", () => {
  it("browser_snapshot caps output by maxSnapshotNodes and stores refs for click_ref", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page,
        controller,
        maxSnapshotNodes: 1,
      }),
      contextManager: createFakeContextManager(),
    });

    const snapshotResult = await browserSnapshot.execute(
      { pageId: "target-1", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );

    assert.equal(snapshotResult.snapshot.maxNodes, 1);
    assert.equal(snapshotResult.snapshot.truncated, true);
    assert.equal(snapshotResult.snapshot.refs.length, 1);
    assert.equal(snapshotResult.snapshot.refs[0]?.ref, "@e1");

    const clickResult = await clickRef.execute(
      { pageId: "target-1", ref: "@e1" },
      createTestContext(),
    );

    assert.equal(clickResult.success, true);
    assert.equal(clickResult.resolvedBy, "backend_node_id");
    assert.deepEqual(controller.scrollCalls, [42]);
    assert.ok(controller.mouseEvents.some((event) => event.type === "mouseMoved"));
    assert.ok(controller.mouseEvents.some((event) => event.type === "mousePressed"));
    assert.ok(controller.mouseEvents.some((event) => event.type === "mouseReleased"));
    assert.ok(
      controller.evaluateExpressions.some((expression) => expression.includes("正在读取页面快照")),
    );
    assert.ok(
      controller.evaluateExpressions.some((expression) => expression.includes("已点击 @e1")),
    );
    assert.equal(controller.closeCalls.length, 2);
  });

  it("browser_snapshot adds DOM actionable text refs for clickable non-semantic spans", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    controller.domActionCandidates = [
      {
        marker: "0",
        name: "未读",
        disabled: false,
        hasClassHint: true,
        hasCursorPointer: false,
        hasOnClick: false,
        hasTabIndex: false,
        isEditable: false,
      },
    ];
    controller.fallbackTarget = {
      found: true,
      x: 44,
      y: 22,
      role: "clickable",
      name: "未读",
      disabled: false,
    };
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page,
        controller,
      }),
      contextManager: createFakeContextManager(),
    });

    const snapshotResult = await browserSnapshot.execute(
      { pageId: "target-1", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );

    const unreadRef = snapshotResult.snapshot.refs.find((ref) => ref.name === "未读");
    assert.notEqual(unreadRef, undefined);
    if (unreadRef === undefined) {
      throw new Error("Expected unread ref to be emitted");
    }

    assert.equal(unreadRef.role, "clickable");
    assert.equal(unreadRef.backendNodeId, 44);
    assert.equal(
      snapshotResult.snapshot.nodes.some(
        (node) =>
          node.ref === unreadRef.ref &&
          node.properties?.["domActionable"] === true &&
          node.properties?.["domActionHints"] === "class:action" &&
          node.name === "未读",
      ),
      true,
    );

    const clickResult = await clickRef.execute(
      { pageId: "target-1", ref: unreadRef.ref },
      createTestContext(),
    );

    assert.equal(clickResult.success, true);
    assert.equal(clickResult.resolvedBy, "backend_node_id");
    assert.equal(clickResult.target.name, "未读");
    assert.deepEqual(controller.scrollCalls, [44]);
    assert.ok(controller.mouseEvents.some((event) => event.type === "mousePressed"));
    assert.ok(
      controller.evaluateExpressions.some((expression) => expression.includes("removeAttribute")),
    );
  });

  it("browser_snapshot classifies editable DOM action candidates before clickable hints", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    controller.domActionCandidates = [
      {
        marker: "0",
        name: "备注",
        disabled: false,
        hasClassHint: true,
        hasCursorPointer: true,
        hasOnClick: false,
        hasTabIndex: false,
        isEditable: true,
      },
    ];
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page,
        controller,
      }),
      contextManager: createFakeContextManager(),
    });

    const snapshotResult = await browserSnapshot.execute(
      { pageId: "target-1", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );

    const editableRef = snapshotResult.snapshot.refs.find((ref) => ref.name === "备注");
    assert.notEqual(editableRef, undefined);
    if (editableRef === undefined) {
      throw new Error("Expected editable ref to be emitted");
    }

    assert.equal(editableRef.role, "editable");
    assert.equal(editableRef.backendNodeId, 44);
  });

  it("type_ref shows native visual feedback and inserts text", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page,
        controller,
      }),
      contextManager: createFakeContextManager(),
    });

    await browserSnapshot.execute(
      { pageId: "target-1", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );

    const result = await typeRef.execute(
      { pageId: "target-1", ref: "@e1", text: "hello", clear: false },
      createTestContext(),
    );

    assert.equal(result.success, true);
    assert.deepEqual(controller.insertedTexts, ["hello"]);
    assert.ok(
      controller.evaluateExpressions.some((expression) => expression.includes("正在输入到 @e1")),
    );
    assert.ok(
      controller.evaluateExpressions.some((expression) => expression.includes("已输入到 @e1")),
    );
    assert.ok(controller.mouseEvents.some((event) => event.type === "mouseMoved"));
    assert.ok(controller.mouseEvents.some((event) => event.type === "mousePressed"));
    assert.ok(controller.mouseEvents.some((event) => event.type === "mouseReleased"));
  });

  it("browser_snapshot inlines same-target iframe refs and click_ref keeps frame context", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    controller.includeIframe = true;
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page,
        controller,
      }),
      contextManager: createFakeContextManager(),
    });

    const snapshotResult = await browserSnapshot.execute(
      { pageId: "target-1", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );

    const payRef = snapshotResult.snapshot.refs.find((ref) => ref.name === "Pay");
    assert.notEqual(payRef, undefined);
    if (payRef === undefined) {
      throw new Error("Expected iframe Pay ref to be emitted");
    }

    assert.equal(payRef.ref, "@e4");
    assert.equal(payRef.frameId, "payment-frame");
    assert.equal(payRef.backendNodeId, 88);
    assert.equal(
      snapshotResult.snapshot.nodes.some(
        (node) => node.ref === payRef.ref && node.frameId === "payment-frame" && node.depth === 3,
      ),
      true,
    );
    assert.deepEqual(controller.axTreeCalls, [{}, { frameId: "payment-frame" }]);

    const clickResult = await clickRef.execute(
      { pageId: "target-1", ref: payRef.ref },
      createTestContext(),
    );

    assert.equal(clickResult.success, true);
    assert.equal(clickResult.resolvedBy, "backend_node_id");
    assert.equal(clickResult.target.frameId, "payment-frame");
    assert.equal(clickResult.target.backendNodeId, 88);
    assert.deepEqual(controller.scrollCalls, [88]);
  });

  it("browser_snapshot recursively inlines nested same-target iframe refs", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    controller.includeIframe = true;
    controller.includeNestedIframe = true;
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page,
        controller,
      }),
      contextManager: createFakeContextManager(),
    });

    const snapshotResult = await browserSnapshot.execute(
      { pageId: "target-1", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );

    const confirmRef = snapshotResult.snapshot.refs.find((ref) => ref.name === "Confirm");
    assert.notEqual(confirmRef, undefined);
    if (confirmRef === undefined) {
      throw new Error("Expected nested iframe Confirm ref to be emitted");
    }

    assert.equal(confirmRef.ref, "@e6");
    assert.equal(confirmRef.frameId, "security-frame");
    assert.equal(confirmRef.backendNodeId, 89);
    assert.equal(
      snapshotResult.snapshot.nodes.some(
        (node) =>
          node.ref === confirmRef.ref && node.frameId === "security-frame" && node.depth === 5,
      ),
      true,
    );
    assert.deepEqual(controller.axTreeCalls, [
      {},
      { frameId: "payment-frame" },
      { frameId: "security-frame" },
    ]);

    const clickResult = await clickRef.execute(
      { pageId: "target-1", ref: confirmRef.ref },
      createTestContext(),
    );

    assert.equal(clickResult.success, true);
    assert.equal(clickResult.target.frameId, "security-frame");
    assert.equal(clickResult.target.backendNodeId, 89);
    assert.deepEqual(controller.scrollCalls, [89]);
  });
});
