import { app, BrowserWindow, ipcMain } from "electron";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_METHODS, parseRuntimeMethodParams } from "@roll-agent/protocol";
import { RollNodeClient } from "@roll-agent/client-node";
import type { IpcMainInvokeEvent } from "electron";

let client: RollNodeClient | undefined;
let shutdownPromise: Promise<void> | undefined;
let allowImmediateExit = false;

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
      preload: resolve(import.meta.dirname, "preload.js"),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  client = await RollNodeClient.start({
    cwd: resolve(workspace),
    onStderr: (line) => console.error(`[roll] ${line}`),
    onTurnOutcomeUnknown: (turnId) => {
      window.webContents.send("roll:outcome-unknown", turnId);
    },
  });
  client.onEvent((event) => {
    window.webContents.send("roll:event", event);
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
  ipcMain.handle("roll:approval-respond", (event, input: unknown) => {
    assertTrustedSender(event, trustedUrl);
    return requireClient().request(
      RUNTIME_METHODS.approvalRespond,
      parseRuntimeMethodParams(RUNTIME_METHODS.approvalRespond, input),
    );
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
