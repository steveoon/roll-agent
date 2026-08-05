import { app, BrowserWindow, ipcMain } from "electron";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_METHODS,
  normalizeUserInputResult,
  parseRuntimeMethodParams,
  parseRuntimeServerRequestResultForVersion,
  type ApprovalRequestResult,
  type RuntimeServerRequestParamsForVersion,
  type UserInputRequestParamsV12,
  type UserInputResult,
} from "@roll-agent/protocol";
import { RollNodeClient } from "@roll-agent/client-node";
import type { IpcMainInvokeEvent } from "electron";
import {
  RendererInteractionRegistry,
  type RendererInteractionAuthority,
  type RendererInteractionMethod,
} from "./renderer-interaction-registry.ts";
import {
  isElectronRuntimeProtocolVersion,
  type ElectronRuntimeProtocolVersion,
} from "./supported-protocols.ts";

let client: RollNodeClient | undefined;
let shutdownPromise: Promise<void> | undefined;
let allowImmediateExit = false;

type RendererApprovalRequestParams = RuntimeServerRequestParamsForVersion<
  ElectronRuntimeProtocolVersion,
  typeof RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
>;
type RendererInteractionParamsByMethod = {
  readonly [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: RendererApprovalRequestParams;
  readonly [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest]: UserInputRequestParamsV12;
};
type RendererInteractionResultByMethod = {
  readonly [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: ApprovalRequestResult;
  readonly [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest]: UserInputResult;
};

const RENDERER_INTERACTION_CHANNELS = {
  [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: {
    request: "roll:approval-request",
    cancel: "roll:approval-cancel",
  },
  [RUNTIME_SERVER_REQUEST_METHODS.userInputRequest]: {
    request: "roll:user-input-request",
    cancel: "roll:user-input-cancel",
  },
} as const satisfies Readonly<
  Record<RendererInteractionMethod, { readonly request: string; readonly cancel: string }>
>;

function requireClient(): RollNodeClient {
  if (client === undefined) {
    throw new Error("Roll Runtime is not connected");
  }
  return client;
}

function requireApprovalProtocolVersion(): ElectronRuntimeProtocolVersion {
  const protocolVersion = requireClient().getInitializationResult().protocolVersion;
  if (!isElectronRuntimeProtocolVersion(protocolVersion)) {
    throw new Error("Approval is unavailable for the negotiated Runtime Protocol version");
  }
  return protocolVersion;
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  trustedUrl: string,
  trustedWebContentsId: number,
): void {
  if (event.sender.id !== trustedWebContentsId || event.senderFrame?.url !== trustedUrl) {
    throw new Error("Rejected Roll IPC from an untrusted frame");
  }
}

function requireRequestToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid renderer interaction request token");
  }
  return value;
}

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Runtime cancelled the renderer interaction");
}

