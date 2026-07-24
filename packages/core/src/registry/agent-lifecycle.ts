import { getAgentEnv } from "../config/helpers.ts";
import type { ConfigActivationEffect } from "../config/application-service.ts";
import type { ConfigPath } from "../config/document-store.ts";
import type { RollConfig } from "../config/schema.ts";
import type { AgentRuntimeOwnership, AgentStatus, RegisteredAgent } from "../types/agent.ts";
import {
  acquireAgentLifecycleLock,
  getAgentPid,
  inspectManagedAgentRuntime,
  MANAGED_AGENT_RUNTIME_RETENTIONS,
  probeAgentEndpoint,
  sameManagedAgentRuntimeIdentity,
  startAgent,
  stopAgentGracefully,
  waitForAgentReady,
  type AgentLifecycleLock,
  type ManagedAgentRuntimeIdentity,
  type ManagedAgentRuntimeInspection,
  type ManagedAgentRuntimeRetention,
} from "./process-manager.ts";
import {
  acquireAgentUsageMaintenanceGuard,
  AgentUsageBusyError,
  type AgentUsageMaintenanceGuard,
} from "./agent-usage-lease.ts";
import { acquireAgentRegistryLockAsync, type AgentRegistryLock } from "./agent-registry-lock.ts";
import { AgentStore } from "./store.ts";

const BROWSER_USE_AGENT_NAME = "browser-use-agent";

export const AGENT_LIFECYCLE_STATES = [
  "ready-on-demand",
  "running",
  "stopped",
  "unreachable",
  "external-online",
  "external-unreachable",
] as const;
export type AgentLifecycleState = (typeof AGENT_LIFECYCLE_STATES)[number];

export const AGENT_ACTIVATION_STATUSES = [
  "deferred",
  "restarted",
  "kept-stopped",
  "next-invocation",
  "manual",
  "in-use",
  "runtime-changed",
  "failed",
] as const;
export type AgentActivationStatus = (typeof AGENT_ACTIVATION_STATUSES)[number];

export interface BrowserRuntimeInspectionBoundary {
  readonly state: "not-inspected";
  readonly message: string;
}

export interface AgentLifecycleInspection {
  readonly agentName: string;
  readonly ownership: AgentRuntimeOwnership;
  readonly transport: RegisteredAgent["transport"]["type"];
  readonly state: AgentLifecycleState;
  readonly endpointReachable: boolean | null;
  readonly canAutoRestart: boolean;
  readonly pid?: number;
  readonly endpoint?: string;
  readonly message: string;
  readonly browserRuntime?: BrowserRuntimeInspectionBoundary;
}

export interface AgentLifecycleBaselineState {
  readonly agent: RegisteredAgent;
  readonly pid?: number;
  readonly runtimeIdentity?: AgentLifecycleRuntimeIdentity;
  readonly runtimeRetention?: ManagedAgentRuntimeRetention;
}

export type AgentLifecycleRuntimeIdentity = ManagedAgentRuntimeIdentity;

/**
 * 保存配置前捕获的常驻状态。配置应用只会重启这里记录为运行中的 core-managed Agent。
 */
export interface AgentLifecycleBaseline {
  readonly dataDir: string;
  readonly capturedAt: string;
  readonly agents: Readonly<Record<string, AgentLifecycleBaselineState>>;
}

export interface AgentActivationResultItem {
  readonly effect: ConfigActivationEffect;
  readonly status: AgentActivationStatus;
  readonly message: string;
  readonly pid?: number;
}

export interface AgentActivationResult {
  readonly success: boolean;
  readonly requiresManualAction: boolean;
  readonly restartedAgentNames: readonly string[];
  readonly items: readonly AgentActivationResultItem[];
}

