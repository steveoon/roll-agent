import { defineCommand } from "citty";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { getAgentEnvFromAgentsConfig, inspectAgentEnvRequirements } from "../../config/helpers.ts";
import {
  inspectConfigFile,
  loadAgentsConfig,
  loadConfig,
  parseConfigDocument,
  validateConfigText,
  type ConfigInspectionNeedsMigration,
} from "../../config/loader.ts";
import { applyKnownConfigMigrations } from "../../config/migration.ts";
import {
  inspectAgentRuntimeEnvRequirements,
  summarizeAgentRuntimeEnvReport,
} from "../../config/runtime-env.ts";
import { inspectAgentRuntimeEnv } from "../../mcp/agent-diagnostics.ts";
import {
  cleanupOrphanAgentRuntimeMetadata,
  inspectManagedAgentRuntime,
} from "../../registry/process-manager.ts";
import { AgentStore } from "../../registry/store.ts";

export interface CheckResult {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly message: string;
  readonly fix?: string;
}

export interface DoctorFixResult {
  readonly name: string;
  readonly status: "applied" | "skipped" | "failed";
  readonly message: string;
}

const STATUS_ICONS: Record<CheckResult["status"], string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

const FIX_STATUS_ICONS: Record<DoctorFixResult["status"], string> = {
  applied: "✓",
  skipped: "•",
  failed: "✗",
};

const MIN_NODE_VERSION = { major: 22, minor: 6, patch: 0 } as const;

export function isNodeVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (major > MIN_NODE_VERSION.major) return true;
  if (major < MIN_NODE_VERSION.major) return false;

  if (minor > MIN_NODE_VERSION.minor) return true;
  if (minor < MIN_NODE_VERSION.minor) return false;

  return patch >= MIN_NODE_VERSION.patch;
}

