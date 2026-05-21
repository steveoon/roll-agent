import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserSecurityConfigSchema } from "../types/index.ts";
import type { BrowserSecurityConfig } from "../types/index.ts";
import { BrowserActionPolicyError } from "./security.ts";
import { NativeCdpController } from "./native-cdp-controller.ts";
import type { NativeCdpWebSocketLike } from "./native-cdp-controller.ts";

type ListenerMap = {
  readonly open: Set<() => void>;
  readonly message: Set<(event: Event & { readonly data?: unknown }) => void>;
  readonly error: Set<(event: Event) => void>;
  readonly close: Set<() => void>;
};

type SentCommand = {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
};

function isSentCommand(value: unknown): value is SentCommand {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "number" && typeof candidate["method"] === "string";
}

class FakeNativeCdpWebSocket implements NativeCdpWebSocketLike {
  readyState: number = WebSocket.OPEN;
  private closed = false;
  private readonly listeners: ListenerMap = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };
  private readonly sentCommands: SentCommand[] = [];

  send(data: string): void {
    const parsed: unknown = JSON.parse(data);
    if (!isSentCommand(parsed)) {
      throw new Error("Expected a JSON-RPC command.");
    }
    this.sentCommands.push(parsed);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    for (const listener of this.listeners.close) {
      listener();
    }
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: Event & { readonly data?: unknown }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(
    type: keyof ListenerMap,
    listener:
      | (() => void)
      | ((event: Event) => void)
      | ((event: Event & { readonly data?: unknown }) => void),
  ): void {
    switch (type) {
      case "open":
        this.listeners.open.add(listener as () => void);
        break;
      case "message":
        this.listeners.message.add(
          listener as (event: Event & { readonly data?: unknown }) => void,
        );
        break;
      case "error":
        this.listeners.error.add(listener as (event: Event) => void);
        break;
      case "close":
        this.listeners.close.add(listener as () => void);
        break;
    }
  }

  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: Event & { readonly data?: unknown }) => void,
  ): void;
  removeEventListener(type: "error", listener: (event: Event) => void): void;
  removeEventListener(type: "close", listener: () => void): void;
  removeEventListener(
    type: keyof ListenerMap,
    listener:
      | (() => void)
      | ((event: Event) => void)
      | ((event: Event & { readonly data?: unknown }) => void),
  ): void {
    switch (type) {
      case "open":
        this.listeners.open.delete(listener as () => void);
        break;
      case "message":
        this.listeners.message.delete(
          listener as (event: Event & { readonly data?: unknown }) => void,
        );
        break;
      case "error":
        this.listeners.error.delete(listener as (event: Event) => void);
        break;
      case "close":
        this.listeners.close.delete(listener as () => void);
        break;
    }
  }

  takeSentCommand(): SentCommand {
    const command = this.sentCommands.shift();
    if (!command) {
      throw new Error("Expected a sent command.");
    }
    return command;
  }

  getSentMethods(): readonly string[] {
    return this.sentCommands.map((command) => command.method);
  }

  respond(id: number, result: unknown): void {
    const data = JSON.stringify({
      id,
      result,
    });
    for (const listener of this.listeners.message) {
      listener(new MessageEvent("message", { data }));
    }
  }

  reject(id: number, message: string): void {
    const data = JSON.stringify({
      id,
      error: {
        code: -32_000,
        message,
      },
    });
    for (const listener of this.listeners.message) {
      listener(new MessageEvent("message", { data }));
    }
  }
}

async function createController(
  socket: FakeNativeCdpWebSocket,
  options: {
    readonly commandTimeoutMs?: number;
    readonly allowUnsafeRuntimeEnableForDiagnostics?: boolean;
    readonly security?: BrowserSecurityConfig;
  } = {},
): Promise<NativeCdpController> {
  return await NativeCdpController.connect({
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target",
    createWebSocket: () => socket,
    ...options,
  });
}

test("evaluateJson sends Runtime.evaluate without Runtime.enable and disables previews", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket);

  const valuePromise = controller.evaluateJson<string>("location.href");
  const command = socket.takeSentCommand();

  assert.equal(command.method, "Runtime.evaluate");
  assert.deepEqual(command.params, {
    expression: "location.href",
    returnByValue: true,
    generatePreview: false,
    awaitPromise: false,
  });

  socket.respond(command.id, {
    result: {
      type: "string",
      value: "https://www.zhipin.com/web/chat/index",
    },
  });

  assert.equal(await valuePromise, "https://www.zhipin.com/web/chat/index");
  assert.deepEqual(socket.getSentMethods(), []);
  controller.close();
});

