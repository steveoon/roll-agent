import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import {
  ConfigApplicationService,
  ConfigApplicationValidationError,
  type ConfigActivationEffect,
  type ConfigApplicationSaveResult,
} from "../config/application-service.ts";
import { buildRollConfigCatalog } from "../config/catalog.ts";
import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { expandTilde, loadAgentsConfig, loadConfig, validateConfigText } from "../config/loader.ts";
import type { RollConfig } from "../config/schema.ts";
import {
  AgentLifecycleService,
  type AgentActivationResult,
  type AgentLifecycleBaseline,
  type AgentLifecycleInspection,
} from "../registry/agent-lifecycle.ts";
import { AgentStore } from "../registry/store.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import type {
  RollUiApplyEffectsRequest,
  RollUiConfigRequest,
  RollUiController,
  RollUiSaveConfigRequest,
} from "./contracts.ts";

interface AgentLifecyclePort {
  inspectAll(): Promise<readonly AgentLifecycleInspection[]>;
  captureBaseline(): AgentLifecycleBaseline;
  applyActivation(
    effects: readonly ConfigActivationEffect[],
    baseline: AgentLifecycleBaseline,
    effectiveConfig: RollConfig,
  ): Promise<AgentActivationResult>;
}

export interface RollUiRuntimeControllerOptions {
  readonly configPath: string;
  readonly createLifecycle?: (dataDir: string) => AgentLifecyclePort;
  readonly now?: () => Date;
}

export class RollUiActivationInProgressError extends Error {
  readonly code = "activation_in_progress" as const;

  constructor() {
    super("Agent 配置正在应用，请等待当前操作结束后再保存。");
    this.name = "RollUiActivationInProgressError";
  }
}

interface PendingActivation {
  readonly revision: string;
  readonly effects: readonly ConfigActivationEffect[];
  readonly baseline: AgentLifecycleBaseline;
  readonly lifecycle: AgentLifecyclePort;
  readonly effectiveConfig: RollConfig;
}

interface AgentContext {
  readonly agents: readonly RegisteredAgent[];
  readonly dataDir: string;
}

export interface RollUiAgentStatusItem {
  readonly name: string;
  readonly ownership: RegisteredAgent["runtime"]["ownership"];
  readonly status: AgentLifecycleInspection["state"];
  readonly healthy: boolean;
  readonly pid?: number;
  readonly endpoint?: string;
  readonly detail: string;
}

export interface RollUiAgentStatusResponse {
  readonly agents: readonly RollUiAgentStatusItem[];
  readonly checkedAt: string;
}

/**
 * Final UI application composition: config catalog, safe save, trusted activation plan,
 * and process status all share the same on-disk configuration and Agent registry.
 */
export function createRollUiRuntimeController(
  options: RollUiRuntimeControllerOptions,
): RollUiController {
  const createLifecycle =
    options.createLifecycle ?? ((dataDir: string) => new AgentLifecycleService(dataDir));
  const now = options.now ?? (() => new Date());
  let pendingActivation: PendingActivation | null = null;
  let activationInFlight: PendingActivation | null = null;

  const readAgentContext = (): AgentContext => loadAgentContext(options.configPath);

  const createConfig = (): ConfigApplicationService => {
    const { agents } = readAgentContext();
    return new ConfigApplicationService({
      configPath: options.configPath,
      agentEnvFields: collectAgentEnvFieldPolicies(agents),
      redactUnknownAgentEnv: true,
    });
  };

  const getAgentStatus = async (): Promise<RollUiAgentStatusResponse> => {
    const { dataDir } = readAgentContext();
    const inspections = await createLifecycle(dataDir).inspectAll();
    return {
      agents: inspections.map(toUiAgentStatus),
      checkedAt: now().toISOString(),
    };
  };

  return {
    getConfig: () => readConfigForUi(createConfig()),
    getCatalog: () => buildRollConfigCatalog(readAgentContext().agents),
    getAgentStatus,
    previewConfig: (request) => {
      const result = previewConfig(createConfig(), request);
      return {
        ...result,
        effects: contextualizeActivationEffects(result.effects, readAgentContext().agents),
      };
    },
    saveConfig: (request) => {
      if (activationInFlight !== null) {
        throw new RollUiActivationInProgressError();
      }
      const configService = createConfig();
      previewConfig(configService, request);
      const lifecycle = createLifecycle(readAgentContext().dataDir);
      const baseline = lifecycle.captureBaseline();
      const rawResult = saveConfig(configService, request);
      const result = {
        ...rawResult,
        effects: contextualizeActivationEffects(rawResult.effects, readAgentContext().agents),
      };
      if (result.changed) {
        pendingActivation = {
          revision: result.snapshot.revision,
          effects: result.effects,
          baseline,
          lifecycle,
          effectiveConfig: loadEffectiveConfig(options.configPath),
        };
      }
      return result;
    },
    applyAgentEffects: async (request: RollUiApplyEffectsRequest) => {
      const pending = pendingActivation;
      if (pending === null) {
        return {
          ...(await getAgentStatus()),
          attempted: false,
          applied: false,
          message:
            activationInFlight === null
              ? "没有等待应用的保存计划；Agent 未发生变更。"
              : "已有配置生效操作正在执行；没有重复应用 Agent 变更。",
        };
      }
      if (!isDeepStrictEqual(request.effects, pending.effects)) {
        return {
          ...(await getAgentStatus()),
          attempted: false,
          applied: false,
          message: "客户端生效计划与最近一次保存结果不一致；Agent 未发生变更。",
        };
      }
      const currentRevision = createConfig().read().revision;
      if (currentRevision !== pending.revision) {
        pendingActivation = null;
        return {
          ...(await getAgentStatus()),
          attempted: false,
          applied: false,
          message: "配置文件在保存后再次变化；为避免应用过期计划，Agent 未发生变更。",
        };
      }

      pendingActivation = null;
      activationInFlight = pending;
      try {
        const result = await pending.lifecycle.applyActivation(
          pending.effects,
          pending.baseline,
          pending.effectiveConfig,
        );
        return {
          ...(await getAgentStatus()),
          attempted: true,
          applied: result.success,
          result,
          message: summarizeActivation(result),
        };
      } finally {
        if (activationInFlight === pending) {
          activationInFlight = null;
        }
      }
    },
  };
}