export interface AgentLifecycleCollaborators {
  readonly readAgents: (dataDir: string) => ReadonlyArray<RegisteredAgent>;
  readonly updateStatus: (
    dataDir: string,
    agentName: string,
    status: AgentStatus,
    registryLock?: AgentRegistryLock,
  ) => void;
  readonly getPid: (dataDir: string, agentName: string) => number | undefined;
  readonly inspectRuntime: (
    agent: RegisteredAgent,
    dataDir: string,
  ) => ManagedAgentRuntimeInspection;
  readonly probe: (
    agent: RegisteredAgent,
    options?: { readonly timeoutMs?: number },
  ) => Promise<void>;
  readonly start: (
    agent: RegisteredAgent,
    dataDir: string,
    env?: Readonly<Record<string, string>>,
    options?: {
      readonly lifecycleLock?: AgentLifecycleLock;
      readonly retention?: ManagedAgentRuntimeRetention;
    },
  ) => number;
  readonly stopGracefully: (
    dataDir: string,
    agentName: string,
    options?: {
      readonly timeoutMs?: number;
      readonly intervalMs?: number;
      readonly expectedIdentity?: AgentLifecycleRuntimeIdentity;
      readonly lifecycleLock?: AgentLifecycleLock;
    },
  ) => Promise<boolean>;
  readonly waitUntilReady: (
    agent: RegisteredAgent,
    options?: {
      readonly startupTimeoutMs?: number;
      readonly probeTimeoutMs?: number;
      readonly intervalMs?: number;
    },
  ) => Promise<void>;
  readonly resolveAgentEnv: (
    config: RollConfig,
    agentName: string,
  ) => Readonly<Record<string, string>> | undefined;
  readonly acquireMaintenanceGuard: (
    agent: RegisteredAgent,
    dataDir: string,
  ) => Promise<
    Pick<AgentUsageMaintenanceGuard, "lifecycleLock" | "release"> & {
      readonly runtime?: AgentUsageMaintenanceGuard["runtime"];
    }
  >;
  readonly acquireRegistryLock: (dataDir: string) => Promise<AgentRegistryLock>;
}

export interface AgentInspectionOptions {
  readonly probeTimeoutMs?: number;
}

const DEFAULT_COLLABORATORS: AgentLifecycleCollaborators = {
  readAgents: (dataDir) => new AgentStore(dataDir).list(),
  updateStatus: (dataDir, agentName, status, registryLock) => {
    new AgentStore(dataDir, {
      ...(registryLock ? { registryLock } : {}),
    }).updateStatus(agentName, status);
  },
  getPid: getAgentPid,
  inspectRuntime: inspectManagedAgentRuntime,
  probe: probeAgentEndpoint,
  start: startAgent,
  stopGracefully: stopAgentGracefully,
  waitUntilReady: waitForAgentReady,
  resolveAgentEnv: getAgentEnv,
  acquireMaintenanceGuard: async (agent, dataDir) => {
    const usageGuard = await acquireAgentUsageMaintenanceGuard(agent, dataDir);
    if (usageGuard !== undefined) return usageGuard;
    const lifecycleLock = acquireAgentLifecycleLock(dataDir, agent.skill.name);
    return {
      lifecycleLock,
      release: () => lifecycleLock.release(),
    };
  },
  acquireRegistryLock: acquireAgentRegistryLockAsync,
};

/**
 * CLI 与本地 UI 可共同复用的 Agent 状态检查和配置生效服务。
 *
 * 此服务只管理 Agent 进程/MCP endpoint；即使 browser-use-agent 显示 running，
 * 也不代表 Chrome 已启动，浏览器实例仍由首次浏览器工具调用懒启动。
 */
export class AgentLifecycleService {
  readonly dataDir: string;
  private readonly collaborators: AgentLifecycleCollaborators;

  constructor(dataDir: string, collaborators: Partial<AgentLifecycleCollaborators> = {}) {
    this.dataDir = dataDir;
    this.collaborators = {
      ...DEFAULT_COLLABORATORS,
      ...collaborators,
    };
  }

  async inspectAll(
    options: AgentInspectionOptions = {},
  ): Promise<readonly AgentLifecycleInspection[]> {
    const agents = this.collaborators.readAgents(this.dataDir);
    return Promise.all(agents.map((agent) => this.inspectAgent(agent, options)));
  }