test("evaluateJson can target a frame execution context without enabling Runtime", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket);

  const valuePromise = controller.evaluateJson<number>("document.querySelectorAll('*').length", {
    contextId: 42,
  });
  const command = socket.takeSentCommand();

  assert.equal(command.method, "Runtime.evaluate");
  assert.deepEqual(command.params, {
    expression: "document.querySelectorAll('*').length",
    returnByValue: true,
    generatePreview: false,
    awaitPromise: false,
    contextId: 42,
  });

  socket.respond(command.id, {
    result: {
      type: "number",
      value: 128,
    },
  });

  assert.equal(await valuePromise, 128);
  assert.deepEqual(socket.getSentMethods(), []);
  controller.close();
});

test("normal allowlist methods do not send Runtime.enable", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket);

  const documentPromise = controller.getDocument({ depth: 1, pierce: false });
  const documentCommand = socket.takeSentCommand();
  socket.respond(documentCommand.id, { root: { nodeName: "#document" } });

  const frontPromise = controller.bringToFront();
  const frontCommand = socket.takeSentCommand();
  socket.respond(frontCommand.id, {});

  const windowStatePromise = controller.getWindowStateForTarget("target-boss");
  const windowStateCommand = socket.takeSentCommand();
  socket.respond(windowStateCommand.id, {
    windowId: 1,
    bounds: {
      windowState: "minimized",
    },
  });

  const navigatePromise = controller.navigate("https://www.zhipin.com");
  const navigateCommand = socket.takeSentCommand();
  socket.respond(navigateCommand.id, {
    frameId: "main-frame",
    loaderId: "loader-1",
  });

  const frameTreePromise = controller.getFrameTree();
  const frameTreeCommand = socket.takeSentCommand();
  socket.respond(frameTreeCommand.id, {
    frameTree: {
      frame: {
        id: "main-frame",
        url: "https://www.zhipin.com/web/chat/recommend",
      },
    },
  });

  const worldPromise = controller.createIsolatedWorld("frame-recommend");
  const worldCommand = socket.takeSentCommand();
  socket.respond(worldCommand.id, { executionContextId: 99 });

  const mousePromise = controller.dispatchMouseEvent({
    type: "mouseWheel",
    x: 12,
    y: 34,
    buttons: 0,
    deltaY: 480,
  });
  const mouseCommand = socket.takeSentCommand();
  socket.respond(mouseCommand.id, {});

  const keyPromise = controller.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 4,
  });
  const keyCommand = socket.takeSentCommand();
  socket.respond(keyCommand.id, {});

  const insertPromise = controller.insertText("hello");
  const insertCommand = socket.takeSentCommand();
  socket.respond(insertCommand.id, {});

  await documentPromise;
  await frontPromise;
  assert.equal(await windowStatePromise, "minimized");
  assert.deepEqual(await navigatePromise, {
    frameId: "main-frame",
    loaderId: "loader-1",
  });
  assert.equal((await frameTreePromise).frame.id, "main-frame");
  assert.equal(await worldPromise, 99);
  await mousePromise;
  await keyPromise;
  await insertPromise;

  assert.equal(documentCommand.method, "DOM.getDocument");
  assert.equal(frontCommand.method, "Page.bringToFront");
  assert.equal(windowStateCommand.method, "Browser.getWindowForTarget");
  assert.deepEqual(windowStateCommand.params, { targetId: "target-boss" });
  assert.equal(navigateCommand.method, "Page.navigate");
  assert.deepEqual(navigateCommand.params, { url: "https://www.zhipin.com" });
  assert.equal(frameTreeCommand.method, "Page.getFrameTree");
  assert.equal(worldCommand.method, "Page.createIsolatedWorld");
  assert.deepEqual(worldCommand.params, { frameId: "frame-recommend" });
  assert.equal(mouseCommand.method, "Input.dispatchMouseEvent");
  assert.equal((mouseCommand.params as Record<string, unknown>)["buttons"], 0);
  assert.equal((mouseCommand.params as Record<string, unknown>)["deltaY"], 480);
  assert.equal(keyCommand.method, "Input.dispatchKeyEvent");
  assert.equal((keyCommand.params as Record<string, unknown>)["key"], "a");
  assert.equal((keyCommand.params as Record<string, unknown>)["modifiers"], 4);
  assert.equal(insertCommand.method, "Input.insertText");
  assert.deepEqual(insertCommand.params, { text: "hello" });
  assert.notEqual(documentCommand.method, "Runtime.enable");
  assert.notEqual(frontCommand.method, "Runtime.enable");
  assert.notEqual(windowStateCommand.method, "Runtime.enable");
  assert.notEqual(navigateCommand.method, "Runtime.enable");
  assert.notEqual(frameTreeCommand.method, "Runtime.enable");
  assert.notEqual(worldCommand.method, "Runtime.enable");
  assert.notEqual(mouseCommand.method, "Runtime.enable");
  assert.notEqual(keyCommand.method, "Runtime.enable");
  assert.notEqual(insertCommand.method, "Runtime.enable");
  controller.close();
});

