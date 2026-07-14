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

export interface RollUiStaticAsset {
  readonly body: Uint8Array | string;
  readonly contentType: string;
}

/** Receives a normalized absolute URL path such as `/index.html`. */
export interface RollUiStaticAssetProvider {
  getAsset(pathname: string): Awaitable<RollUiStaticAsset | null>;
}
