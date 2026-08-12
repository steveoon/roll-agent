import { NativeCdpLocator } from "./native-cdp-locator.ts";
import type { NativeCdpLocatorOptions } from "./native-cdp-locator.ts";
import { assertBrowserActionPreflight } from "./security.ts";
import type { BrowserActionLogHandler } from "./security.ts";
import type { BrowserSecurityConfig } from "../types/index.ts";

const DEFAULT_NATIVE_CDP_COMMAND_TIMEOUT_MS = 5_000;

const NORMAL_NATIVE_CDP_METHODS = [
  "Accessibility.getFullAXTree",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "Runtime.evaluate",
  "DOM.getDocument",
  "DOM.querySelectorAll",
  "DOM.scrollIntoViewIfNeeded",
  "Browser.getWindowForTarget",
  "Browser.setWindowBounds",
  "Page.bringToFront",
  "Page.navigate",
  "Page.reload",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Page.captureScreenshot",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
] as const;

const UNSAFE_DIAGNOSTIC_NATIVE_CDP_METHODS = ["Runtime.enable"] as const;

type NormalNativeCdpMethod = (typeof NORMAL_NATIVE_CDP_METHODS)[number];
type UnsafeDiagnosticNativeCdpMethod = (typeof UNSAFE_DIAGNOSTIC_NATIVE_CDP_METHODS)[number];

type NativeCdpCommandMethod = NormalNativeCdpMethod | UnsafeDiagnosticNativeCdpMethod;

type NativeCdpPendingCommand = {
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

type NativeCdpWebSocketMessageEvent = Event & {
  readonly data?: unknown;
};

export type NativeCdpWebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: NativeCdpWebSocketMessageEvent) => void,
  ): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: NativeCdpWebSocketMessageEvent) => void,
  ): void;
  removeEventListener(type: "error", listener: (event: Event) => void): void;
  removeEventListener(type: "close", listener: () => void): void;
};

export type NativeCdpControllerOptions = {
  readonly webSocketDebuggerUrl: string;
  readonly commandTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly createWebSocket?: (url: string) => NativeCdpWebSocketLike;
  readonly allowUnsafeRuntimeEnableForDiagnostics?: boolean;
  readonly security?: BrowserSecurityConfig;
  readonly onActionLog?: BrowserActionLogHandler;
};

export type NativeCdpEvaluateOptions = {
  readonly timeoutMs?: number;
  readonly contextId?: number;
};

export type NativeCdpGetDocumentOptions = {
  readonly depth?: number;
  readonly pierce?: boolean;
  readonly timeoutMs?: number;
};

export type NativeCdpQuerySelectorAllOptions = {
  readonly nodeId: number;
  readonly selector: string;
  readonly timeoutMs?: number;
};

export type NativeCdpDescribeNodeOptions = {
  readonly nodeId?: number;
  readonly backendNodeId?: number;
  readonly objectId?: string;
  readonly depth?: number;
  readonly pierce?: boolean;
  readonly timeoutMs?: number;
};

export type NativeCdpGetFullAxTreeOptions = {
  readonly depth?: number;
  readonly frameId?: string;
  readonly timeoutMs?: number;
};

export type NativeCdpScrollIntoViewOptions = {
  readonly backendNodeId: number;
  readonly timeoutMs?: number;
};

export type NativeCdpGetBoxModelOptions = {
  readonly backendNodeId: number;
  readonly timeoutMs?: number;
};

export type NativeCdpBoxModel = {
  readonly content?: readonly number[];
  readonly padding?: readonly number[];
  readonly border?: readonly number[];
  readonly margin?: readonly number[];
  readonly width?: number;
  readonly height?: number;
};

export type NativeCdpDomNode = {
  readonly nodeId?: number;
  readonly backendNodeId?: number;
  readonly nodeName?: string;
  readonly frameId?: string;
  readonly contentDocumentFrameId?: string;
  readonly attributes?: readonly string[];
};

