import { app, BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RUNTIME_METHODS,
  RUNTIME_SERVER_REQUEST_METHODS,
  parseRuntimeMethodParams,
  parseRuntimeServerRequestResult,
  type ApprovalRequestParams,
  type ApprovalRequestResult,
} from "@roll-agent/protocol";
import { RollNodeClient } from "@roll-agent/client-node";
import type { IpcMainInvokeEvent } from "electron";

let client: RollNodeClient | undefined;
let shutdownPromise: Promise<void> | undefined;
let allowImmediateExit = false;

interface PendingRendererApproval {
  readonly webContentsId: number;
  resolve(result: ApprovalRequestResult): void;
  reject(error: Error): void;
}

const pendingRendererApprovals = new Map<string, PendingRendererApproval>();

function requireClient(): RollNodeClient {
  if (client === undefined) {
    throw new Error("Roll Runtime is not connected");
  }
  return client;
}

function assertTrustedSender(event: IpcMainInvokeEvent, trustedUrl: string): void {
  if (event.senderFrame?.url !== trustedUrl) {
    throw new Error("Rejected Roll IPC from an untrusted frame");
  }
}

function requestRendererApproval(
  window: BrowserWindow,
  params: ApprovalRequestParams,
  signal: AbortSignal,
): Promise<ApprovalRequestResult> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Approval request was cancelled"),
    );
  }
  const requestToken = randomUUID();
  const deferred = Promise.withResolvers<ApprovalRequestResult>();
  const finish = () => {
    pendingRendererApprovals.delete(requestToken);
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    finish();
    window.webContents.send("roll:approval-cancel", requestToken);
    deferred.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Approval request was cancelled"),
    );
  };
  pendingRendererApprovals.set(requestToken, {
    webContentsId: window.webContents.id,
    resolve: (result) => {
      finish();
      deferred.resolve(result);
    },
    reject: (error) => {
      finish();
      deferred.reject(error);
    },
  });
  signal.addEventListener("abort", abort, { once: true });
  window.webContents.send("roll:approval-request", { requestToken, params });
  return deferred.promise;
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
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  client = await RollNodeClient.start({
    cwd: resolve(workspace),
    serverRequestHandlers: {
      [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest]: (params, { signal }) =>
        requestRendererApproval(window, params, signal),
    },
    onStderr: (line) => console.error(`[roll] ${line}`),
    onTurnOutcomeUnknown: (turnId) => {
      window.webContents.send("roll:outcome-unknown", turnId);
    },
  });
  if (client.getInitializationResult().protocolVersion !== "1.1") {
    await client.shutdown();
    client = undefined;
    throw new Error("This Electron reference requires Runtime Protocol 1.1");
  }
  client.onEvent((event) => {
    window.webContents.send("roll:event", event);
  });
  window.on("closed", () => {
    for (const [requestToken, pending] of pendingRendererApprovals) {
      if (pending.webContentsId === window.webContents.id) {
        pendingRendererApprovals.delete(requestToken);
        pending.reject(new Error("Approval window was closed"));
      }
    }
  });
  ipcMain.handle("roll:thread-create", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl);
    return requireClient().request(
      RUNTIME_METHODS.threadCreate,
      parseRuntimeMethodParams(RUNTIME_METHODS.threadCreate, input),
    );
  });
  ipcMain.handle("roll:thread-snapshot", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl);
    return requireClient().request(
      RUNTIME_METHODS.threadSnapshot,
      parseRuntimeMethodParams(RUNTIME_METHODS.threadSnapshot, input),
    );
  });
  ipcMain.handle("roll:turn-start", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl);
    return requireClient().request(
      RUNTIME_METHODS.turnStart,
      parseRuntimeMethodParams(RUNTIME_METHODS.turnStart, input),
    );
  });
  ipcMain.handle("roll:turn-cancel", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl);
    return requireClient().request(
      RUNTIME_METHODS.turnCancel,
      parseRuntimeMethodParams(RUNTIME_METHODS.turnCancel, input),
    );
  });
  ipcMain.handle("roll:approval-result", (event, requestToken: unknown, input: unknown) => {
    assertTrustedSender(event, trustedUrl);
    if (typeof requestToken !== "string") {
      throw new Error("Invalid approval request token");
    }
    const pending = pendingRendererApprovals.get(requestToken);
    if (pending === undefined || pending.webContentsId !== event.sender.id) {
      throw new Error("Approval request is no longer pending for this window");
    }
    const result = parseRuntimeServerRequestResult(
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      input,
    );
    pending.resolve(result);
    return { accepted: true };
  });
  ipcMain.handle("roll:approval-error", (event, requestToken: unknown, message: unknown) => {
    assertTrustedSender(event, trustedUrl);
    if (typeof requestToken !== "string" || typeof message !== "string") {
      throw new Error("Invalid approval error");
    }
    const pending = pendingRendererApprovals.get(requestToken);
    if (pending === undefined || pending.webContentsId !== event.sender.id) {
      throw new Error("Approval request is no longer pending for this window");
    }
    pending.reject(new Error(message.slice(0, 500) || "Renderer approval handler failed"));
    return { accepted: true };
  });
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