export default defineCommand({
  meta: { description: "诊断 Roll 配置、Agent 注册表和运行时状态" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
    "fix-plan": {
      type: "boolean",
      description: "输出可执行修复建议（不自动修改）",
      default: false,
    },
    fix: {
      type: "boolean",
      description: "执行安全自动修复：配置自动迁移、创建 dataDir、清理孤儿 runtime 元数据",
      default: false,
    },
  },
  async run({ args }) {
    const checks: CheckResult[] = [];
    const fixResults: DoctorFixResult[] = [];
    const shouldFix = args.fix === true;
    let effectiveConfig: ReturnType<typeof loadConfig>["config"] | undefined;

    // 1. Node.js 版本
    const nodeVersion = process.versions.node;
    checks.push(
      isNodeVersionSupported(nodeVersion)
        ? { name: "Node.js 版本", status: "ok", message: `v${nodeVersion}` }
        : {
            name: "Node.js 版本",
            status: "fail",
            message: `v${nodeVersion} (需要 ≥22.6.0)`,
            fix: "升级 Node.js 到 22.6.0 或更高版本",
          },
    );

    // 2. 配置文件（只加载一次，后续复用）
    let configInspection = inspectConfigFile();
    let fullConfig: ReturnType<typeof loadAgentsConfig>["agentsConfig"] | undefined;

    if (configInspection.status === "needs-migration" && shouldFix) {
      const fixResult = applyConfigMigrationFix(configInspection);
      fixResults.push(fixResult);
      if (fixResult.status === "applied") {
        configInspection = inspectConfigFile();
      }
    }

    switch (configInspection.status) {
      case "not-found":
        checks.push({
          name: "配置文件",
          status: "warn",
          message: "未找到，使用默认配置",
          fix: "运行 `roll config init` 生成显式配置文件",
        });
        effectiveConfig = loadConfig().config;
        break;
      case "valid":
        checks.push({ name: "配置文件", status: "ok", message: configInspection.configPath });
        effectiveConfig = configInspection.config;
        break;
      case "needs-migration":
        checks.push({
          name: "配置文件",
          status: "warn",
          message: `${configInspection.configPath} (需要迁移，运行 roll config migrate)`,
          fix: "运行 `roll config migrate`，确认备份文件后提交配置变更",
        });
        break;
      case "invalid":
        checks.push({
          name: "配置文件",
          status: "fail",
          message: configInspection.error.message,
          fix: "修正配置文件语法或运行 `roll config migrate` 处理 breaking schema change",
        });
        break;
    }

    try {
      fullConfig = loadAgentsConfig().agentsConfig;
    } catch (err) {
      checks.push({
        name: "Agent 配置",
        status: "fail",
        message: err instanceof Error ? err.message : String(err),
        fix: "检查 `roll.config.yaml` 的 `agents` 段；如配置版本过旧，运行 `roll config migrate`",
      });
    }

    // 3. LLM Provider 配置
    if (effectiveConfig) {
      const providers = Object.keys(effectiveConfig.llm.providers);
      if (providers.length > 0) {
        // 检查 API key 是否像是未解析的环境变量
        const unresolved = providers.filter((p) => {
          const key = effectiveConfig.llm.providers[p]?.apiKey ?? "";
          return key.startsWith("${") || key.length === 0;
        });
        if (unresolved.length > 0) {
          checks.push({
            name: "LLM Providers",
            status: "warn",
            message: `${providers.join(", ")} (${unresolved.join(", ")} API key 未设置)`,
            fix: `配置 ${unresolved.map((provider) => `llm.providers.${provider}.apiKey`).join(", ")} 或对应环境变量`,
          });
        } else {
          checks.push({
            name: "LLM Providers",
            status: "ok",
            message: providers.join(", "),
          });
        }
      } else {
        checks.push({
          name: "LLM Providers",
          status: "warn",
          message: "未配置任何 provider",
          fix: "运行 `roll config init` 或手动配置 `llm.providers`",
        });
      }
    } else if (configInspection.status === "needs-migration") {
      checks.push({
        name: "LLM Providers",
        status: "warn",
        message: "配置需要迁移，跳过完整 LLM 配置校验",
        fix: "先运行 `roll config migrate`，再重新执行 `roll doctor`",
      });
    }

    if (fullConfig) {
      // 4. Agent 数据目录
      const dataDir = fullConfig.dataDir;
      let dataDirExists = existsSync(dataDir);
      if (!dataDirExists && shouldFix) {
        const fixResult = createDataDirFix(dataDir);
        fixResults.push(fixResult);
        dataDirExists = existsSync(dataDir);
      }

      checks.push(
        dataDirExists
          ? { name: "Agent 数据目录", status: "ok", message: dataDir }
          : {
              name: "Agent 数据目录",
              status: "warn",
              message: `${dataDir} (不存在，首次 add 时创建)`,
              fix: "运行 `roll doctor --fix` 创建目录，或手动创建该目录",
            },
      );

      // 5. 已注册 Agent
      const store = new AgentStore(fullConfig.dataDir);
      const agents = store.list();
      checks.push({
        name: "已注册 Agent",
        status: agents.length > 0 ? "ok" : "warn",
        message:
          agents.length > 0
            ? `${String(agents.length)} 个 (${agents.map((a) => a.skill.name).join(", ")})`
            : "无",
        ...(agents.length === 0 ? { fix: "运行 `roll agent add <path|git-url>` 注册 Agent" } : {}),
      });

      for (const agent of agents) {
        if (agent.runtime.ownership === "core-managed") {
          let managedRuntime = inspectManagedAgentRuntime(agent, fullConfig.dataDir);
          if (shouldFix && managedRuntime.issues.some((issue) => issue.code === "orphan-sidecar")) {
            const fixResult = cleanupOrphanRuntimeMetadataFix(fullConfig.dataDir, agent.skill.name);
            fixResults.push(fixResult);
            if (fixResult.status === "applied") {
              managedRuntime = inspectManagedAgentRuntime(agent, fullConfig.dataDir);
            }
          }

          if (managedRuntime.pid !== undefined || managedRuntime.issues.length > 0) {
            checks.push({
              name: `Agent runtime (${agent.skill.name})`,
              status: managedRuntime.issues.length > 0 ? "warn" : "ok",
              message:
                managedRuntime.issues.length > 0
                  ? managedRuntime.issues.map((issue) => issue.message).join("；")
                  : `PID ${String(managedRuntime.pid)}，runtime sidecar 与当前配置一致`,
              ...(managedRuntime.issues.length > 0
                ? { fix: uniqueFixes(managedRuntime.issues.map((issue) => issue.fix)).join("；") }
                : {}),
            });
          }
        }

        const envReport = inspectAgentEnvRequirements(
          agent.skill.name,
          agent.skill.env,
          fullConfig.env,
        );
        if (!envReport) {
          continue;
        }

        const runtimeInspection = await inspectAgentRuntimeEnv(agent, { agentsConfig: fullConfig });
        const runtimeReport = inspectAgentRuntimeEnvRequirements(
          envReport,
          getAgentEnvFromAgentsConfig(fullConfig, agent.skill.name),
          runtimeInspection,
        );
        const summary = summarizeAgentRuntimeEnvReport(runtimeReport);
        checks.push({
          name: `Agent 环境变量 (${agent.skill.name})`,
          status: summary.status,
          message: summary.message,
          ...(summary.status === "ok"
            ? {}
            : {
                fix: `在 \`roll.config.yaml\` 的 \`agents.env.${agent.skill.name}\` 或 shell 环境中配置缺失变量`,
              }),
        });
      }
    }

    const hasFailure = checks.some((c) => c.status === "fail");
    const hasFailedFix = fixResults.some((fix) => fix.status === "failed");
    const hasWarning = checks.some((c) => c.status === "warn");
    const shouldPrintFixPlan = args["fix-plan"] === true || shouldFix;

    // 输出
    if (args.json) {
      const payload = shouldFix
        ? formatDoctorJsonOutput(checks, {
            fixPlan: shouldPrintFixPlan,
            fixes: fixResults,
          })
        : formatDoctorChecksForJsonOutput(checks, { fixPlan: shouldPrintFixPlan });
      console.log(JSON.stringify(payload, null, 2));
      if (hasFailure || hasFailedFix) {
        process.exitCode = 1;
      }
      return;
    }

    console.log("Roll Agent 系统诊断\n");
    for (const check of checks) {
      for (const line of formatDoctorCheckLines(check, { fixPlan: shouldPrintFixPlan })) {
        console.log(line);
      }
    }

    if (shouldFix) {
      console.log("\nFix 执行结果\n");
      if (fixResults.length === 0) {
        console.log("  ✓ 无可自动修复项");
      } else {
        for (const fix of fixResults) {
          for (const line of formatDoctorFixLines(fix)) {
            console.log(line);
          }
        }
      }
    }

    console.log(
      hasFailure || hasFailedFix
        ? "\n存在问题，请修复后重试。"
        : hasWarning
          ? "\n存在警告，可按 fix plan 处理。"
          : "\n系统状态正常。",
    );

    if (hasFailure || hasFailedFix) {
      process.exitCode = 1;
    }
  },
});