export type NativeCdpMouseEventInput = {
  readonly type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
  readonly x: number;
  readonly y: number;
  readonly button?: "none" | "left" | "right" | "middle" | "back" | "forward";
  readonly buttons?: number;
  readonly clickCount?: number;
  readonly modifiers?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
};

export type NativeCdpKeyEventInput = {
  readonly type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  readonly key?: string;
  readonly code?: string;
  readonly text?: string;
  readonly unmodifiedText?: string;
  readonly windowsVirtualKeyCode?: number;
  readonly nativeVirtualKeyCode?: number;
  readonly modifiers?: number;
};

export type NativeCdpFrame = {
  readonly id: string;
  readonly parentId?: string;
  readonly name?: string;
  readonly url: string;
};

export type NativeCdpFrameTree = {
  readonly frame: NativeCdpFrame;
  readonly childFrames?: readonly NativeCdpFrameTree[];
};

export type NativeCdpNavigateResult = {
  readonly frameId?: string;
  readonly loaderId?: string;
  readonly errorText?: string;
};

export const NATIVE_CDP_WINDOW_STATES = [
  "normal",
  "minimized",
  "maximized",
  "fullscreen",
  "unknown",
] as const;
export type NativeCdpWindowState = (typeof NATIVE_CDP_WINDOW_STATES)[number];
export type NativeCdpSettableWindowState = Exclude<NativeCdpWindowState, "unknown">;

export type NativeCdpWindowBounds = {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly state?: NativeCdpSettableWindowState;
};

type NativeCdpProtocolWindowBounds = {
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly height?: number;
  readonly windowState?: NativeCdpSettableWindowState;
};

export type NativeCdpCreateIsolatedWorldOptions = {
  readonly worldName?: string;
  readonly grantUniversalAccess?: boolean;
  readonly timeoutMs?: number;
};

export type NativeCdpScreenshotClip = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale?: number;
};

export type NativeCdpCaptureScreenshotOptions = {
  readonly format?: "png" | "jpeg";
  readonly quality?: number;
  readonly clip?: NativeCdpScreenshotClip;
  readonly captureBeyondViewport?: boolean;
  readonly timeoutMs?: number;
};

type NativeCdpSuccessResponse = {
  readonly id: number;
  readonly result?: unknown;
};

type NativeCdpErrorResponse = {
  readonly id: number;
  readonly error: {
    readonly code?: number;
    readonly message?: string;
  };
};

type NativeRuntimeEvaluateResponse = {
  readonly result?: {
    readonly value?: unknown;
  };
  readonly exceptionDetails?: unknown;
};