  captureBaseline(): AgentLifecycleBaseline {
    const states: Record<string, AgentLifecycleBaselineState> = {};
    for (const agent of this.collaborators.readAgents(this.dataDir)) {
      const runtimeInspection =
        agent.runtime.ownership === "core-managed"
          ? this.collaborators.inspectRuntime(agent, this.dataDir)
          : undefined;
      const pid = runtimeInspection?.pid;
      const runtimeIdentity =
        runtimeInspection === undefined
          ? undefined
          : verifiedRuntimeIdentity(agent, runtimeInspection);
      const runtimeRetention =
        runtimeIdentity === undefined ? undefined : runtimeInspection?.sidecar?.retention;
      states[agent.skill.name] = {
        agent,
        ...(pid !== undefined ? { pid } : {}),
        ...(runtimeIdentity !== undefined ? { runtimeIdentity } : {}),
        ...(runtimeRetention !== undefined ? { runtimeRetention } : {}),
      };
    }

    return {
      dataDir: this.dataDir,
      capturedAt: new Date().toISOString(),
      agents: states,
    };
  }

  /** 显式重启一个当前正在运行的 core-managed Agent；不会把 stopped Agent 启动起来。 */
  async restartRunningAgent(
    agentName: string,
    effectiveConfig: RollConfig,
  ): Promise<AgentActivationResultItem> {
    const effect: ConfigActivationEffect = {
      kind: "restart-agent",
      paths: [],
      title: `重启 ${agentName}`,
      description: "重启当前运行中的 core-managed Agent。",
      agentName,
      requiresConfirmation: true,
    };
    const baseline = this.captureBaseline();
    return this.applyRestartEffect(effect, baseline, effectiveConfig, false);
  }

  async applyActivation(
    effects: readonly ConfigActivationEffect[],
    baseline: AgentLifecycleBaseline,
    effectiveConfig: RollConfig,
  ): Promise<AgentActivationResult> {
    if (baseline.dataDir !== this.dataDir) {
      throw new Error(
        `Agent lifecycle baseline dataDir mismatch: expected ${this.dataDir}, received ${baseline.dataDir}`,
      );
    }

    const dataDirMigrationRequired = effects.some(
      (effect) => effect.kind === "manual" && effect.paths.some(isAgentsDataDirPath),
    );
    const seenRestartAgents = new Set<string>();
    const items: AgentActivationResultItem[] = [];

    for (const effect of effects) {
      if (effect.kind === "restart-agent") {
        if (effect.agentName !== undefined) {
          if (seenRestartAgents.has(effect.agentName)) {
            continue;
          }
          seenRestartAgents.add(effect.agentName);
        }
        items.push(
          await this.applyRestartEffect(
            effect,
            baseline,
            effectiveConfig,
            dataDirMigrationRequired,
          ),
        );
        continue;
      }

      items.push(describeNonRestartEffect(effect));
    }

    const manualStatuses = new Set<AgentActivationStatus>([
      "manual",
      "in-use",
      "runtime-changed",
      "failed",
    ]);
    return {
      success: items.every((item) => item.status !== "failed"),
      requiresManualAction: items.some((item) => manualStatuses.has(item.status)),
      restartedAgentNames: items.flatMap((item) =>
        item.status === "restarted" && item.effect.agentName !== undefined
          ? [item.effect.agentName]
          : [],
      ),
      items,
    };
  }

