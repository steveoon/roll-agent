import { contextBridge, ipcRenderer } from "electron";
import type {
  ApprovalRequestResult,
  RuntimeEventEnvelope,
  RuntimeMethodInput,
  RuntimeMethodResult,
  RuntimeMethodResultForVersion,
  RuntimeServerRequestParamsForVersion,
  TurnId,
  UserInputRequestParamsV12,
  UserInputResult,
} from "@roll-agent/protocol";

type RendererApprovalRequestParams = RuntimeServerRequestParamsForVersion<
  "1.2" | "1.1",
  "approval.request"
>;
type RendererSnapshotResult = RuntimeMethodResultForVersion<"1.2" | "1.1", "thread.snapshot">;

export interface RendererInteractionRequestContext {
  readonly signal: AbortSignal;
}

export type RendererApprovalRequestHandler = (
  params: RendererApprovalRequestParams,
  context: RendererInteractionRequestContext,
) => ApprovalRequestResult | Promise<ApprovalRequestResult>;

export type RendererUserInputRequestHandler = (
  params: UserInputRequestParamsV12,
  context: RendererInteractionRequestContext,
) => UserInputResult | Promise<UserInputResult>;

export interface RollRendererApi {
  createThread(
    params: RuntimeMethodInput<"thread.create">,
  ): Promise<RuntimeMethodResult<"thread.create">>;
  snapshotThread(params: RuntimeMethodInput<"thread.snapshot">): Promise<RendererSnapshotResult>;
  startTurn(params: RuntimeMethodInput<"turn.start">): Promise<RuntimeMethodResult<"turn.start">>;
  cancelTurn(
    params: RuntimeMethodInput<"turn.cancel">,
  ): Promise<RuntimeMethodResult<"turn.cancel">>;
  onApprovalRequest(handler: RendererApprovalRequestHandler): () => void;
  onUserInputRequest(handler: RendererUserInputRequestHandler): () => void;
  onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void;
  onOutcomeUnknown(listener: (turnId: TurnId) => void): () => void;
}

interface RendererInteractionChannels {
  readonly request: string;
  readonly cancel: string;
  readonly result: string;
  readonly error: string;
}

const APPROVAL_CHANNELS = {
  request: "roll:approval-request",
  cancel: "roll:approval-cancel",
  result: "roll:approval-result",
  error: "roll:approval-error",
} as const satisfies RendererInteractionChannels;

const USER_INPUT_CHANNELS = {
  request: "roll:user-input-request",
  cancel: "roll:user-input-cancel",
  result: "roll:user-input-result",
  error: "roll:user-input-error",
} as const satisfies RendererInteractionChannels;

function installRendererInteractionHandler<TParams, TResult>(
  channels: RendererInteractionChannels,
  removedMessage: string,
  handlerFailureMessage: string,
  handler: (
    params: TParams,
    context: RendererInteractionRequestContext,
  ) => TResult | Promise<TResult>,
): () => void {
  const controllers = new Map<string, AbortController>();
  const requestHandler = (
    _event: Electron.IpcRendererEvent,
    value: { readonly requestToken: string; readonly params: TParams },
  ) => {
    if (controllers.has(value.requestToken)) {
      ipcRenderer
        .invoke(channels.error, value.requestToken, "Duplicate interaction request token")
        .catch(() => undefined);
      return;
    }
    const controller = new AbortController();
    controllers.set(value.requestToken, controller);
    Promise.resolve()
      .then(() => handler(value.params, { signal: controller.signal }))
      .then((result) => {
        if (!controller.signal.aborted) {
          return ipcRenderer.invoke(channels.result, value.requestToken, result);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          return ipcRenderer.invoke(channels.error, value.requestToken, handlerFailureMessage);
        }
      })
      .catch(() => undefined)
      .finally(() => controllers.delete(value.requestToken));
  };
  const cancelHandler = (_event: Electron.IpcRendererEvent, requestToken: string) => {
    controllers.get(requestToken)?.abort(new Error("Runtime cancelled the interaction"));
    controllers.delete(requestToken);
  };
  ipcRenderer.on(channels.request, requestHandler);
  ipcRenderer.on(channels.cancel, cancelHandler);
  return () => {
    ipcRenderer.off(channels.request, requestHandler);
    ipcRenderer.off(channels.cancel, cancelHandler);
    for (const [requestToken, controller] of controllers) {
      controller.abort(new Error(removedMessage));
      ipcRenderer.invoke(channels.error, requestToken, removedMessage).catch(() => undefined);
    }
    controllers.clear();
  };
}

const api: RollRendererApi = {
  createThread: (params) => ipcRenderer.invoke("roll:thread-create", params),
  snapshotThread: (params) => ipcRenderer.invoke("roll:thread-snapshot", params),
  startTurn: (params) => ipcRenderer.invoke("roll:turn-start", params),
  cancelTurn: (params) => ipcRenderer.invoke("roll:turn-cancel", params),
  onApprovalRequest: (handler) =>
    installRendererInteractionHandler(
      APPROVAL_CHANNELS,
      "Approval handler was removed",
      "Approval handler failed",
      handler,
    ),
  onUserInputRequest: (handler) =>
    installRendererInteractionHandler(
      USER_INPUT_CHANNELS,
      "User Input handler was removed",
      "User Input handler failed",
      handler,
    ),
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
