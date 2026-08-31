import type { ConfigActivationEffect } from "../config/application-service.ts";
import type { ConfigRevision } from "../config/document-store.ts";

export const ROLL_UI_CONFIG_EDIT_MODES = ["structured", "yaml"] as const;
export type RollUiConfigEditMode = (typeof ROLL_UI_CONFIG_EDIT_MODES)[number];

export interface RollUiStructuredConfigRequest {
  readonly mode: "structured";
  readonly persisted: unknown;
  readonly expectedRevision?: ConfigRevision;
}

export interface RollUiYamlConfigRequest {
  readonly mode: "yaml";
  readonly yaml: string;
  readonly expectedRevision?: ConfigRevision;
}

export type RollUiConfigRequest = RollUiStructuredConfigRequest | RollUiYamlConfigRequest;

export type RollUiSaveConfigRequest =
  | (Omit<RollUiStructuredConfigRequest, "expectedRevision"> & {
      readonly expectedRevision: ConfigRevision;
    })
  | (Omit<RollUiYamlConfigRequest, "expectedRevision"> & {
      readonly expectedRevision: ConfigRevision;
    });

export interface RollUiApplyEffectsRequest {
  /**
   * Untrusted client input. The lifecycle adapter must reconcile these effects
   * with the latest saved activation plan before changing process state.
   */
  readonly effects: readonly ConfigActivationEffect[];
}

type Awaitable<T> = T | Promise<T>;

/**
 * HTTP-independent application boundary used by the local UI server.
 * Implementations can be tested without opening a socket.
 */
export interface RollUiController {
  getConfig(): Awaitable<unknown>;
  getCatalog(): Awaitable<unknown>;
  getAgentStatus(): Awaitable<unknown>;
  previewConfig(request: RollUiConfigRequest): Awaitable<unknown>;
  saveConfig(request: RollUiSaveConfigRequest): Awaitable<unknown>;
  applyAgentEffects(request: RollUiApplyEffectsRequest): Awaitable<unknown>;
}

/** Shape accepted after the controller validates an untrusted enroll request body. */
export interface RollUiCompanionEnrollRequest {
  readonly pairingCode: string;
  readonly workspace: string;
}

/** Shape accepted after the controller validates an untrusted workspace request body. */
export interface RollUiCompanionWorkspaceRequest {
  readonly workspace: string;
}

/**
 * Companion Host management boundary. Reads stay concurrent while mutations are serialized
 * by the implementation. Mutation request bodies arrive as untrusted client input and are
 * validated by the controller, never by the transport.
 */
export interface RollUiCompanionController {
  getStatus(): Awaitable<unknown>;
  getDoctor(): Awaitable<unknown>;
  readLogs(): Awaitable<unknown>;
  followLogs(onText: (text: string) => void, signal: AbortSignal): Promise<void>;
  enroll(request: unknown): Awaitable<unknown>;
  unenroll(): Awaitable<unknown>;
  enable(): Awaitable<unknown>;
  disable(): Awaitable<unknown>;
  setWorkspace(request: unknown): Awaitable<unknown>;
  installService(): Awaitable<unknown>;
  uninstallService(): Awaitable<unknown>;
  start(): Awaitable<unknown>;
  stop(): Awaitable<unknown>;
  restart(): Awaitable<unknown>;
}

/**
 * Scheduler management boundary. Reads stay concurrent while mutations are serialized
 * by the implementation. Mutation request bodies arrive as untrusted client input and are
 * validated by the controller, never by the transport.
 */
export interface RollUiScheduleController {
  getStatus(): Awaitable<unknown>;
  listSchedules(): Awaitable<unknown>;
  listRuns(request: unknown): Awaitable<unknown>;
  installService(): Awaitable<unknown>;
  restartService(): Awaitable<unknown>;
  uninstallService(): Awaitable<unknown>;
  pauseSchedule(request: unknown): Awaitable<unknown>;
  resumeSchedule(request: unknown): Awaitable<unknown>;
  cancelInvocation(request: unknown): Awaitable<unknown>;
}

export interface RollUiStaticAsset {
  readonly body: Uint8Array | string;
  readonly contentType: string;
}

/** Receives a normalized absolute URL path such as `/index.html`. */
export interface RollUiStaticAssetProvider {
  getAsset(pathname: string): Awaitable<RollUiStaticAsset | null>;
}
