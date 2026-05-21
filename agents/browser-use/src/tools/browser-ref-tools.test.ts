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
  | "createIsolatedWorld"
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
  readonly foregroundPolicy?: "when-minimized" | "always" | "never";
  readonly windowState?: "normal" | "minimized" | "maximized" | "fullscreen" | "unknown";
}): BrowserRuntime {
  return {
    getConfig() {
      return BrowserRuntimeConfigSchema.parse({
        security: {
          ...(input.maxSnapshotNodes !== undefined
            ? { maxSnapshotNodes: input.maxSnapshotNodes }
            : {}),
          ...(input.actionPolicy !== undefined ? { actionPolicy: input.actionPolicy } : {}),
          ...(input.foregroundPolicy !== undefined
            ? { foregroundPolicy: input.foregroundPolicy }
            : {}),
        },
      });
    },
    async listNativePages() {
      return [input.page];
    },
    async connectNativePage() {
      return input.controller as NativeCdpController;
    },
    async getNativePageWindowState() {
      return input.windowState ?? "normal";
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
  readonly bringToFrontCalls: string[];
  readonly axTreeCalls: Array<{ readonly frameId?: string }>;
  readonly isolatedWorldCalls: string[];
  domActionCandidates: unknown;
  frameDomActionCandidates: unknown;
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
  const bringToFrontCalls: string[] = [];
  const axTreeCalls: Array<{ readonly frameId?: string }> = [];
  const isolatedWorldCalls: string[] = [];
  const frameIdByContextId = new Map<number, string>();
  let domActionMarkerAttribute = "data-roll-browser-action-test";
  let frameDomActionMarkerAttribute = "data-roll-browser-action-frame-test";
  let lastFrameDomActionFrameId: string | undefined;
  let domActionCandidates: unknown = [];
  let frameDomActionCandidates: unknown = [];
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
    bringToFrontCalls,
    axTreeCalls,
    isolatedWorldCalls,
    get domActionCandidates() {
      return domActionCandidates;
    },
    set domActionCandidates(value: unknown) {
      domActionCandidates = value;
    },
    get frameDomActionCandidates() {
      return frameDomActionCandidates;
    },
    set frameDomActionCandidates(value: unknown) {
      frameDomActionCandidates = value;
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
    async bringToFront() {
      bringToFrontCalls.push("front");
    },
    async createIsolatedWorld(frameId: string) {
      isolatedWorldCalls.push(frameId);
      const contextId = frameId === "payment-frame" ? 501 : 502;
      frameIdByContextId.set(contextId, frameId);
      return contextId;
    },
    async evaluateJson<T = unknown>(
      expression: string,
      options: { readonly contextId?: number } = {},
    ): Promise<T> {
      evaluateExpressions.push(expression);
      if (expression.includes("removeAttribute")) {
        return true as T;
      }
      if (expression.includes("data-roll-browser-action-")) {
        const marker = expression.match(/data-roll-browser-action-[a-f0-9]+/)?.[0];
        const frameId =
          options.contextId === undefined ? undefined : frameIdByContextId.get(options.contextId);
        if (frameId !== undefined) {
          lastFrameDomActionFrameId = frameId;
          if (marker !== undefined) {
            frameDomActionMarkerAttribute = marker;
          }
          return frameDomActionCandidates as T;
        }
        if (marker !== undefined) {
          domActionMarkerAttribute = marker;
        }
        return domActionCandidates as T;
      }
      if (expression.includes("targetRole")) {
        return fallbackTarget as T;
      }
      return true as T;
    },
    async getDocument(input: { readonly pierce?: boolean } = {}) {
      if (input.pierce === true && lastFrameDomActionFrameId !== undefined) {
        return {
          root: {
            nodeId: 1,
            children: [
              {
                nodeId: 2,
                nodeName: "IFRAME",
                contentDocument: {
                  nodeId: 3,
                  children: [
                    {
                      nodeId: 4,
                      backendNodeId: 87,
                      attributes: [frameDomActionMarkerAttribute, "0"],
                    },
                  ],
                },
              },
            ],
          },
        };
      }

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

  it("click_ref brings the browser forward when foregroundPolicy is always", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page,
        controller,
        foregroundPolicy: "always",
      }),
      contextManager: createFakeContextManager(),
    });

    await browserSnapshot.execute(
      { pageId: "target-1", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );
    await clickRef.execute({ pageId: "target-1", ref: "@e1" }, createTestContext());

    assert.deepEqual(controller.bringToFrontCalls, ["front"]);
  });

  it("click_ref does not bring the browser forward when foregroundPolicy is never", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page,
        controller,
        foregroundPolicy: "never",
      }),
      contextManager: createFakeContextManager(),
    });

    await browserSnapshot.execute(
      { pageId: "target-1", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );
    await clickRef.execute({ pageId: "target-1", ref: "@e1" }, createTestContext());

    assert.deepEqual(controller.bringToFrontCalls, []);
  });

  it("click_ref only brings the browser forward for minimized windows by default", async () => {
    const normalPage = createNativePage("target-normal");
    const normalController = createFakeController();
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page: normalPage,
        controller: normalController,
        windowState: "normal",
      }),
      contextManager: createFakeContextManager("target-normal"),
    });
    await browserSnapshot.execute(
      { pageId: "target-normal", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );
    await clickRef.execute({ pageId: "target-normal", ref: "@e1" }, createTestContext());
    assert.deepEqual(normalController.bringToFrontCalls, []);

    browserElementRefStore.clear();
    const minimizedPage = createNativePage("target-minimized");
    const minimizedController = createFakeController();
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page: minimizedPage,
        controller: minimizedController,
        windowState: "minimized",
      }),
      contextManager: createFakeContextManager("target-minimized"),
    });
    await browserSnapshot.execute(
      { pageId: "target-minimized", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );
    await clickRef.execute({ pageId: "target-minimized", ref: "@e1" }, createTestContext());
    assert.deepEqual(minimizedController.bringToFrontCalls, ["front"]);

    browserElementRefStore.clear();
    const unknownPage = createNativePage("target-unknown");
    const unknownController = createFakeController();
    setRuntimeStateForTests({
      runtime: createFakeRuntime({
        page: unknownPage,
        controller: unknownController,
        windowState: "unknown",
      }),
      contextManager: createFakeContextManager("target-unknown"),
    });
    await browserSnapshot.execute(
      { pageId: "target-unknown", maxNodes: 10, interactiveOnly: true },
      createTestContext(),
    );
    await clickRef.execute({ pageId: "target-unknown", ref: "@e1" }, createTestContext());
    assert.deepEqual(unknownController.bringToFrontCalls, []);
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

  it("browser_snapshot adds DOM actionable refs inside same-target iframes", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    controller.includeIframe = true;
    controller.frameDomActionCandidates = [
      {
        marker: "0",
        name: "发布职位",
        disabled: false,
        hasClassHint: true,
        hasCursorPointer: true,
        hasOnClick: false,
        hasTabIndex: false,
        isEditable: false,
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

    const publishRef = snapshotResult.snapshot.refs.find((ref) => ref.name === "发布职位");
    assert.notEqual(publishRef, undefined);
    if (publishRef === undefined) {
      throw new Error("Expected iframe DOM-action ref to be emitted");
    }

    assert.equal(publishRef.ref, "@e5");
    assert.equal(publishRef.role, "clickable");
    assert.equal(publishRef.frameId, "payment-frame");
    assert.equal(publishRef.backendNodeId, 87);
    assert.equal(
      snapshotResult.snapshot.nodes.some(
        (node) =>
          node.ref === publishRef.ref &&
          node.frameId === "payment-frame" &&
          node.properties?.["domActionable"] === true &&
          node.properties?.["domActionHints"] === "cursor:pointer, class:action",
      ),
      true,
    );
    assert.deepEqual(controller.isolatedWorldCalls, ["payment-frame"]);

    const clickResult = await clickRef.execute(
      { pageId: "target-1", ref: publishRef.ref },
      createTestContext(),
    );

    assert.equal(clickResult.success, true);
    assert.equal(clickResult.resolvedBy, "backend_node_id");
    assert.equal(clickResult.target.name, "发布职位");
    assert.equal(clickResult.target.frameId, "payment-frame");
    assert.deepEqual(controller.scrollCalls, [87]);
  });

  it("browser_snapshot promotes composite dropdown option rows inside iframes", async () => {
    const page = createNativePage("target-1");
    const controller = createFakeController();
    controller.includeIframe = true;
    controller.frameDomActionCandidates = [
      {
        marker: "0",
        name: "乡村基（重庆）投资有限公司 餐饮",
        disabled: false,
        hasClassHint: true,
        hasCursorPointer: false,
        hasOnClick: false,
        hasTabIndex: false,
        isEditable: false,
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

    const companyRef = snapshotResult.snapshot.refs.find((ref) =>
      ref.name.includes("乡村基（重庆）投资有限公司"),
    );
    assert.notEqual(companyRef, undefined);
    if (companyRef === undefined) {
      throw new Error("Expected iframe dropdown company ref to be emitted");
    }

    assert.equal(companyRef.role, "clickable");
    assert.equal(companyRef.frameId, "payment-frame");
    assert.equal(companyRef.backendNodeId, 87);
    assert.equal(
      snapshotResult.snapshot.nodes.some(
        (node) =>
          node.ref === companyRef.ref &&
          node.frameId === "payment-frame" &&
          node.properties?.["domActionable"] === true &&
          node.properties?.["domActionHints"] === "class:action",
      ),
      true,
    );
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
