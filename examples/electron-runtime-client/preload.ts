import { contextBridge, ipcRenderer } from "electron";
import type {
  RuntimeEventEnvelope,
  RuntimeMethodInput,
  RuntimeMethodResult,
  TurnId,
} from "@roll-agent/protocol";

export interface RollRendererApi {
  createThread(
    params: RuntimeMethodInput<"thread.create">,
  ): Promise<RuntimeMethodResult<"thread.create">>;
  snapshotThread(
    params: RuntimeMethodInput<"thread.snapshot">,
  ): Promise<RuntimeMethodResult<"thread.snapshot">>;
  startTurn(params: RuntimeMethodInput<"turn.start">): Promise<RuntimeMethodResult<"turn.start">>;
  cancelTurn(
    params: RuntimeMethodInput<"turn.cancel">,
  ): Promise<RuntimeMethodResult<"turn.cancel">>;
  respondApproval(
    params: RuntimeMethodInput<"approval.respond">,
  ): Promise<RuntimeMethodResult<"approval.respond">>;
  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void;
  onOutcomeUnknown(listener: (turnId: TurnId) => void): () => void;
}

const api: RollRendererApi = {
  createThread: (params) => ipcRenderer.invoke("roll:thread-create", params),
  snapshotThread: (params) => ipcRenderer.invoke("roll:thread-snapshot", params),
  startTurn: (params) => ipcRenderer.invoke("roll:turn-start", params),
  cancelTurn: (params) => ipcRenderer.invoke("roll:turn-cancel", params),
  respondApproval: (params) => ipcRenderer.invoke("roll:approval-respond", params),
  onEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: RuntimeEventEnvelope) =>
      listener(value);
    ipcRenderer.on("roll:event", handler);
    return () => ipcRenderer.off("roll:event", handler);
  },
  onOutcomeUnknown(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: TurnId) => listener(value);
    ipcRenderer.on("roll:outcome-unknown", handler);
    return () => ipcRenderer.off("roll:outcome-unknown", handler);
  },
};

contextBridge.exposeInMainWorld("roll", api);
