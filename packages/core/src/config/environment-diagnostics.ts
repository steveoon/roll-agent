import { readFileSync } from "node:fs";
import { inspectConfigFile, parseConfigDocument, validateConfigText } from "./loader.ts";
import { auditPlaceholderResolution } from "./placeholder-audit.ts";
import { readSecretsEnvVariables } from "./secrets-env.ts";
import { inspectLlmConfigReadiness } from "./helpers.ts";
import {
  environmentDiagnosticsSchema,
  type EnvironmentDiagnostics,
  type EnvironmentIssue,
} from "./environment-diagnostic-schema.ts";

export interface EnvironmentInspectionOptions {
  readonly cwd: string;
  readonly configPath?: string;
  readonly secretsPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly environment: EnvironmentDiagnostics["environment"];
}

/** Read-only config check. Never invokes an Agent, model, Relay, or shell. */
export function inspectEnvironmentDiagnostics(
  options: EnvironmentInspectionOptions,
): EnvironmentDiagnostics {
  const issues: EnvironmentIssue[] = [];
  let configPath: string | undefined;
  let truncated = false;
  const secrets = readSecretsEnvVariables(options.secretsPath);
  if (!secrets.readable) {
    issues.push({
      code: "secrets-unreadable",
      severity: "warning",
      paths: [],
      message: "后台配置后备文件 secrets.env 无法读取。",
      remedy:
        "检查 ~/.roll-agent/secrets.env 的文件类型、属主和读取权限；macOS/Linux 建议权限为 600。",
    });
  }
  try {
    // Discovery remains identical to loadConfig. Revalidate using the environment being inspected,
    // not the UI/CLI caller's environment that inspectConfigFile may have used.
    const inspection = inspectConfigFile({
      cwd: options.cwd,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    });
    configPath = inspection.configPath;
    const raw = configPath === undefined ? "{}" : readFileSync(configPath, "utf8");
    const parsed = parseConfigDocument(raw, configPath ?? "<defaults>");
    const audit = auditPlaceholderResolution(parsed, {
      processEnv: options.env,
      secretsEnv: secrets.variables,
    });
    const selectedProviderVariables = new Set<string>();
    let blockingPath: string | undefined;
    let missingModel = false;
    let invalidConfig = false;
    try {
      const config = validateConfigText(raw, configPath ?? "<defaults>", {
        processEnv: options.env,
        fallbackEnv: secrets.variables,
      });
      const readiness = inspectLlmConfigReadiness(config, {
        provider: config.runtime.provider ?? config.llm.defaultProvider,
        model: config.runtime.model ?? config.llm.defaultModel,
      });
      // Inspect the actual provider object, not a dotted path prefix: provider names may
      // themselves contain dots, and an unrelated "custom.extra" must remain a warning.
      const rawLlm = parsed["llm"];
      const rawProviders = isRecord(rawLlm) ? rawLlm["providers"] : undefined;
      if (isRecord(rawProviders)) {
        const selectedAudit = auditPlaceholderResolution(rawProviders[readiness.provider], {
          processEnv: options.env,
          secretsEnv: secrets.variables,
        });
        for (const item of selectedAudit.unresolved) selectedProviderVariables.add(item.name);
      }
      if (!readiness.configured) {
        blockingPath = `llm.providers.${readiness.provider}.api-key`;
        missingModel = readiness.status !== "unresolved-api-key";
        if (readiness.status === "missing-provider") {
          blockingPath =
            config.runtime.provider === undefined ? "llm.default-provider" : "runtime.provider";
        }
      }
    } catch {
      invalidConfig = true;
    }
    for (const item of audit.unresolved) {
      issues.push({
        code: "env-unresolved",
        severity:
          selectedProviderVariables.has(item.name) ||
          item.paths.some(
            (path) =>
              path === blockingPath ||
              path === blockingPath?.replace(/api-key$/, "apiKey") ||
              path === blockingPath?.replace(/default-provider$/, "defaultProvider"),
          )
            ? "error"
            : "warning",
        variable: safeLabel(item.name, 160),
        paths: item.paths.slice(0, 8).map((path) => safeLabel(path, 160)),
        message: "当前检查环境无法解析配置引用的环境变量。",
        remedy:
          "为后台服务提供该变量，或写入 ~/.roll-agent/secrets.env（KEY=VALUE）；终端中的变量未必在后台可用。修正后重新检查并重启 Companion。",
      });
      truncated ||= item.paths.length > 8;
    }
    if (invalidConfig) {
      issues.push(configInvalidIssue());
    } else if (blockingPath !== undefined && !issues.some((issue) => issue.severity === "error")) {
      issues.push({
        code: missingModel ? "model-unconfigured" : "env-unresolved",
        severity: "error",
        paths: [safeLabel(blockingPath, 160)],
        message: missingModel
          ? "Runtime 当前使用的模型服务配置不完整。"
          : "Runtime 当前使用的配置仍含未解析的环境变量引用。",
        remedy:
          "检查当前 Workspace 的模型配置及后台可读取的变量来源，然后重新检查并重启 Companion。",
      });
    }
  } catch {
    // YAML/Zod/OS errors can quote input or secrets. Never copy their messages to diagnostics.
    issues.push(configInvalidIssue());
  }
  const blocking = issues.some((issue) => issue.severity === "error");
  const ordered = [
    ...issues.filter((i) => i.severity === "error"),
    ...issues.filter((i) => i.severity === "warning"),
  ];
  const report = environmentDiagnosticsSchema.parse({
    environment: options.environment,
    checkedAt: new Date().toISOString(),
    ...(configPath === undefined ? {} : { configPath: safeLabel(configPath, 1024) }),
    blocking,
    truncated: truncated || issues.length > 16,
    issues: ordered.slice(0, 16),
  });
  // Leave room for status + lastError inside the 64 KiB local control frame. Bound UTF-8 bytes,
  // not JS characters. Blocking issues precede warnings, so the cause is retained.
  while (
    Buffer.byteLength(JSON.stringify(report), "utf8") > 16 * 1024 &&
    report.issues.length > 1
  ) {
    report.issues.pop();
    report.truncated = true;
  }
  return report;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeLabel(value: string, max: number): string {
  return value.replace(/\p{Cc}/gu, " ").slice(0, max);
}

function configInvalidIssue(): EnvironmentIssue {
  return {
    code: "config-invalid",
    severity: "error",
    paths: [],
    message: "当前 Workspace 的配置无法读取、需要迁移或未通过格式校验。",
    remedy:
      "检查列出的配置文件及读取权限，在该 Workspace 运行 roll doctor；不要将完整配置或密钥粘贴到日志中。",
  };
}

export function describeEnvironmentDiagnostics(report: EnvironmentDiagnostics): string {
  return report.issues
    .map(
      (issue) =>
        `${issue.message}${issue.variable === undefined ? "" : ` 变量：${issue.variable}。`}${issue.paths.length === 0 ? "" : ` 配置：${issue.paths.join("、")}。`} ${issue.remedy}`,
    )
    .join("\n");
}
