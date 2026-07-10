import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildNpmRetryPolicy,
  formatPackageManagerError,
  npmInstallNetworkArgs,
  runPackageManagerWithRetry,
  type PackageManagerRunSpec,
} from "../cli/utils/package-manager.ts";
import { inspectAgentEnvRequirements } from "../config/helpers.ts";
import { discoverAgent } from "./discovery.ts";
import { startAgent, stopAgentGracefully, waitForAgentReady } from "./process-manager.ts";
import { runAgentSetup } from "./runtime-setup.ts";
import {
  parsePackageName,
  readInstalledPackageManifest,
  resolveInstalledPackageRoot,
  sanitizeInstallId,
} from "./source.ts";
import { AgentStore } from "./store.ts";
import type { AgentEnvCheckReport } from "../config/helpers.ts";
import type { RollConfig } from "../config/schema.ts";
import type { DiscoveredAgent } from "./discovery.ts";
import type { RegisteredAgent } from "../types/agent.ts";

export const INSTALL_AGENT_STEPS = [
  "resolve",
  "download",
  "discover",
  "setup",
  "register",
  "start",
] as const;
export type InstallAgentStep = (typeof INSTALL_AGENT_STEPS)[number];

export type InstallAgentEvent =
  | { readonly type: "step"; readonly step: InstallAgentStep; readonly message: string }
  | { readonly type: "info"; readonly message: string }
  | { readonly type: "warn"; readonly message: string }
  | { readonly type: "success"; readonly message: string }
  | { readonly type: "retry"; readonly attempt: number; readonly delayMs: number };

export type InstallAgentReporter = (event: InstallAgentEvent) => void;

export interface InstallAgentInput {
  readonly packageSpec: string;
  readonly skipBrowserSetup?: boolean;
  readonly autoStart?: boolean;
  readonly replaceExisting?: boolean;
  readonly expectedSkillName?: string;
}

export interface InstallAgentCollaborators {
  readonly runInstall?: typeof runPackageManagerWithRetry;
  readonly discover?: typeof discoverAgent;
  readonly runSetup?: typeof runAgentSetup;
  readonly start?: typeof startAgent;
  readonly waitReady?: typeof waitForAgentReady;
  readonly stopGracefully?: typeof stopAgentGracefully;
  readonly resolvePackageRoot?: typeof resolveInstalledPackageRoot;
  readonly readManifest?: typeof readInstalledPackageManifest;
}

export interface InstallAgentDeps {
  readonly agentsConfig: RollConfig["agents"];
  readonly installConfig: RollConfig["install"];
  readonly getStartEnv: (agentName: string) => Readonly<Record<string, string>> | undefined;
  readonly store?: AgentStore;
  readonly report?: InstallAgentReporter;
  readonly collaborators?: InstallAgentCollaborators;
}

export interface InstallAgentFailure {
  readonly ok: false;
  readonly step: InstallAgentStep;
  readonly message: string;
  readonly retryCommand?: string;
}

export interface InstallAgentSuccess {
  readonly ok: true;
  readonly agent: RegisteredAgent;
  readonly envReport: AgentEnvCheckReport | undefined;
  readonly started: boolean;
}

export type InstallAgentResult = InstallAgentSuccess | InstallAgentFailure;

function buildInstallNetworkArgs(install: RollConfig["install"]): string[] {
  return npmInstallNetworkArgs({
    ...(install.registry ? { registry: install.registry } : {}),
    fetchRetries: install.fetchRetries,
    preferOffline: install.preferOffline,
  });
}

function isGitUrlSpec(input: string): boolean {
  return (
    input.startsWith("git@") ||
    input.startsWith("git+") ||
    input.startsWith("github:") ||
    input.startsWith("gitlab:") ||
    input.startsWith("bitbucket:") ||
    input.endsWith(".git")
  );
}

