import { readFileSync } from "node:fs";
import { inspectConfigFile, parseConfigDocument } from "./loader.ts";
import type { LoadConfigOptions } from "./loader.ts";
import { readSecretsEnvVariables } from "./secrets-env.ts";

const PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g;
const UNRESOLVED_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/;

export interface ConfigPlaceholder {
  readonly name: string;
  readonly paths: readonly string[];
}

export interface PlaceholderAuditOptions {
  /** 覆盖 `process.env`（测试注入用）；缺省读 `process.env` */
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  readonly secretsEnv?: Readonly<Record<string, string>>;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface PlaceholderResolutionReport {
  readonly placeholders: readonly ConfigPlaceholder[];
  readonly unresolved: readonly ConfigPlaceholder[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectConfigPlaceholders(obj: unknown): readonly ConfigPlaceholder[] {
  const byName = new Map<string, string[]>();
  const walk = (node: unknown, path: readonly string[]): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(PLACEHOLDER_PATTERN)) {
        const name = match[1];
        if (name === undefined || name.length === 0) continue;
        const paths = byName.get(name) ?? [];
        paths.push(path.join("."));
        byName.set(name, paths);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }
    if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, [...path, key]);
      }
    }
  };
  walk(obj, []);
  return [...byName.entries()].map(([name, paths]) => ({ name, paths }));
}

function makeResolver(
  sources: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>,
): (name: string) => boolean {
  return (name) => {
    for (const source of sources) {
      const value = source?.[name];
      if (value === undefined || value.length === 0) continue;
      return !UNRESOLVED_PLACEHOLDER_PATTERN.test(value);
    }
    return false;
  };
}

/** 调度服务（launchd/schtasks）通常提供的基线变量；刻意不含用户 .zshrc 里的变量 */
const SCHEDULED_SERVICE_BASELINE_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
] as const;

/**
 * 构造"调度服务环境"的近似：只保留服务管理器通常提供的基线变量，
 * 用于审计占位符在定时任务进程里能否解析（交互 shell 的变量不会漏报）。
 */
export function buildScheduledServiceBaselineEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const baseline: Record<string, string> = {};
  for (const key of SCHEDULED_SERVICE_BASELINE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) {
      baseline[key] = value;
    }
  }
  return baseline;
}

/**
 * 审计（未做 `resolveEnvVars` 的）配置对象里所有 `${ENV_VAR}` 占位符的解析状态。
 * 判定顺序：选择 `processEnv`（默认 `process.env`）→ `secretsEnv` → `extraEnv`
 * 中第一个非空值；空串视为未设置。被选中的值若仍含 `${...}`，按未解析处理，
 * 且不会继续回退到低优先级来源，与配置加载的一次替换语义保持一致。
 */
export function auditPlaceholderResolution(
  obj: unknown,
  options: PlaceholderAuditOptions = {},
): PlaceholderResolutionReport {
  const placeholders = collectConfigPlaceholders(obj);
  const resolved = makeResolver([
    options.processEnv ?? process.env,
    options.secretsEnv,
    options.extraEnv,
  ]);
  return {
    placeholders,
    unresolved: placeholders.filter((placeholder) => !resolved(placeholder.name)),
  };
}

export interface ScheduledServicePlaceholderAudit {
  readonly unresolved: readonly ConfigPlaceholder[];
  readonly placeholderTotal: number;
  readonly secretsReadable: boolean;
}

export interface ScheduledServiceAuditOptions {
  readonly loadOptions?: LoadConfigOptions;
  readonly secretsPath?: string;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * 定位配置文件并审计其中 `${ENV_VAR}` 占位符在调度服务（launchd/schtasks）环境
 * （基线变量 + secrets.env）下的解析状态。配置不存在或无法解析时返回 undefined，
 * 由既有的配置检查负责报告。
 */
export function auditScheduledServicePlaceholders(
  options: ScheduledServiceAuditOptions = {},
): ScheduledServicePlaceholderAudit | undefined {
  const secrets = readSecretsEnvVariables(options.secretsPath);
  try {
    const inspection = inspectConfigFile(options.loadOptions);
    let raw: string | undefined;
    let configPath: string | undefined;
    if (inspection.status === "valid") {
      configPath = inspection.configPath;
      if (configPath !== undefined) {
        raw = readFileSync(configPath, "utf-8");
      }
    } else if (
      (inspection.status === "needs-migration" || inspection.status === "invalid") &&
      "raw" in inspection
    ) {
      raw = inspection.raw;
      configPath = inspection.configPath;
    }
    if (raw === undefined || configPath === undefined) {
      return undefined;
    }
    const parsed = parseConfigDocument(raw, configPath);
    const report = auditPlaceholderResolution(parsed, {
      processEnv: buildScheduledServiceBaselineEnv(options.processEnv ?? process.env),
      secretsEnv: secrets.variables,
    });
    return {
      unresolved: report.unresolved,
      placeholderTotal: report.placeholders.length,
      secretsReadable: secrets.readable,
    };
  } catch {
    return undefined;
  }
}