function sendToRenderer(
  window: BrowserWindow,
  channel: string,
  ...args: readonly unknown[]
): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return false;
  }
  try {
    window.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

function isMainFrameNavigation(
  eventOrDetails: unknown,
  detailsOrUrl: unknown,
  legacyIsMainFrame: unknown,
): boolean {
  if (typeof legacyIsMainFrame === "boolean") {
    return legacyIsMainFrame;
  }
  for (const candidate of [detailsOrUrl, eventOrDetails]) {
    if (typeof candidate === "object" && candidate !== null && "isMainFrame" in candidate) {
      return candidate.isMainFrame === true;
    }
  }
  return true;
}

async function requestRendererInteraction<TMethod extends RendererInteractionMethod>(
  window: BrowserWindow,
  registry: RendererInteractionRegistry,
  documentGeneration: number,
  method: TMethod,
  params: RendererInteractionParamsByMethod[TMethod],
  signal: AbortSignal,
  parseResult: (value: unknown) => RendererInteractionResultByMethod[TMethod],
): Promise<RendererInteractionResultByMethod[TMethod]> {
  if (signal.aborted) {
    throw getAbortError(signal);
  }
  const authority = {
    method,
    webContentsId: window.webContents.id,
    documentGeneration,
  } satisfies RendererInteractionAuthority;
  const registered = registry.register(authority);
  const channels = RENDERER_INTERACTION_CHANNELS[method];
  const abort = () => {
    const error = getAbortError(signal);
    if (registry.cancel(registered.requestToken, authority, error)) {
      sendToRenderer(window, channels.cancel, registered.requestToken);
    }
  };

  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  } else if (
    !sendToRenderer(window, channels.request, {
      requestToken: registered.requestToken,
      params,
    })
  ) {
    registry.cancel(
      registered.requestToken,
      authority,
      new Error("Renderer is unavailable for this interaction"),
    );
  }

  try {
    return parseResult(await registered.promise);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function requestRendererApproval(
  window: BrowserWindow,
  registry: RendererInteractionRegistry,
  documentGeneration: number,
  params: RendererApprovalRequestParams,
  signal: AbortSignal,
): Promise<ApprovalRequestResult> {
  return requestRendererInteraction(
    window,
    registry,
    documentGeneration,
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    params,
    signal,
    (value) =>
      parseRuntimeServerRequestResultForVersion(
        requireApprovalProtocolVersion(),
        RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
        value,
      ),
  );
}

function requestRendererUserInput(
  window: BrowserWindow,
  registry: RendererInteractionRegistry,
  documentGeneration: number,
  params: UserInputRequestParamsV12,
  signal: AbortSignal,
): Promise<UserInputResult> {
  return requestRendererInteraction(
    window,
    registry,
    documentGeneration,
    RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
    params,
    signal,
    (value) => normalizeUserInputResult(params, value),
  );
}

async function createWindow(): Promise<void> {
  const workspace = app.commandLine.getSwitchValue("workspace");
  if (workspace.length === 0) {
    throw new Error("Start Electron with --workspace=/absolute/path");
  }
  const htmlPath = resolve(import.meta.dirname, "index.html");
  const trustedUrl = pathToFileURL(htmlPath).toString();
  const window = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolve(import.meta.dirname, "preload.cjs"),
    },
  });
  const webContentsId = window.webContents.id;
  const rendererInteractions = new RendererInteractionRegistry();
  let documentGeneration = 0;
  const invalidateRenderer = (message: string) => {
    rendererInteractions.invalidateWebContents(webContentsId, new Error(message));
  };

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("did-start-navigation", (event, detailsOrUrl, _isInPlace, isMainFrame) => {
    if (!isMainFrameNavigation(event, detailsOrUrl, isMainFrame)) {
      return;
    }
    rendererInteractions.invalidateDocument(
      webContentsId,
      documentGeneration,
      new Error("Renderer document navigation started"),
    );
    documentGeneration += 1;
  });
  window.webContents.on("render-process-gone", () => {
    invalidateRenderer("Renderer process exited");
  });
  window.webContents.on("destroyed", () => {
    invalidateRenderer("Renderer webContents was destroyed");
  });
  window.on("closed", () => {
    invalidateRenderer("Renderer window was closed");
  });

  client = await RollNodeClient.start({
    cwd: resolve(workspace),
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: (params, { signal }) =>
        requestRendererApproval(window, rendererInteractions, documentGeneration, params, signal),
    },
    onUserInputRequest: (params, { signal }) =>
      requestRendererUserInput(window, rendererInteractions, documentGeneration, params, signal),
    onStderr: (line) => console.error(`[roll] ${line}`),
    onTurnOutcomeUnknown: (turnId) => {
      sendToRenderer(window, "roll:outcome-unknown", turnId);
    },
  });
  const protocolVersion = client.getInitializationResult().protocolVersion;
  if (!isElectronRuntimeProtocolVersion(protocolVersion)) {
    await client.shutdown();
    client = undefined;
    throw new Error("This Electron reference requires Runtime Protocol 1.3, 1.2 or 1.1");
  }
  client.onEvent((event) => {
    sendToRenderer(window, "roll:event", event);
  });

  const interactionAuthority = (
    method: RendererInteractionMethod,
    event: IpcMainInvokeEvent,
  ): RendererInteractionAuthority => ({
    method,
    webContentsId: event.sender.id,
    documentGeneration,
  });
  const rejectRendererInteraction = (
    method: RendererInteractionMethod,
    event: IpcMainInvokeEvent,
    requestTokenValue: unknown,
    message: unknown,
  ) => {
    assertTrustedSender(event, trustedUrl, webContentsId);
    if (typeof message !== "string") {
      throw new Error("Invalid renderer interaction error");
    }
    rendererInteractions.reject(
      requireRequestToken(requestTokenValue),
      interactionAuthority(method, event),
      new Error(message.slice(0, 500) || "Renderer interaction handler failed"),
    );
    return { accepted: true };
  };

  ipcMain.handle("roll:thread-create", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl, webContentsId);
    return requireClient().request(
      RUNTIME_METHODS.threadCreate,
      parseRuntimeMethodParams(RUNTIME_METHODS.threadCreate, input),
    );
  });
  ipcMain.handle("roll:thread-snapshot", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl, webContentsId);
    return requireClient().request(
      RUNTIME_METHODS.threadSnapshot,
      parseRuntimeMethodParams(RUNTIME_METHODS.threadSnapshot, input),
    );
  });
  ipcMain.handle("roll:turn-start", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl, webContentsId);
    return requireClient().request(
      RUNTIME_METHODS.turnStart,
      parseRuntimeMethodParams(RUNTIME_METHODS.turnStart, input),
    );
  });
  ipcMain.handle("roll:turn-cancel", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl, webContentsId);
    return requireClient().request(
      RUNTIME_METHODS.turnCancel,
      parseRuntimeMethodParams(RUNTIME_METHODS.turnCancel, input),
    );
  });
  ipcMain.handle("roll:approval-result", (event, requestToken: unknown, input: unknown) => {
    assertTrustedSender(event, trustedUrl, webContentsId);
    rendererInteractions.resolve(
      requireRequestToken(requestToken),
      interactionAuthority(RUNTIME_SERVER_REQUEST_METHODS.approvalRequest, event),
      input,
    );
    return { accepted: true };
  });
  ipcMain.handle("roll:approval-error", (event, requestToken: unknown, message: unknown) =>
    rejectRendererInteraction(
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      event,
      requestToken,
      message,
    ),
  );
  ipcMain.handle("roll:user-input-result", (event, requestToken: unknown, input: unknown) => {
    assertTrustedSender(event, trustedUrl, webContentsId);
    rendererInteractions.resolve(
      requireRequestToken(requestToken),
      interactionAuthority(RUNTIME_SERVER_REQUEST_METHODS.userInputRequest, event),
      input,
    );
    return { accepted: true };
  });
  ipcMain.handle("roll:user-input-error", (event, requestToken: unknown, message: unknown) =>
    rejectRendererInteraction(
      RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
      event,
      requestToken,
      message,
    ),
  );
  await window.loadFile(htmlPath);
}

function shutdownAndExit(exitCode: number): Promise<void> {
  shutdownPromise ??= (async () => {
    try {
      await client?.shutdown();
    } catch (error: unknown) {
      console.error(
        `[roll] Runtime shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      exitCode = 1;
    } finally {
      allowImmediateExit = true;
      app.exit(exitCode);
    }
  })();
  return shutdownPromise;
}

app.whenReady().then(createWindow);
app.on("before-quit", (event) => {
  if (allowImmediateExit) {
    return;
  }
  event.preventDefault();
  shutdownAndExit(0).catch(() => {});
});