function contextualizeActivationEffects(
  effects: readonly ConfigActivationEffect[],
  agents: readonly RegisteredAgent[],
): readonly ConfigActivationEffect[] {
  const ownershipByName = new Map(
    agents.map((agent) => [agent.skill.name, agent.runtime.ownership]),
  );
  return effects.map((effect) => {
    if (effect.kind !== "restart-agent" || effect.agentName === undefined) return effect;
    const ownership = ownershipByName.get(effect.agentName);
    if (ownership === "core-managed") return effect;
    if (ownership === "on-demand") {
      return {
        ...effect,
        kind: "next-command",
        title: `${effect.agentName} 下次调用生效`,
        description: "该 Agent 为按需模式，无常驻进程；下一次 run/ask 调用会读取新配置。",
        requiresConfirmation: false,
      };
    }
    return {
      ...effect,
      kind: "manual",
      title:
        ownership === "external-managed"
          ? `${effect.agentName} 需要外部重启`
          : `${effect.agentName} 需要人工处理`,
      description:
        ownership === "external-managed"
          ? "该 Agent 由外部系统管理；保存后请在外部完成重启。"
          : "保存前的注册表中没有该 Agent；Roll UI 不会自动启动或重启它。",
      requiresConfirmation: true,
    };
  });
}

function readConfigForUi(service: ConfigApplicationService) {
  try {
    return service.read();
  } catch (error) {
    if (!(error instanceof ConfigApplicationValidationError)) throw error;
    return {
      ...service.readForRepair(),
      repairMode: true,
      validationIssues: error.issues,
    } as const;
  }
}

function previewConfig(service: ConfigApplicationService, request: RollUiConfigRequest) {
  return request.mode === "structured"
    ? service.previewStructured(request.persisted, request.expectedRevision)
    : service.previewYaml(request.yaml, request.expectedRevision);
}

function saveConfig(
  service: ConfigApplicationService,
  request: RollUiSaveConfigRequest,
): ConfigApplicationSaveResult {
  return request.mode === "structured"
    ? service.saveStructured(request.persisted, request.expectedRevision)
    : service.saveYaml(request.yaml, request.expectedRevision);
}

function loadEffectiveConfig(configPath: string): RollConfig {
  if (existsSync(configPath)) {
    return loadConfig({ configPath }).config;
  }
  const fallback = new ConfigApplicationService({ configPath }).store.fallbackRaw;
  return validateConfigText(fallback, configPath);
}

function loadAgentContext(configPath: string): AgentContext {
  let dataDir = expandTilde(DEFAULT_CONFIG.agents.dataDir);
  if (existsSync(configPath)) {
    try {
      dataDir = loadAgentsConfig({ configPath }).agentsConfig.dataDir;
    } catch {
      // A schema-invalid document must remain repairable in YAML mode. Unknown env values are
      // treated as secrets below when Agent metadata cannot be loaded from the configured store.
    }
  }

  let agents: readonly RegisteredAgent[] = [];
  try {
    agents = new AgentStore(dataDir).list();
  } catch {
    // Status/catalog remain available with an empty registry while the config is being repaired.
  }
  return { agents, dataDir };
}

function collectAgentEnvFieldPolicies(agents: readonly RegisteredAgent[]) {
  return agents.flatMap((agent) =>
    [...(agent.skill.env?.required ?? []), ...(agent.skill.env?.optional ?? [])].map(
      (declaration) => ({
        agentName: agent.skill.name,
        name: declaration.name,
        secret: declaration.secret ?? true,
      }),
    ),
  );
}

function toUiAgentStatus(inspection: AgentLifecycleInspection): RollUiAgentStatusItem {
  const healthy =
    inspection.state === "ready-on-demand" ||
    inspection.state === "running" ||
    inspection.state === "external-online";
  return {
    name: inspection.agentName,
    ownership: inspection.ownership,
    status: inspection.state,
    healthy,
    ...(inspection.pid !== undefined ? { pid: inspection.pid } : {}),
    ...(inspection.endpoint !== undefined ? { endpoint: inspection.endpoint } : {}),
    detail: inspection.message,
  };
}

function summarizeActivation(result: AgentActivationResult): string {
  if (!result.success) {
    const failures = result.items
      .filter((item) => item.status === "failed")
      .map((item) => item.message);
    return failures.length > 0
      ? `配置已保存，但 Agent 重启失败：${failures.join("；")} 请检查状态后手动启动。`
      : "配置已保存，但 Agent 应用失败；请检查状态后手动启动。";
  }
  if (result.restartedAgentNames.length > 0) {
    return `配置已保存并重启：${result.restartedAgentNames.join("、")}。`;
  }
  if (result.requiresManualAction) {
    return "配置已保存；没有自动启动已停止的 Agent，仍有人工步骤待完成。";
  }
  return "配置已保存；变更会在后续命令或新会话中生效。";
}