  private async inspectAgent(
    agent: RegisteredAgent,
    options: AgentInspectionOptions,
  ): Promise<AgentLifecycleInspection> {
    const common = inspectionIdentity(agent);
    switch (agent.runtime.ownership) {
      case "on-demand":
        return {
          ...common,
          state: "ready-on-demand",
          endpointReachable: null,
          canAutoRestart: false,
          message: "按需模式：配置会在下一次 run/ask 调用时生效，无常驻进程可重启。",
        };
      case "external-managed":
        try {
          await this.collaborators.probe(agent, probeOptions(options));
          return {
            ...common,
            state: "external-online",
            endpointReachable: true,
            canAutoRestart: false,
            message:
              agent.skill.name === BROWSER_USE_AGENT_NAME
                ? "browser-use-agent 的外部 MCP endpoint 可连接；这不代表 Chrome 已启动。"
                : "外部托管 endpoint 可连接；启动、停止和重启仍由外部系统负责。",
            ...browserRuntimeBoundary(agent),
          };
        } catch {
          return {
            ...common,
            state: "external-unreachable",
            endpointReachable: false,
            canAutoRestart: false,
            message: "外部托管 endpoint 不可连接；请检查外部服务状态和 Agent 日志。",
            ...browserRuntimeBoundary(agent),
          };
        }
      case "core-managed": {
        const runtimeInspection = this.collaborators.inspectRuntime(agent, this.dataDir);
        const pid = runtimeInspection.pid;
        if (pid === undefined) {
          return {
            ...common,
            state: "stopped",
            endpointReachable: null,
            canAutoRestart: false,
            message: "Agent 当前已停止；保存配置不会把它自动启动。",
          };
        }

        if (verifiedRuntimeIdentity(agent, runtimeInspection) === undefined) {
          return {
            ...common,
            state: "unreachable",
            endpointReachable: null,
            canAutoRestart: false,
            pid,
            message:
              "Agent PID 存在，但 runtime 身份无法安全验证；已禁用自动停止/重启，请按诊断提示人工处理。",
            ...browserRuntimeBoundary(agent),
          };
        }

        try {
          await this.collaborators.probe(agent, probeOptions(options));
          return {
            ...common,
            state: "running",
            endpointReachable: true,
            canAutoRestart: true,
            pid,
            message: runningMessage(agent),
            ...browserRuntimeBoundary(agent),
          };
        } catch {
          return {
            ...common,
            state: "unreachable",
            endpointReachable: false,
            canAutoRestart: true,
            pid,
            message: "Agent 进程存在，但 MCP endpoint 不可连接；请检查 Agent 日志。",
            ...browserRuntimeBoundary(agent),
          };
        }
      }
    }
  }

  private async applyRestartEffect(
    effect: ConfigActivationEffect,
    baseline: AgentLifecycleBaseline,
    effectiveConfig: RollConfig,
    dataDirMigrationRequired: boolean,
  ): Promise<AgentActivationResultItem> {
    const agentName = effect.agentName;
    if (agentName === undefined) {
      return activationItem(effect, "manual", "生效计划没有提供 Agent 名称，无法自动重启。");
    }
    if (dataDirMigrationRequired) {
      return activationItem(
        effect,
        "manual",
        "`agents.dataDir` 已变更；先停止 Agent 并人工迁移 PID、日志和注册数据，再执行重启。",
      );
    }

    const baselineState = baseline.agents[agentName];
    if (baselineState === undefined) {
      return activationItem(
        effect,
        "manual",
        `保存前的 Agent 列表中没有 ${agentName}，不会自动启动。`,
      );
    }

    switch (baselineState.agent.runtime.ownership) {
      case "on-demand":
        return activationItem(
          effect,
          "next-invocation",
          `${agentName} 为按需模式，配置会在下一次 run/ask 调用时生效。`,
        );
      case "external-managed":
        return activationItem(effect, "manual", `${agentName} 由外部系统管理，请在外部完成重启。`);
      case "core-managed":
        break;
    }

    if (baselineState.pid === undefined) {
      return activationItem(
        effect,
        "kept-stopped",
        `${agentName} 保存前已停止，保持停止；下次手动启动时会读取新配置。`,
      );
    }
    if (baselineState.runtimeIdentity === undefined) {
      return activationItem(
        effect,
        "runtime-changed",
        `${agentName} 保存前的进程缺少可验证的 runtime sidecar；为避免停止无关进程，未自动应用。`,
      );
    }

    return this.restartCoreManagedAgent(
      effect,
      baselineState.agent,
      baselineState.runtimeIdentity,
      baselineState.runtimeRetention,
      effectiveConfig,
    );
  }

