import { existsSync } from "node:fs";
import {
  buildNpmRetryPolicy,
  formatPackageManagerError,
  npmInstallNetworkArgs,
  runPackageManagerWithRetry,
  type PackageManagerRunSpec,
} from "../cli/utils/package-manager.ts";
import type { RollConfig } from "../config/schema.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import { discoverAgent } from "./discovery.ts";
import { beginInstallDirectoryReplacement } from "./install-directory-backup.ts";
import {
  commitInstalledPackageReplacement,
  createInstalledPackageReplacement,
  recordInstalledPackageDirectoryBackup,
  recordInstalledPackageRegistrationReplacement,
  recordInstalledPackageStoppedRuntime,
  rollbackInstalledPackageReplacement,
  type InstalledPackageReplacementCommitOutcome,
  type InstalledPackageReplacementRollbackOutcome,
  type InstalledPackageReplacementStore,
} from "./installed-package-replacement.ts";
import { MANAGED_AGENT_RUNTIME_RETENTIONS } from "./process-manager.ts";
import { runAgentSetup } from "./runtime-setup.ts";
import { readInstalledPackageManifest, resolveInstalledPackageRoot } from "./source.ts";

type InstallConfig = RollConfig["install"];

export const INSTALLED_PACKAGE_UPDATE_PHASES = {
  install: "install",
  activate: "activate",
} as const;

export type InstalledPackageUpdatePhase =
  (typeof INSTALLED_PACKAGE_UPDATE_PHASES)[keyof typeof INSTALLED_PACKAGE_UPDATE_PHASES];

export type InstalledPackageUpdateEvent =
  | { readonly type: "install-start"; readonly agentName: string }
  | {
      readonly type: "install-retry";
      readonly agentName: string;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly type: "install-succeeded"; readonly agentName: string }
  | { readonly type: "install-failed"; readonly agentName: string };

export type InstalledPackageUpdateReporter = (event: InstalledPackageUpdateEvent) => void;

export interface InstalledPackageUpdateInput {
  readonly agent: RegisteredAgent;
  readonly install: InstallConfig;
  readonly store: InstalledPackageReplacementStore;
  readonly shouldRestart: boolean;
  readonly resolvePackageSpec: (agent: RegisteredAgent) => string | undefined;
  readonly skipBrowserSetup?: boolean;
  readonly stoppedPersistentAgent?: RegisteredAgent;
  readonly restartUpdatedAgent?: (agent: RegisteredAgent) => Promise<void>;
  readonly report?: InstalledPackageUpdateReporter;
  readonly collaborators?: InstalledPackageUpdateCollaborators;
}

export interface InstalledPackageUpdateCollaborators {
  readonly runInstall?: typeof runPackageManagerWithRetry;
  readonly discover?: typeof discoverAgent;
  readonly runSetup?: typeof runAgentSetup;
  readonly resolvePackageRoot?: typeof resolveInstalledPackageRoot;
  readonly readManifest?: typeof readInstalledPackageManifest;
  readonly beginDirectoryReplacement?: typeof beginInstallDirectoryReplacement;
}

export interface InstalledPackageUpdateSuccess {
  readonly ok: true;
  readonly agent: RegisteredAgent;
  readonly commit: InstalledPackageReplacementCommitOutcome;
}

export interface InstalledPackageUpdateFailure {
  readonly ok: false;
  readonly phase: InstalledPackageUpdatePhase;
  readonly message: string;
  readonly retryCommand?: string;
  readonly rollback: InstalledPackageReplacementRollbackOutcome;
}

export type InstalledPackageUpdateOutcome =
  | InstalledPackageUpdateSuccess
  | InstalledPackageUpdateFailure;

export class AgentUpdateNameChangedError extends Error {
  constructor(currentName: string, discoveredName: string) {
    super(
      `Agent "${currentName}" 更新后的名称变为 "${discoveredName}"；` +
        "Agent 名称是 PID、lifecycle lock 和 usage lease 的稳定身份，" +
        "roll update 不支持原地改名。请先移除旧 Agent，再按新名称重新注册。",
    );
    this.name = "AgentUpdateNameChangedError";
  }
}

export function discoverUpdatedAgent(
  currentAgent: RegisteredAgent,
  agentDir: string,
  discover: typeof discoverAgent = discoverAgent,
): ReturnType<typeof discoverAgent> {
  const discovered = discover(agentDir);
  if (discovered.skill.name !== currentAgent.skill.name) {
    throw new AgentUpdateNameChangedError(currentAgent.skill.name, discovered.skill.name);
  }
  return discovered;
}

