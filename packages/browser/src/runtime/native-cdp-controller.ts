import { NativeCdpLocator } from "./native-cdp-locator.ts";
import type { NativeCdpLocatorOptions } from "./native-cdp-locator.ts";

const DEFAULT_NATIVE_CDP_COMMAND_TIMEOUT_MS = 5_000;

const NORMAL_NATIVE_CDP_METHODS = [
  "Runtime.evaluate",
  "DOM.getDocument",
  "Page.bringToFront",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
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

export type NativeCdpCreateIsolatedWorldOptions = {
  readonly worldName?: string;
  readonly grantUniversalAccess?: boolean;
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

  private constructor(webSocket: NativeCdpWebSocketLike, options: NativeCdpControllerOptions) {
    this.webSocket = webSocket;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_NATIVE_CDP_COMMAND_TIMEOUT_MS;
    this.allowUnsafeRuntimeEnableForDiagnostics =
      options.allowUnsafeRuntimeEnableForDiagnostics ?? false;

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

  async bringToFront(): Promise<void> {
    await this.sendNormal("Page.bringToFront", {});
  }

  async getFrameTree(options: { readonly timeoutMs?: number } = {}): Promise<NativeCdpFrameTree> {
    return readFrameTreeResponse(await this.sendNormal("Page.getFrameTree", {}, options.timeoutMs));
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
    await this.sendNormal("Input.insertText", { text });
  }

  locator(selector: string, options: NativeCdpLocatorOptions = {}): NativeCdpLocator {
    return new NativeCdpLocator(this, selector, options);
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
