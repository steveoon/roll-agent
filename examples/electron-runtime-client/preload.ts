import { contextBridge, ipcRenderer } from "electron";
import type {
  ApprovalRequestParams,
  ApprovalRequestResult,
  RuntimeEventEnvelope,
  RuntimeMethodInput,
  RuntimeMethodResult,
  TurnId,
} from "@roll-agent/protocol";

export interface RendererApprovalRequestContext {
  readonly signal: AbortSignal;
}

export type RendererApprovalRequestHandler = (
  params: ApprovalRequestParams,
  context: RendererApprovalRequestContext,
) => ApprovalRequestResult | Promise<ApprovalRequestResult>;

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
  onApprovalRequest(handler: RendererApprovalRequestHandler): () => void;
  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void;
  onOutcomeUnknown(listener: (turnId: TurnId) => void): () => void;
}

const api: RollRendererApi = {
  createThread: (params) => ipcRenderer.invoke("roll:thread-create", params),
  snapshotThread: (params) => ipcRenderer.invoke("roll:thread-snapshot", params),
  startTurn: (params) => ipcRenderer.invoke("roll:turn-start", params),
  cancelTurn: (params) => ipcRenderer.invoke("roll:turn-cancel", params),
  onApprovalRequest(handler) {
    const controllers = new Map<string, AbortController>();
    const requestHandler = (
      _event: Electron.IpcRendererEvent,
      value: { readonly requestToken: string; readonly params: ApprovalRequestParams },
    ) => {
      const controller = new AbortController();
      controllers.set(value.requestToken, controller);
      Promise.resolve(handler(value.params, { signal: controller.signal }))
        .then((result) => {
          if (!controller.signal.aborted) {
            return ipcRenderer.invoke("roll:approval-result", value.requestToken, result);
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            return ipcRenderer.invoke(
              "roll:approval-error",
              value.requestToken,
              error instanceof Error ? error.message : String(error),
            );
          }
        })
        .catch(() => undefined)
        .finally(() => controllers.delete(value.requestToken));
    };
    const cancelHandler = (_event: Electron.IpcRendererEvent, requestToken: string) => {
      controllers.get(requestToken)?.abort(new Error("Runtime cancelled the approval request"));
      controllers.delete(requestToken);
    };
    ipcRenderer.on("roll:approval-request", requestHandler);
    ipcRenderer.on("roll:approval-cancel", cancelHandler);
    return () => {
      ipcRenderer.off("roll:approval-request", requestHandler);
      ipcRenderer.off("roll:approval-cancel", cancelHandler);
      for (const [requestToken, controller] of controllers) {
        controller.abort(new Error("Approval handler was removed"));
        ipcRenderer
          .invoke("roll:approval-error", requestToken, "Approval handler was removed")
          .catch(() => undefined);
      }
      controllers.clear();
    };
  },
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