export function formatDoctorCheckLines(
  check: CheckResult,
  options: { readonly fixPlan: boolean },
): string[] {
  const icon = STATUS_ICONS[check.status];
  const lines = [`  ${icon} ${check.name}: ${check.message}`];
  if (options.fixPlan && check.fix) {
    lines.push(`      fix: ${check.fix}`);
  }
  return lines;
}

export function formatDoctorChecksForJsonOutput(
  checks: readonly CheckResult[],
  options: { readonly fixPlan: boolean },
): readonly CheckResult[] {
  if (options.fixPlan) {
    return checks;
  }

  return checks.map((check) => ({
    name: check.name,
    status: check.status,
    message: check.message,
  }));
}

export function formatDoctorJsonOutput(
  checks: readonly CheckResult[],
  options: {
    readonly fixPlan: boolean;
    readonly fixes: readonly DoctorFixResult[];
  },
): { readonly checks: readonly CheckResult[]; readonly fixes: readonly DoctorFixResult[] } {
  return {
    checks: formatDoctorChecksForJsonOutput(checks, { fixPlan: options.fixPlan }),
    fixes: options.fixes,
  };
}

export function formatDoctorFixLines(fix: DoctorFixResult): string[] {
  const icon = FIX_STATUS_ICONS[fix.status];
  return [`  ${icon} ${fix.name}: ${fix.message}`];
}