function createDefaultWebSocket(url: string): NativeCdpWebSocketLike {
  if (globalThis.WebSocket === undefined) {
    throw new Error("Native CDP requires a WebSocket implementation.");
  }
  return new globalThis.WebSocket(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNativeCdpErrorResponse(value: unknown): value is NativeCdpErrorResponse {
  if (!isRecord(value)) {
    return false;
  }

  const id = value["id"];
  const error = value["error"];
  return typeof id === "number" && isRecord(error);
}

function isNativeCdpSuccessResponse(value: unknown): value is NativeCdpSuccessResponse {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["id"] === "number" && !isRecord(value["error"]);
}

function readWebSocketTextData(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  return undefined;
}

function createCdpResponseError(error: NativeCdpErrorResponse["error"]): Error {
  const message =
    typeof error.message === "string" && error.message.length > 0
      ? error.message
      : "Native CDP command failed.";
  const code = typeof error.code === "number" ? ` (${error.code})` : "";
  return new Error(`${message}${code}`);
}

function assertNormalMethod(
  method: NativeCdpCommandMethod,
): asserts method is NormalNativeCdpMethod {
  if (!NORMAL_NATIVE_CDP_METHODS.includes(method as NormalNativeCdpMethod)) {
    throw new Error(`Native CDP command "${method}" is not allowed by NativeCdpController.`);
  }
}

function assertUnsafeDiagnosticMethod(
  method: NativeCdpCommandMethod,
): asserts method is UnsafeDiagnosticNativeCdpMethod {
  if (!UNSAFE_DIAGNOSTIC_NATIVE_CDP_METHODS.includes(method as UnsafeDiagnosticNativeCdpMethod)) {
    throw new Error(`Native CDP diagnostic command "${method}" is not allowed.`);
  }
}

function toRuntimeEvaluateResponse(value: unknown): NativeRuntimeEvaluateResponse {
  if (!isRecord(value)) {
    return {};
  }

  const result = value["result"];
  const exceptionDetails = value["exceptionDetails"];
  return {
    ...(isRecord(result) ? { result } : {}),
    ...(exceptionDetails !== undefined ? { exceptionDetails } : {}),
  };
}

function toNativeCdpFrame(value: unknown): NativeCdpFrame | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value["id"];
  const parentId = value["parentId"];
  const name = value["name"];
  const url = value["url"];
  if (typeof id !== "string" || typeof url !== "string") {
    return undefined;
  }

  return {
    id,
    ...(typeof parentId === "string" ? { parentId } : {}),
    ...(typeof name === "string" ? { name } : {}),
    url,
  };
}

function toNativeCdpFrameTree(value: unknown): NativeCdpFrameTree | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const frame = toNativeCdpFrame(value["frame"]);
  if (frame === undefined) {
    return undefined;
  }

  const childFrames = value["childFrames"];
  const parsedChildren = Array.isArray(childFrames)
    ? childFrames.flatMap((child) => {
        const tree = toNativeCdpFrameTree(child);
        return tree === undefined ? [] : [tree];
      })
    : undefined;

  return {
    frame,
    ...(parsedChildren !== undefined ? { childFrames: parsedChildren } : {}),
  };
}

function readFrameTreeResponse(value: unknown): NativeCdpFrameTree {
  if (!isRecord(value)) {
    throw new Error("Native CDP Page.getFrameTree returned an unexpected response.");
  }

  const frameTree = toNativeCdpFrameTree(value["frameTree"]);
  if (frameTree === undefined) {
    throw new Error("Native CDP Page.getFrameTree did not return a valid frameTree.");
  }

  return frameTree;
}

function readCaptureScreenshotResponse(value: unknown): string {
  if (!isRecord(value)) {
    throw new Error("Native CDP Page.captureScreenshot returned an unexpected response.");
  }

  const data = value["data"];
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("Native CDP Page.captureScreenshot did not return image data.");
  }
  return data;
}

function readNavigateResponse(value: unknown): NativeCdpNavigateResult {
  if (!isRecord(value)) {
    return {};
  }

  const frameId = value["frameId"];
  const loaderId = value["loaderId"];
  const errorText = value["errorText"];

  return {
    ...(typeof frameId === "string" ? { frameId } : {}),
    ...(typeof loaderId === "string" ? { loaderId } : {}),
    ...(typeof errorText === "string" ? { errorText } : {}),
  };
}

function readWindowStateForTargetResponse(value: unknown): NativeCdpWindowState {
  if (!isRecord(value) || !isRecord(value["bounds"])) {
    return "unknown";
  }

  const windowState = value["bounds"]["windowState"];
  return NATIVE_CDP_WINDOW_STATES.includes(windowState as NativeCdpWindowState)
    ? (windowState as NativeCdpWindowState)
    : "unknown";
}

function readWindowIdForTargetResponse(value: unknown): number {
  if (!isRecord(value)) {
    throw new Error("Native CDP Browser.getWindowForTarget returned an unexpected response.");
  }

  const windowId = value["windowId"];
  if (typeof windowId !== "number" || !Number.isInteger(windowId)) {
    throw new Error("Native CDP Browser.getWindowForTarget did not return windowId.");
  }
  return windowId;
}

