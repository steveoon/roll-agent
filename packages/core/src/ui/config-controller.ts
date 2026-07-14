import type { ConfigApplicationService } from "../config/application-service.ts";
import type {
  RollUiApplyEffectsRequest,
  RollUiConfigRequest,
  RollUiController,
  RollUiSaveConfigRequest,
} from "./contracts.ts";

type ConfigApplicationPort = Pick<
  ConfigApplicationService,
  "read" | "previewStructured" | "previewYaml" | "saveStructured" | "saveYaml"
>;

export interface ConfigApplicationUiControllerOptions {
  readonly config: ConfigApplicationPort;
  readonly getCatalog: RollUiController["getCatalog"];
  readonly getAgentStatus?: RollUiController["getAgentStatus"];
  readonly applyAgentEffects?: RollUiController["applyAgentEffects"];
}

/**
 * Reuses ConfigApplicationService for both structured and raw-YAML editing.
 * Agent lifecycle hooks remain injectable until the lifecycle layer is wired.
 */
export function createConfigApplicationUiController(
  options: ConfigApplicationUiControllerOptions,
): RollUiController {
  return {
    getConfig: () => options.config.read(),
    getCatalog: () => options.getCatalog(),
    getAgentStatus: () => options.getAgentStatus?.() ?? { available: false, agents: [] },
    previewConfig: (request) => previewConfig(options.config, request),
    saveConfig: (request) => saveConfig(options.config, request),
    applyAgentEffects: (request) =>
      options.applyAgentEffects?.(request) ?? lifecycleUnavailable(request),
  };
}

function previewConfig(config: ConfigApplicationPort, request: RollUiConfigRequest) {
  return request.mode === "structured"
    ? config.previewStructured(request.persisted, request.expectedRevision)
    : config.previewYaml(request.yaml, request.expectedRevision);
}

function saveConfig(config: ConfigApplicationPort, request: RollUiSaveConfigRequest) {
  return request.mode === "structured"
    ? config.saveStructured(request.persisted, request.expectedRevision)
    : config.saveYaml(request.yaml, request.expectedRevision);
}

function lifecycleUnavailable(request: RollUiApplyEffectsRequest) {
  return {
    available: false,
    applied: [],
    skipped: request.effects,
    reason: "Agent lifecycle adapter is not configured.",
  } as const;
}