function isLocalDirectorySpec(input: string): boolean {
  const resolvedInputPath = resolve(input);
  return existsSync(resolvedInputPath) && statSync(resolvedInputPath).isDirectory();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceTypeLabel(agent: RegisteredAgent): string {
  return agent.source?.type ?? "unknown";
}

function buildReplaceConflictFailure(
  agentName: string,
  sourceType: string,
  packageSpec: string,
): InstallAgentFailure {
  return {
    ok: false,
    step: "register",
    message:
      `Agent "${agentName}" 已通过 ${sourceType} 来源注册。为避免覆盖本地/Git Agent，` +
      `默认不会替换为 npm 安装。请先运行 \`roll agent remove ${agentName}\`，` +
      `或确认风险后使用 \`roll agent install ${packageSpec} --force\`。`,
    retryCommand: `roll agent install ${packageSpec} --force`,
  };
}

function needsReplaceAuthorization(
  existing: RegisteredAgent | undefined,
  replaceExisting: boolean,
): boolean {
  return (
    existing !== undefined && existing.source?.type !== "installed-package" && !replaceExisting
  );
}

export async function installAgent(
  input: InstallAgentInput,
  deps: InstallAgentDeps,
): Promise<InstallAgentResult> {
  const report = deps.report ?? (() => {});
  const collaborators = deps.collaborators ?? {};
  const runInstall = collaborators.runInstall ?? runPackageManagerWithRetry;
  const discover = collaborators.discover ?? discoverAgent;
  const runSetup = collaborators.runSetup ?? runAgentSetup;
  const start = collaborators.start ?? startAgent;
  const waitReady = collaborators.waitReady ?? waitForAgentReady;
  const stopGracefully = collaborators.stopGracefully ?? stopAgentGracefully;
  const resolvePackageRoot = collaborators.resolvePackageRoot ?? resolveInstalledPackageRoot;
  const readManifest = collaborators.readManifest ?? readInstalledPackageManifest;

  const { packageSpec } = input;
  const autoStart = input.autoStart ?? true;
  const replaceExisting = input.replaceExisting ?? false;

  if (isGitUrlSpec(packageSpec)) {
    return {
      ok: false,
      step: "resolve",
      message: `Git URL 请使用 \`roll agent add ${packageSpec}\` 注册，不要使用 \`roll agent install\``,
    };
  }

  if (isLocalDirectorySpec(packageSpec)) {
    return {
      ok: false,
      step: "resolve",
      message: `本地源码目录请使用 \`roll agent add ${packageSpec}\` 注册，不要使用 \`roll agent install\``,
    };
  }

  const packageName = parsePackageName(packageSpec);
  const installDir = resolve(
    deps.agentsConfig.dataDir,
    "installed",
    sanitizeInstallId(packageName),
  );
  const store = deps.store ?? new AgentStore(deps.agentsConfig.dataDir);
  const expectedSkillName = input.expectedSkillName;
  const expectedExisting = expectedSkillName ? store.findByName(expectedSkillName) : undefined;
  if (expectedExisting && needsReplaceAuthorization(expectedExisting, replaceExisting)) {
    return buildReplaceConflictFailure(
      expectedExisting.skill.name,
      sourceTypeLabel(expectedExisting),
      packageSpec,
    );
  }

  const installDirExisted = existsSync(installDir);
  if (!installDirExisted) {
    mkdirSync(installDir, { recursive: true });
  }

  if (deps.installConfig.registry) {
    report({
      type: "info",
      message: `使用 npm registry: ${deps.installConfig.registry}（roll.config.yaml install.registry）`,
    });
  }

  report({ type: "step", step: "download", message: `安装 ${packageSpec}...` });
  const installSpec: PackageManagerRunSpec = {
    command: "npm",
    args: [
      "install",
      "--prefix",
      installDir,
      packageSpec,
      ...buildInstallNetworkArgs(deps.installConfig),
    ],
  };
  try {
    await runInstall(
      installSpec,
      { timeout: deps.installConfig.networkTimeoutMs },
      {
        ...buildNpmRetryPolicy(deps.installConfig.fetchRetries),
        onRetry: ({ attempt, delayMs }) => {
          report({ type: "retry", attempt, delayMs });
        },
      },
    );
  } catch (err) {
    return {
      ok: false,
      step: "download",
      message: `安装失败: ${formatPackageManagerError(installSpec, err)}`,
    };
  }

  const packageRoot = resolvePackageRoot(installDir, packageName);
  if (!existsSync(packageRoot)) {
    return { ok: false, step: "discover", message: `安装完成但未找到包目录: ${packageRoot}` };
  }
  const installedManifest = readManifest(packageRoot);

  report({ type: "step", step: "discover", message: "解析已安装 Agent 的 SKILL.md..." });
  let discovered: DiscoveredAgent;
  try {
    discovered = discover(packageRoot);
  } catch (err) {
    return { ok: false, step: "discover", message: errorMessage(err) };
  }

  const agent: RegisteredAgent = {
    skill: discovered.skill,
    transport: discovered.transport,
    runtime: discovered.runtime,
    installPath: packageRoot,
    registeredAt: new Date().toISOString(),
    status: "idle",
    source: {
      type: "installed-package",
      packageName: installedManifest?.name ?? packageName,
      packageSpec,
      installDir,
      ...(installedManifest?.version ? { installedVersion: installedManifest.version } : {}),
    },
    ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
  };

  const existing = store.findByName(discovered.skill.name);
  if (existing && needsReplaceAuthorization(existing, replaceExisting)) {
    if (!installDirExisted) {
      rmSync(installDir, { recursive: true, force: true });
    }
    return buildReplaceConflictFailure(
      discovered.skill.name,
      sourceTypeLabel(existing),
      packageSpec,
    );
  }

  if (
    agent.runtime.ownership === "core-managed" &&
    agent.runtime.setup?.playwright &&
    !input.skipBrowserSetup
  ) {
    report({
      type: "info",
      message: `即将安装浏览器运行时 (${agent.runtime.setup.playwright.browsers.join(", ")})，这可能需要一些时间...`,
    });
  }

  const setupResult = await runSetup(agent, {
    skipBrowserSetup: input.skipBrowserSetup ?? false,
  });
  if (setupResult.ok && !setupResult.skipped) {
    report({ type: "success", message: setupResult.message });
  } else if (setupResult.ok) {
    report({ type: "info", message: setupResult.message });
  }

  const wasRunning = existing?.runtime.ownership === "core-managed" && existing.status === "online";
  try {
    if (existing?.source?.type === "installed-package" || (existing && replaceExisting)) {
      if (existing.source?.type !== "installed-package") {
        const sourceType = existing.source?.type ?? "unknown";
        report({
          type: "info",
          message: `Agent "${discovered.skill.name}" 已通过 ${sourceType} 来源注册，将替换为 npm 安装`,
        });
      }
      store.replace(existing.skill.name, agent);
    } else {
      store.add(agent);
    }
  } catch (err) {
    return { ok: false, step: "register", message: errorMessage(err) };
  }

  if (!setupResult.ok) {
    if (wasRunning) {
      await stopGracefully(deps.agentsConfig.dataDir, agent.skill.name).catch(() => {});
    }
    store.updateStatus(discovered.skill.name, "error");
    return {
      ok: false,
      step: "setup",
      message: setupResult.message,
      ...(setupResult.retryCommand ? { retryCommand: setupResult.retryCommand } : {}),
    };
  }

  const envReport = inspectAgentEnvRequirements(
    agent.skill.name,
    discovered.skill.env,
    deps.agentsConfig.env,
  );
  const missingRequired = envReport?.missingRequired ?? [];

  let started = false;
  const shouldAttemptStart = agent.runtime.ownership === "core-managed" && autoStart;
  const canAttemptStart = shouldAttemptStart && missingRequired.length === 0;
  if (wasRunning && !canAttemptStart) {
    await stopGracefully(deps.agentsConfig.dataDir, agent.skill.name).catch(() => {});
    store.updateStatus(agent.skill.name, "idle");
  }

  if (shouldAttemptStart) {
    if (missingRequired.length > 0) {
      report({
        type: "warn",
        message: `Agent "${agent.skill.name}" 缺少必填环境变量（${missingRequired
          .map((item) => item.name)
          .join(", ")}），暂不启动。配置后运行 \`roll agent start ${agent.skill.name}\` 启动`,
      });
    } else {
      let startInvoked = false;
      try {
        if (wasRunning) {
          await stopGracefully(deps.agentsConfig.dataDir, agent.skill.name);
        }
        store.updateStatus(agent.skill.name, "starting");
        start(agent, deps.agentsConfig.dataDir, deps.getStartEnv(agent.skill.name));
        startInvoked = true;
        await waitReady(agent, { startupTimeoutMs: 15_000, probeTimeoutMs: 2_000 });
        store.updateStatus(agent.skill.name, "online");
        started = true;
      } catch (err) {
        if (startInvoked) {
          await stopGracefully(deps.agentsConfig.dataDir, agent.skill.name).catch(() => {});
        }
        store.updateStatus(agent.skill.name, "error");
        return {
          ok: false,
          step: "start",
          message: `Agent "${discovered.skill.name}" 已安装，但自动启动失败：${errorMessage(err)}`,
        };
      }
    }
  }

  return { ok: true, agent, envReport, started };
}