function toProtocolWindowBounds(bounds: NativeCdpWindowBounds): NativeCdpProtocolWindowBounds {
  return {
    ...(bounds.x !== undefined ? { left: bounds.x } : {}),
    ...(bounds.y !== undefined ? { top: bounds.y } : {}),
    ...(bounds.width !== undefined ? { width: bounds.width } : {}),
    ...(bounds.height !== undefined ? { height: bounds.height } : {}),
    ...(bounds.state !== undefined ? { windowState: bounds.state } : {}),
  };
}

function readNumberArray(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    return undefined;
  }
  return value;
}

function readNumberList(value: unknown): readonly number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is number => typeof item === "number");
}

function readStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value;
}

function readDomNode(value: unknown): NativeCdpDomNode | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nodeId = value["nodeId"];
  const backendNodeId = value["backendNodeId"];
  const nodeName = value["nodeName"];
  const frameId = value["frameId"];
  const contentDocument = value["contentDocument"];
  const contentDocumentFrameId = isRecord(contentDocument) ? contentDocument["frameId"] : undefined;
  const attributes = readStringList(value["attributes"]);
  return {
    ...(typeof nodeId === "number" && Number.isInteger(nodeId) ? { nodeId } : {}),
    ...(typeof backendNodeId === "number" && Number.isInteger(backendNodeId)
      ? { backendNodeId }
      : {}),
    ...(typeof nodeName === "string" ? { nodeName } : {}),
    ...(typeof frameId === "string" ? { frameId } : {}),
    ...(typeof contentDocumentFrameId === "string" ? { contentDocumentFrameId } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
  };
}

function readDescribeNodeResponse(value: unknown): NativeCdpDomNode {
  if (!isRecord(value)) {
    throw new Error("Native CDP DOM.describeNode returned an unexpected response.");
  }

  const node = readDomNode(value["node"]);
  if (node === undefined) {
    throw new Error("Native CDP DOM.describeNode did not return a valid node.");
  }
  return node;
}

function readBoxModelResponse(value: unknown): NativeCdpBoxModel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const model = value["model"];
  if (!isRecord(model)) {
    return undefined;
  }

  const content = readNumberArray(model["content"]);
  const padding = readNumberArray(model["padding"]);
  const border = readNumberArray(model["border"]);
  const margin = readNumberArray(model["margin"]);
  const width = model["width"];
  const height = model["height"];

  return {
    ...(content !== undefined ? { content } : {}),
    ...(padding !== undefined ? { padding } : {}),
    ...(border !== undefined ? { border } : {}),
    ...(margin !== undefined ? { margin } : {}),
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
  };
}

function readExecutionContextId(value: unknown): number {
  if (!isRecord(value)) {
    throw new Error("Native CDP Page.createIsolatedWorld returned an unexpected response.");
  }

  const executionContextId = value["executionContextId"];
  if (typeof executionContextId !== "number" || !Number.isInteger(executionContextId)) {
    throw new Error("Native CDP Page.createIsolatedWorld did not return executionContextId.");
  }

  return executionContextId;
}

export class NativeCdpController {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, NativeCdpPendingCommand>();
  private readonly webSocket: NativeCdpWebSocketLike;
  private readonly commandTimeoutMs: number;
  private readonly allowUnsafeRuntimeEnableForDiagnostics: boolean;
  private readonly security: BrowserSecurityConfig | undefined;
  private readonly onActionLog: BrowserActionLogHandler | undefined;

  private constructor(webSocket: NativeCdpWebSocketLike, options: NativeCdpControllerOptions) {
    this.webSocket = webSocket;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_NATIVE_CDP_COMMAND_TIMEOUT_MS;
    this.allowUnsafeRuntimeEnableForDiagnostics =
      options.allowUnsafeRuntimeEnableForDiagnostics ?? false;
    this.security = options.security;
    this.onActionLog = options.onActionLog;

    this.webSocket.addEventListener("message", this.handleMessage);
    this.webSocket.addEventListener("error", this.handleError);
    this.webSocket.addEventListener("close", this.handleClose);
  }