test("navigate rejects native Page.navigate errorText", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket);

  const pending = controller.navigate("https://www.zhipin.com");
  const command = socket.takeSentCommand();
  assert.equal(command.method, "Page.navigate");
  socket.respond(command.id, {
    frameId: "main-frame",
    errorText: "net::ERR_ABORTED",
  });

  await assert.rejects(pending, /net::ERR_ABORTED/);
  controller.close();
});

test("accessibility tree and backend node helpers use allowlisted CDP commands", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket);

  const axPromise = controller.getFullAccessibilityTree({ depth: 3 });
  const axCommand = socket.takeSentCommand();
  assert.equal(axCommand.method, "Accessibility.getFullAXTree");
  assert.deepEqual(axCommand.params, { depth: 3 });
  socket.respond(axCommand.id, {
    nodes: [
      {
        nodeId: "1",
        role: { value: "RootWebArea" },
      },
    ],
  });

  const scrollPromise = controller.scrollIntoViewByBackendNodeId({ backendNodeId: 123 });
  const scrollCommand = socket.takeSentCommand();
  assert.equal(scrollCommand.method, "DOM.scrollIntoViewIfNeeded");
  assert.deepEqual(scrollCommand.params, { backendNodeId: 123 });
  socket.respond(scrollCommand.id, {});

  const boxPromise = controller.getBoxModelByBackendNodeId({ backendNodeId: 123 });
  const boxCommand = socket.takeSentCommand();
  assert.equal(boxCommand.method, "DOM.getBoxModel");
  assert.deepEqual(boxCommand.params, { backendNodeId: 123 });
  socket.respond(boxCommand.id, {
    model: {
      border: [0, 0, 10, 0, 10, 20, 0, 20],
      width: 10,
      height: 20,
    },
  });

  const queryPromise = controller.querySelectorAllByNodeId({
    nodeId: 1,
    selector: "[data-roll-browser-action-candidate]",
  });
  const queryCommand = socket.takeSentCommand();
  assert.equal(queryCommand.method, "DOM.querySelectorAll");
  assert.deepEqual(queryCommand.params, {
    nodeId: 1,
    selector: "[data-roll-browser-action-candidate]",
  });
  socket.respond(queryCommand.id, { nodeIds: [7, 8] });

  const describePromise = controller.describeNode({ nodeId: 7 });
  const describeCommand = socket.takeSentCommand();
  assert.equal(describeCommand.method, "DOM.describeNode");
  assert.deepEqual(describeCommand.params, { nodeId: 7 });
  socket.respond(describeCommand.id, {
    node: {
      nodeId: 7,
      backendNodeId: 44,
      nodeName: "IFRAME",
      frameId: "iframe-node-frame",
      contentDocument: {
        frameId: "iframe-content-frame",
      },
      attributes: ["data-roll-browser-action-candidate", "0"],
    },
  });

  assert.equal((await axPromise).length, 1);
  await scrollPromise;
  assert.deepEqual(await boxPromise, {
    border: [0, 0, 10, 0, 10, 20, 0, 20],
    width: 10,
    height: 20,
  });
  assert.deepEqual(await queryPromise, [7, 8]);
  assert.deepEqual(await describePromise, {
    nodeId: 7,
    backendNodeId: 44,
    nodeName: "IFRAME",
    frameId: "iframe-node-frame",
    contentDocumentFrameId: "iframe-content-frame",
    attributes: ["data-roll-browser-action-candidate", "0"],
  });
  controller.close();
});