function applyConfigMigrationFix(inspection: ConfigInspectionNeedsMigration): DoctorFixResult {
  if (!inspection.report.canAutoMigrate) {
    return {
      name: "配置迁移",
      status: "skipped",
      message: "检测到需要人工处理的配置迁移项，未自动修改",
    };
  }

  try {
    const document = parseConfigDocument(inspection.raw, inspection.configPath);
    const migrationResult = applyKnownConfigMigrations(document);
    if (!migrationResult.ok) {
      return {
        name: "配置迁移",
        status: "skipped",
        message: `无法自动迁移：${formatMigrationIssues(migrationResult.issues)}`,
      };
    }

    if (!migrationResult.changed) {
      return {
        name: "配置迁移",
        status: "skipped",
        message: "配置文件已是最新格式",
      };
    }

    const nextYaml = stringifyYaml(migrationResult.document, { lineWidth: 0 });
    validateConfigText(nextYaml, inspection.configPath);

    const backupPath = buildBackupPath(inspection.configPath);
    writeFileSync(backupPath, inspection.raw, "utf-8");
    writeFileSync(inspection.configPath, nextYaml, "utf-8");

    return {
      name: "配置迁移",
      status: "applied",
      message: `已迁移 ${inspection.configPath}，备份 ${backupPath}`,
    };
  } catch (err) {
    return {
      name: "配置迁移",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function createDataDirFix(dataDir: string): DoctorFixResult {
  try {
    mkdirSync(dataDir, { recursive: true });
    return {
      name: "Agent 数据目录",
      status: "applied",
      message: `已创建 ${dataDir}`,
    };
  } catch (err) {
    return {
      name: "Agent 数据目录",
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function cleanupOrphanRuntimeMetadataFix(dataDir: string, agentName: string): DoctorFixResult {
  try {
    const cleaned = cleanupOrphanAgentRuntimeMetadata(dataDir, agentName);
    if (!cleaned) {
      return {
        name: `Agent runtime (${agentName})`,
        status: "skipped",
        message: "检测到活动 PID，跳过 runtime 元数据清理",
      };
    }

    return {
      name: `Agent runtime (${agentName})`,
      status: "applied",
      message: "已清理孤儿 runtime 元数据",
    };
  } catch (err) {
    return {
      name: `Agent runtime (${agentName})`,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildBackupPath(configPath: string): string {
  const now = new Date();
  const timestamp = [
    now.getFullYear().toString().padStart(4, "0"),
    (now.getMonth() + 1).toString().padStart(2, "0"),
    now.getDate().toString().padStart(2, "0"),
    "-",
    now.getHours().toString().padStart(2, "0"),
    now.getMinutes().toString().padStart(2, "0"),
    now.getSeconds().toString().padStart(2, "0"),
  ].join("");
  return `${configPath}.bak.${timestamp}`;
}

function formatMigrationIssues(issues: readonly { readonly message: string }[]): string {
  return issues.map((issue) => issue.message).join("；");
}

function uniqueFixes(fixes: readonly string[]): string[] {
  return [...new Set(fixes)];
}