  static async connect(options: NativeCdpControllerOptions): Promise<NativeCdpController> {
    const webSocket = (options.createWebSocket ?? createDefaultWebSocket)(
      options.webSocketDebuggerUrl,
    );
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_NATIVE_CDP_COMMAND_TIMEOUT_MS;

    if (webSocket.readyState === WebSocket.OPEN) {
      return new NativeCdpController(webSocket, options);
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        try {
          webSocket.close();
        } catch {
          // Ignore close failures while surfacing the original timeout.
        }
        reject(new Error(`Native CDP WebSocket did not open within ${connectTimeoutMs}ms.`));
      }, connectTimeoutMs);

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error("Native CDP WebSocket failed to open."));
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Native CDP WebSocket closed before opening."));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        webSocket.removeEventListener("open", onOpen);
        webSocket.removeEventListener("error", onError);
        webSocket.removeEventListener("close", onClose);
      };

      webSocket.addEventListener("open", onOpen);
      webSocket.addEventListener("error", onError);
      webSocket.addEventListener("close", onClose);
    });

    return new NativeCdpController(webSocket, options);
  }

  async evaluateJson<T = unknown>(
    expression: string,
    options: NativeCdpEvaluateOptions = {},
  ): Promise<T> {
    const response = toRuntimeEvaluateResponse(
      await this.sendNormal(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          generatePreview: false,
          awaitPromise: false,
          ...(options.contextId !== undefined ? { contextId: options.contextId } : {}),
        },
        options.timeoutMs,
      ),
    );

    if (response.exceptionDetails !== undefined) {
      throw new Error("Native CDP Runtime.evaluate failed with exceptionDetails.");
    }

    return response.result?.value as T;
  }

  async getDocument(options: NativeCdpGetDocumentOptions = {}): Promise<unknown> {
    return await this.sendNormal(
      "DOM.getDocument",
      {
        depth: options.depth ?? 1,
        pierce: options.pierce ?? false,
      },
      options.timeoutMs,
    );
  }

  async querySelectorAllByNodeId(
    options: NativeCdpQuerySelectorAllOptions,
  ): Promise<readonly number[]> {
    const response = await this.sendNormal(
      "DOM.querySelectorAll",
      {
        nodeId: options.nodeId,
        selector: options.selector,
      },
      options.timeoutMs,
    );

    if (!isRecord(response)) {
      return [];
    }
    return readNumberList(response["nodeIds"]);
  }

  async describeNode(options: NativeCdpDescribeNodeOptions): Promise<NativeCdpDomNode> {
    return readDescribeNodeResponse(
      await this.sendNormal(
        "DOM.describeNode",
        {
          ...(options.nodeId !== undefined ? { nodeId: options.nodeId } : {}),
          ...(options.backendNodeId !== undefined ? { backendNodeId: options.backendNodeId } : {}),
          ...(options.objectId !== undefined ? { objectId: options.objectId } : {}),
          ...(options.depth !== undefined ? { depth: options.depth } : {}),
          ...(options.pierce !== undefined ? { pierce: options.pierce } : {}),
        },
        options.timeoutMs,
      ),
    );
  }

  async getFullAccessibilityTree(
    options: NativeCdpGetFullAxTreeOptions = {},
  ): Promise<readonly unknown[]> {
    const response = await this.sendNormal(
      "Accessibility.getFullAXTree",
      {
        ...(options.depth !== undefined ? { depth: options.depth } : {}),
        ...(options.frameId !== undefined ? { frameId: options.frameId } : {}),
      },
      options.timeoutMs,
    );

    if (!isRecord(response) || !Array.isArray(response["nodes"])) {
      throw new Error("Native CDP Accessibility.getFullAXTree returned an unexpected response.");
    }

    return response["nodes"];
  }

  async scrollIntoViewByBackendNodeId(options: NativeCdpScrollIntoViewOptions): Promise<void> {
    await this.sendNormal(
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId: options.backendNodeId },
      options.timeoutMs,
    );
  }

  async getBoxModelByBackendNodeId(
    options: NativeCdpGetBoxModelOptions,
  ): Promise<NativeCdpBoxModel | undefined> {
    return readBoxModelResponse(
      await this.sendNormal(
        "DOM.getBoxModel",
        { backendNodeId: options.backendNodeId },
        options.timeoutMs,
      ),
    );
  }

  async bringToFront(): Promise<void> {
    await this.sendNormal("Page.bringToFront", {});
  }

  async getWindowStateForTarget(
    targetId: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<NativeCdpWindowState> {
    return readWindowStateForTargetResponse(
      await this.sendNormal(
        "Browser.getWindowForTarget",
        {
          targetId,
        },
        options.timeoutMs,
      ),
    );
  }

  async getWindowIdForTarget(
    targetId: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<number> {
    return readWindowIdForTargetResponse(
      await this.sendNormal(
        "Browser.getWindowForTarget",
        {
          targetId,
        },
        options.timeoutMs,
      ),
    );
  }

  async setWindowBounds(
    windowId: number,
    bounds: NativeCdpWindowBounds,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<void> {
    await this.sendNormal(
      "Browser.setWindowBounds",
      {
        windowId,
        bounds: toProtocolWindowBounds(bounds),
      },
      options.timeoutMs,
    );
  }

  async navigate(
    url: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<NativeCdpNavigateResult> {
    this.preflightAction({ action: "navigate", target: url, url });
    const result = readNavigateResponse(
      await this.sendNormal("Page.navigate", { url }, options.timeoutMs),
    );
    if (result.errorText !== undefined) {
      throw new Error(`Native CDP Page.navigate failed: ${result.errorText}`);
    }
    return result;
  }

  async reload(
    options: {
      readonly url?: string;
      readonly ignoreCache?: boolean;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<void> {
    this.preflightAction({
      action: "navigate",
      target: options.url ?? "reload",
      ...(options.url !== undefined ? { url: options.url } : {}),
    });
    await this.sendNormal(
      "Page.reload",
      { ignoreCache: options.ignoreCache ?? false },
      options.timeoutMs,
    );
  }

  async getFrameTree(options: { readonly timeoutMs?: number } = {}): Promise<NativeCdpFrameTree> {
    return readFrameTreeResponse(await this.sendNormal("Page.getFrameTree", {}, options.timeoutMs));
  }

  async captureScreenshot(options: NativeCdpCaptureScreenshotOptions = {}): Promise<string> {
    return readCaptureScreenshotResponse(
      await this.sendNormal(
        "Page.captureScreenshot",
        {
          format: options.format ?? "png",
          ...(options.quality !== undefined ? { quality: options.quality } : {}),
          ...(options.clip !== undefined
            ? {
                clip: {
                  x: options.clip.x,
                  y: options.clip.y,
                  width: options.clip.width,
                  height: options.clip.height,
                  scale: options.clip.scale ?? 1,
                },
              }
            : {}),
          ...(options.captureBeyondViewport !== undefined
            ? { captureBeyondViewport: options.captureBeyondViewport }
            : {}),
        },
        options.timeoutMs,
      ),
    );
  }

  async createIsolatedWorld(
    frameId: string,
    options: NativeCdpCreateIsolatedWorldOptions = {},
  ): Promise<number> {
    return readExecutionContextId(
      await this.sendNormal(
        "Page.createIsolatedWorld",
        {
          frameId,
          ...(options.worldName !== undefined ? { worldName: options.worldName } : {}),
          ...(options.grantUniversalAccess !== undefined
            ? { grantUniveralAccess: options.grantUniversalAccess }
            : {}),
        },
        options.timeoutMs,
      ),
    );
  }

  async dispatchMouseEvent(input: NativeCdpMouseEventInput): Promise<void> {
    this.preflightAction({
      action: input.type === "mouseWheel" ? "scroll" : "click",
      target: `viewport(${String(input.x)},${String(input.y)})`,
    });
    await this.sendNormal("Input.dispatchMouseEvent", {
      type: input.type,
      x: input.x,
      y: input.y,
      button: input.button ?? "none",
      ...(input.buttons !== undefined ? { buttons: input.buttons } : {}),
      clickCount: input.clickCount ?? 0,
      ...(input.modifiers !== undefined ? { modifiers: input.modifiers } : {}),
      ...(input.deltaX !== undefined ? { deltaX: input.deltaX } : {}),
      ...(input.deltaY !== undefined ? { deltaY: input.deltaY } : {}),
    });
  }

  async dispatchKeyEvent(input: NativeCdpKeyEventInput): Promise<void> {
    this.preflightAction({
      action: "type",
      target: input.code ?? input.key ?? input.type,
    });
    await this.sendNormal("Input.dispatchKeyEvent", {
      type: input.type,
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.unmodifiedText !== undefined ? { unmodifiedText: input.unmodifiedText } : {}),
      ...(input.windowsVirtualKeyCode !== undefined
        ? { windowsVirtualKeyCode: input.windowsVirtualKeyCode }
        : {}),
      ...(input.nativeVirtualKeyCode !== undefined
        ? { nativeVirtualKeyCode: input.nativeVirtualKeyCode }
        : {}),
      ...(input.modifiers !== undefined ? { modifiers: input.modifiers } : {}),
    });
  }

  async insertText(text: string): Promise<void> {
    this.preflightAction({
      action: "type",
      target: `${String(text.length)} characters`,
    });
    await this.sendNormal("Input.insertText", { text });
  }

  locator(selector: string, options: NativeCdpLocatorOptions = {}): NativeCdpLocator {
    return new NativeCdpLocator(this, selector, options);
  }

  preflightAction(input: {
    readonly action: string;
    readonly target: string;
    readonly url?: string;
  }): void {
    assertBrowserActionPreflight({
      action: input.action,
      target: input.target,
      ...(this.security !== undefined ? { security: this.security } : {}),
      ...(this.onActionLog !== undefined ? { onActionLog: this.onActionLog } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
    });
  }

  async unsafeEnableRuntimeForDiagnostics(): Promise<void> {
    if (!this.allowUnsafeRuntimeEnableForDiagnostics) {
      throw new Error("Runtime.enable is blocked outside explicit native CDP diagnostics.");
    }

    await this.sendUnsafeDiagnostic("Runtime.enable", {});
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.webSocket.removeEventListener("message", this.handleMessage);
    this.webSocket.removeEventListener("error", this.handleError);
    this.webSocket.removeEventListener("close", this.handleClose);
    this.rejectAllPending(new Error("Native CDP controller closed."));
    this.webSocket.close();
  }

  private async sendNormal(
    method: NativeCdpCommandMethod,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    assertNormalMethod(method);
    return await this.send(method, params, timeoutMs);
  }

  private async sendUnsafeDiagnostic(
    method: NativeCdpCommandMethod,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    assertUnsafeDiagnosticMethod(method);
    return await this.send(method, params, timeoutMs);
  }

  private async send(
    method: NormalNativeCdpMethod | UnsafeDiagnosticNativeCdpMethod,
    params: Record<string, unknown>,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error("Native CDP controller is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload = JSON.stringify({
      id,
      method,
      params,
    });

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native CDP command ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(id, {
        timeout,
        resolve,
        reject,
      });

      try {
        this.webSocket.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private readonly handleMessage = (event: NativeCdpWebSocketMessageEvent): void => {
    const text = readWebSocketTextData(event.data);
    if (text === undefined) {
      return;
    }

    const parsed: unknown = JSON.parse(text);
    if (isNativeCdpErrorResponse(parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(parsed.id);
      pending.reject(createCdpResponseError(parsed.error));
      return;
    }

    if (!isNativeCdpSuccessResponse(parsed)) {
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(parsed.id);
    pending.resolve(parsed.result ?? {});
  };

  private readonly handleError = (): void => {
    this.closed = true;
    this.rejectAllPending(new Error("Native CDP WebSocket error."));
  };

  private readonly handleClose = (): void => {
    this.closed = true;
    this.rejectAllPending(new Error("Native CDP WebSocket closed."));
  };

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