  private async restartCoreManagedAgent(
    effect: ConfigActivationEffect,
    agent: RegisteredAgent,
    expectedIdentity: AgentLifecycleRuntimeIdentity,
    expectedRetention: ManagedAgentRuntimeRetention | undefined,
    effectiveConfig: RollConfig,
  ): Promise<AgentActivationResultItem> {
    const expectedPid = expectedIdentity.pid;
    let startedPid: number | undefined;
    let startedIdentity: AgentLifecycleRuntimeIdentity | undefined;
    let maintenanceGuard:
      | Awaited<ReturnType<AgentLifecycleCollaborators["acquireMaintenanceGuard"]>>
      | undefined;
    let registryLock: AgentRegistryLock | undefined;
    try {
      registryLock = await this.collaborators.acquireRegistryLock(this.dataDir);
      maintenanceGuard = await this.collaborators.acquireMaintenanceGuard(agent, this.dataDir);
      const lifecycleLock = maintenanceGuard.lifecycleLock;
      const currentRuntime = this.collaborators.inspectRuntime(agent, this.dataDir);
      const currentIdentity = verifiedRuntimeIdentity(agent, currentRuntime);
      const runtimeRetention =
        maintenanceGuard.runtime?.retention ?? MANAGED_AGENT_RUNTIME_RETENTIONS.persistent;
      if (!sameManagedAgentRuntimeIdentity(currentIdentity, expectedIdentity)) {
        const currentPid = currentRuntime.pid;
        if (
          currentPid === undefined &&
          expectedRetention === MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound
        ) {
          this.collaborators.updateStatus(this.dataDir, agent.skill.name, "stopped", registryLock);
          return activationItem(
            effect,
            "kept-stopped",
            `${agent.skill.name} 的临时托管进程已随最后一个使用方退出；保持停止，下次调用时会读取新配置。`,
          );
        }
        return activationItem(
          effect,
          "runtime-changed",
          currentPid === undefined
            ? `${agent.skill.name} 在保存后已被停止，为避免意外重新启动，未自动应用。`
            : currentPid !== expectedPid
              ? `${agent.skill.name} 的 PID 已从 ${String(expectedPid)} 变为 ${String(currentPid)}，为避免停止新进程，未自动应用。`
              : `${agent.skill.name} 的 runtime sidecar 已缺失、失效或不再对应保存前的进程；为避免停止无关进程，未自动应用。`,
        );
      }
      const stopped = await this.collaborators.stopGracefully(this.dataDir, agent.skill.name, {
        expectedIdentity,
        lifecycleLock,
      });
      if (!stopped) {
        return activationItem(
          effect,
          "runtime-changed",
          `${agent.skill.name} 在应用前已不再运行，为避免意外启动，未自动应用。`,
        );
      }
      if (runtimeRetention === MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound) {
        this.collaborators.updateStatus(this.dataDir, agent.skill.name, "stopped", registryLock);
        return activationItem(
          effect,
          "kept-stopped",
          `${agent.skill.name} 当前已无活动使用方；已停止临时托管进程并保持停止，下次调用时会读取新配置。`,
        );
      }

      this.collaborators.updateStatus(this.dataDir, agent.skill.name, "starting", registryLock);
      const env = this.collaborators.resolveAgentEnv(effectiveConfig, agent.skill.name);
      startedPid = this.collaborators.start(agent, this.dataDir, env, {
        lifecycleLock,
        retention: runtimeRetention,
      });
      startedIdentity = verifiedRuntimeIdentity(
        agent,
        this.collaborators.inspectRuntime(agent, this.dataDir),
      );
      if (startedIdentity?.pid !== startedPid) {
        throw new Error("Started Agent runtime identity could not be verified.");
      }
      await this.collaborators.waitUntilReady(agent);
      this.collaborators.updateStatus(this.dataDir, agent.skill.name, "online", registryLock);
      return activationItem(effect, "restarted", restartedMessage(agent), startedPid);
    } catch (error) {
      if (error instanceof AgentUsageBusyError) {
        return activationItem(
          effect,
          "in-use",
          `${agent.skill.name} 正被其他 Roll 进程使用，配置已保存但未自动重启。`,
        );
      }
      let replacementObserved = false;
      if (startedPid !== undefined) {
        const currentRuntime = this.collaborators.inspectRuntime(agent, this.dataDir);
        const currentIdentity = verifiedRuntimeIdentity(agent, currentRuntime);
        let currentPid = currentRuntime.pid;
        if (
          startedIdentity !== undefined &&
          sameManagedAgentRuntimeIdentity(currentIdentity, startedIdentity)
        ) {
          await this.collaborators
            .stopGracefully(this.dataDir, agent.skill.name, {
              expectedIdentity: startedIdentity,
              ...(maintenanceGuard !== undefined
                ? { lifecycleLock: maintenanceGuard.lifecycleLock }
                : {}),
            })
            .catch(() => false);
          currentPid = this.collaborators.getPid(this.dataDir, agent.skill.name);
        }
        replacementObserved = currentPid !== undefined && currentPid !== startedPid;
      }
      if (maintenanceGuard !== undefined && !replacementObserved) {
        this.collaborators.updateStatus(this.dataDir, agent.skill.name, "error", registryLock);
      }
      return activationItem(effect, "failed", `${agent.skill.name} 重启失败；请检查 Agent 日志。`);
    } finally {
      maintenanceGuard?.release();
      registryLock?.release();
    }
  }
}