export async function updateInstalledPackage(
  input: InstalledPackageUpdateInput,
): Promise<InstalledPackageUpdateOutcome> {
  const { agent, install, store } = input;
  const report = input.report ?? (() => {});
  const collaborators = input.collaborators ?? {};
  const runInstall = collaborators.runInstall ?? runPackageManagerWithRetry;
  const discover = collaborators.discover ?? discoverAgent;
  const runSetup = collaborators.runSetup ?? runAgentSetup;
  const resolvePackageRoot = collaborators.resolvePackageRoot ?? resolveInstalledPackageRoot;
  const readManifest = collaborators.readManifest ?? readInstalledPackageManifest;
  const beginDirectoryReplacement =
    collaborators.beginDirectoryReplacement ?? beginInstallDirectoryReplacement;

  let replacement = createInstalledPackageReplacement();
  if (input.stoppedPersistentAgent !== undefined) {
    replacement = recordInstalledPackageStoppedRuntime(
      replacement,
      input.stoppedPersistentAgent,
      MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
    );
  }

  report({ type: "install-start", agentName: agent.skill.name });
  if (agent.source?.type !== "installed-package") {
    report({ type: "install-failed", agentName: agent.skill.name });
    return {
      ok: false,
      phase: INSTALLED_PACKAGE_UPDATE_PHASES.install,
      message: `Agent "${agent.skill.name}" 不是 npm 安装来源`,
      rollback: rollbackInstalledPackageReplacement(replacement, store),
    };
  }

  const packageSpec = input.resolvePackageSpec(agent);
  if (packageSpec === undefined) {
    report({ type: "install-failed", agentName: agent.skill.name });
    return {
      ok: false,
      phase: INSTALLED_PACKAGE_UPDATE_PHASES.install,
      message: `${agent.skill.name} 更新失败：无法解析 npm package spec`,
      rollback: rollbackInstalledPackageReplacement(replacement, store),
    };
  }

  try {
    replacement = recordInstalledPackageDirectoryBackup(
      replacement,
      beginDirectoryReplacement(agent.source.installDir),
    );
  } catch (error) {
    report({ type: "install-failed", agentName: agent.skill.name });
    return {
      ok: false,
      phase: INSTALLED_PACKAGE_UPDATE_PHASES.install,
      message: `无法准备安装目录替换与回滚：${errorMessage(error)}`,
      rollback: rollbackInstalledPackageReplacement(replacement, store),
    };
  }

  const installSpec: PackageManagerRunSpec = {
    command: "npm",
    args: [
      "install",
      "--prefix",
      agent.source.installDir,
      packageSpec,
      ...buildInstallNetworkArgs(install),
    ],
  };
  let packageRoot: string;
  let packageName: string;
  let installedVersion: string | undefined;
  try {
    await runInstall(
      installSpec,
      { timeout: install.networkTimeoutMs },
      {
        ...buildNpmRetryPolicy(install.fetchRetries),
        onRetry: ({ attempt, delayMs }) => {
          report({
            type: "install-retry",
            agentName: agent.skill.name,
            attempt,
            delayMs,
          });
        },
      },
    );

    packageRoot = resolvePackageRoot(agent.source.installDir, agent.source.packageName);
    if (!existsSync(packageRoot)) {
      throw new Error(`Installed package root not found: ${packageRoot}`);
    }
    const manifest = readManifest(packageRoot);
    packageName = manifest?.name ?? agent.source.packageName;
    installedVersion = manifest?.version;
    report({ type: "install-succeeded", agentName: agent.skill.name });
  } catch (error) {
    report({ type: "install-failed", agentName: agent.skill.name });
    return {
      ok: false,
      phase: INSTALLED_PACKAGE_UPDATE_PHASES.install,
      message: formatPackageManagerError(installSpec, error),
      rollback: rollbackInstalledPackageReplacement(replacement, store),
    };
  }

  let retryCommand: string | undefined;
  try {
    const discovered = discoverUpdatedAgent(agent, packageRoot, discover);
    const updatedSource = {
      ...agent.source,
      packageName,
      ...(installedVersion ? { installedVersion } : {}),
    };
    const updated: RegisteredAgent = {
      ...agent,
      skill: discovered.skill,
      transport: discovered.transport,
      runtime: discovered.runtime,
      installPath: packageRoot,
      source: updatedSource,
      ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
    };
    const setupResult = await runSetup(updated, {
      ...(input.skipBrowserSetup !== undefined ? { skipBrowserSetup: input.skipBrowserSetup } : {}),
    });
    if (!setupResult.ok) {
      retryCommand = setupResult.retryCommand;
      throw new Error(`${updated.skill.name} setup 失败：${setupResult.message}`);
    }
    if (!store.replace(agent.skill.name, updated)) {
      throw new Error(`${agent.skill.name} 已从注册表中移除，无法提交元数据刷新`);
    }
    replacement = recordInstalledPackageRegistrationReplacement(
      replacement,
      agent,
      updated.skill.name,
    );
    if (input.shouldRestart) {
      if (input.restartUpdatedAgent === undefined) {
        throw new Error(`Agent "${updated.skill.name}" 缺少更新后的 runtime 恢复器`);
      }
      await input.restartUpdatedAgent(updated);
    }

    return {
      ok: true,
      agent: updated,
      commit: commitInstalledPackageReplacement(replacement),
    };
  } catch (error) {
    return {
      ok: false,
      phase: INSTALLED_PACKAGE_UPDATE_PHASES.activate,
      message: errorMessage(error),
      ...(retryCommand ? { retryCommand } : {}),
      rollback: rollbackInstalledPackageReplacement(replacement, store),
    };
  }
}

function buildInstallNetworkArgs(install: InstallConfig): string[] {
  return npmInstallNetworkArgs({
    ...(install.registry ? { registry: install.registry } : {}),
    fetchRetries: install.fetchRetries,
    preferOffline: install.preferOffline,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