test("native locator resolves and clicks through Runtime.evaluate plus Input.dispatchMouseEvent", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket);
  const resolvedTargets: unknown[] = [];

  const clickPromise = controller.locator("a.primary").click({
    settleMs: 0,
    onTargetResolved: async (target) => {
      resolvedTargets.push(target);
    },
  });

  const resolveCommand = socket.takeSentCommand();
  assert.equal(resolveCommand.method, "Runtime.evaluate");
  assert.match(
    (resolveCommand.params as Record<string, unknown>)["expression"] as string,
    /querySelectorAll\(selector\)/,
  );
  socket.respond(resolveCommand.id, {
    result: {
      type: "object",
      value: {
        found: true,
        selector: "a.primary",
        index: 0,
        x: 42,
        y: 64,
        tagName: "a",
        text: "推荐牛人",
        role: "link",
        href: "https://www.zhipin.com/web/chat/recommend",
        visible: true,
        disabled: false,
        rect: {
          x: 12,
          y: 32,
          width: 60,
          height: 64,
          left: 12,
          top: 32,
          right: 72,
          bottom: 96,
        },
        hitTagName: "a",
        hitText: "推荐牛人",
      },
    },
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  const moveCommand = socket.takeSentCommand();
  socket.respond(moveCommand.id, {});
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const pressCommand = socket.takeSentCommand();
  socket.respond(pressCommand.id, {});
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const releaseCommand = socket.takeSentCommand();
  socket.respond(releaseCommand.id, {});

  const result = await clickPromise;

  assert.equal(result.success, true);
  assert.equal(result.target?.href, "https://www.zhipin.com/web/chat/recommend");
  assert.equal(resolvedTargets.length, 1);
  assert.deepEqual(
    [moveCommand, pressCommand, releaseCommand].map((command) => command.method),
    ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"],
  );
  assert.deepEqual(
    [moveCommand, pressCommand, releaseCommand].map((command) => command.params),
    [
      { type: "mouseMoved", x: 42, y: 64, button: "none", buttons: 0, clickCount: 0 },
      { type: "mousePressed", x: 42, y: 64, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", x: 42, y: 64, button: "left", buttons: 0, clickCount: 1 },
    ],
  );
  controller.close();
});

test("security policy blocks native CDP actions before commands are sent", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket, {
    security: BrowserSecurityConfigSchema.parse({ actionPolicy: "confirm" }),
  });

  await assert.rejects(controller.navigate("https://www.zhipin.com"), (error) => {
    assert.ok(error instanceof BrowserActionPolicyError);
    assert.equal(error.payload.code, "needs_confirmation");
    return true;
  });
  await assert.rejects(
    controller.locator("button.primary").click({ settleMs: 0 }),
    BrowserActionPolicyError,
  );
  await assert.rejects(controller.insertText("hello"), BrowserActionPolicyError);
  assert.deepEqual(socket.getSentMethods(), []);
  controller.close();
});

test("command timeout rejects pending command", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket, { commandTimeoutMs: 5 });

  await assert.rejects(controller.bringToFront(), /timed out/);
  controller.close();
});

test("close rejects pending command", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket, { commandTimeoutMs: 1_000 });

  const pending = controller.getDocument();
  socket.takeSentCommand();
  controller.close();

  await assert.rejects(pending, /closed/);
});

test("CDP error response rejects pending command", async () => {
  const socket = new FakeNativeCdpWebSocket();
  const controller = await createController(socket);

  const pending = controller.bringToFront();
  const command = socket.takeSentCommand();
  socket.reject(command.id, "target closed");

  await assert.rejects(pending, /target closed/);
  controller.close();
});

test("Runtime.enable is blocked unless explicitly enabled for diagnostics", async () => {
  const blockedSocket = new FakeNativeCdpWebSocket();
  const blockedController = await createController(blockedSocket);

  await assert.rejects(
    blockedController.unsafeEnableRuntimeForDiagnostics(),
    /blocked outside explicit native CDP diagnostics/,
  );
  blockedController.close();

  const unsafeSocket = new FakeNativeCdpWebSocket();
  const unsafeController = await createController(unsafeSocket, {
    allowUnsafeRuntimeEnableForDiagnostics: true,
  });

  const pending = unsafeController.unsafeEnableRuntimeForDiagnostics();
  const command = unsafeSocket.takeSentCommand();
  assert.equal(command.method, "Runtime.enable");
  unsafeSocket.respond(command.id, {});
  await pending;
  unsafeController.close();
});