function verifiedRuntimeIdentity(
  agent: RegisteredAgent,
  inspection: ManagedAgentRuntimeInspection,
): AgentLifecycleRuntimeIdentity | undefined {
  const { pid, sidecar } = inspection;
  if (
    pid === undefined ||
    sidecar === undefined ||
    inspection.issues.length > 0 ||
    sidecar.agentName !== agent.skill.name ||
    sidecar.pid !== pid ||
    sidecar.coreVersion !== inspection.expectedCoreVersion
  ) {
    return undefined;
  }

  if (agent.transport.type === "streamable-http") {
    if (
      inspection.expectedEndpoint !== agent.transport.endpoint ||
      sidecar.endpoint !== agent.transport.endpoint
    ) {
      return undefined;
    }
  } else if (sidecar.endpoint !== undefined || inspection.expectedEndpoint !== undefined) {
    return undefined;
  }

  return {
    pid,
    processStartToken: sidecar.processStartToken,
    startedAt: sidecar.startedAt,
  };
}

function inspectionIdentity(
  agent: RegisteredAgent,
): Pick<AgentLifecycleInspection, "agentName" | "ownership" | "transport" | "endpoint"> {
  return {
    agentName: agent.skill.name,
    ownership: agent.runtime.ownership,
    transport: agent.transport.type,
    ...(agent.transport.type === "streamable-http"
      ? { endpoint: sanitizeEndpointForDisplay(agent.transport.endpoint) }
      : {}),
  };
}

function sanitizeEndpointForDisplay(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid endpoint]";
  }
}

function probeOptions(options: AgentInspectionOptions): { readonly timeoutMs?: number } {
  return options.probeTimeoutMs !== undefined ? { timeoutMs: options.probeTimeoutMs } : {};
}

function browserRuntimeBoundary(agent: RegisteredAgent): {
  readonly browserRuntime?: BrowserRuntimeInspectionBoundary;
} {
  if (agent.skill.name !== BROWSER_USE_AGENT_NAME) {
    return {};
  }
  return {
    browserRuntime: {
      state: "not-inspected",
      message:
        "这里只检查 browser-use-agent 的 MCP endpoint；不代表 Chrome 已启动，Chrome 仍在首次浏览器工具调用时懒启动。",
    },
  };
}

function runningMessage(agent: RegisteredAgent): string {
  return agent.skill.name === BROWSER_USE_AGENT_NAME
    ? "browser-use-agent 的 MCP endpoint 已在线；这不代表 Chrome 已启动。"
    : "Agent 进程与 MCP endpoint 均在线。";
}

function restartedMessage(agent: RegisteredAgent): string {
  return agent.skill.name === BROWSER_USE_AGENT_NAME
    ? "browser-use-agent 的 MCP endpoint 已重启并在线；Chrome 仍会在首次浏览器工具调用时懒启动。"
    : `${agent.skill.name} 已重启并在线。`;
}

function isAgentsDataDirPath(path: ConfigPath): boolean {
  return path[0] === "agents" && path[1] === "dataDir";
}

function describeNonRestartEffect(effect: ConfigActivationEffect): AgentActivationResultItem {
  switch (effect.kind) {
    case "next-command":
      return activationItem(effect, "deferred", "配置已保存，后续 Roll 命令会重新加载。 ");
    case "next-chat":
      return activationItem(effect, "deferred", "配置已保存，新建 roll chat 会话后生效。 ");
    case "manual":
      return activationItem(effect, "manual", effect.description);
    case "restart-agent":
      return activationItem(effect, "manual", "未执行 Agent 重启。 ");
  }
}

function activationItem(
  effect: ConfigActivationEffect,
  status: AgentActivationStatus,
  message: string,
  pid?: number,
): AgentActivationResultItem {
  return {
    effect,
    status,
    message: message.trim(),
    ...(pid !== undefined ? { pid } : {}),
  };
}
