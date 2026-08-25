import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { agentsConfigSchema, installConfigSchema, rollConfigSchema } from "./schema.ts";
import type { RollConfig } from "./schema.ts";
import { DEFAULT_CONFIG, CONFIG_FILE_NAMES } from "./defaults.ts";
import { decodeFromYaml } from "./key-codec.ts";
import {
  detectKnownConfigMigrations,
  formatConfigMigrationError,
  type ConfigMigrationReport,
  type ConfigMigrationScope,
} from "./migration.ts";

interface YamlLinePosition {
  readonly line: number;
  readonly col: number;
}

/**
 * 替换字符串中的 `${ENV_VAR}` 为对应环境变量值。
 * 未设置的环境变量保留原始占位符。
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (original, varName: string) => {
      const value = process.env[varName];
      return value ?? original;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (isRecord(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }
  return obj;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isYamlLinePosition(value: unknown): value is YamlLinePosition {
  return isRecord(value) && typeof value["line"] === "number" && typeof value["col"] === "number";
}

function hasYamlLinePositions(
  error: unknown,
): error is Error & { readonly linePos: readonly YamlLinePosition[] } {
  return (
    error instanceof Error &&
    "linePos" in error &&
    Array.isArray(error.linePos) &&
    error.linePos.length > 0 &&
    error.linePos.every(isYamlLinePosition)
  );
}

function formatYamlSyntaxError(configPath: string, error: unknown): string {
  const baseMessage = `Invalid YAML syntax in config file: ${configPath}`;

  if (!(error instanceof Error)) {
    return `${baseMessage}\n${String(error)}`;
  }

  if (hasYamlLinePositions(error)) {
    const [start] = error.linePos;
    if (start) {
      return `${baseMessage} at line ${start.line}, column ${start.col}\n${error.message}`;
    }
  }

  return `${baseMessage}\n${error.message}`;
}

/** 在指定目录及其父目录中查找配置文件，最后兜底用户 home 目录 */
function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  const root = resolve("/");

  while (dir !== root) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  for (const name of CONFIG_FILE_NAMES) {
    const candidate = resolve(homedir(), name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** 展开 `~` 为用户 home 目录 */
export function expandTilde(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return resolve(homedir(), filePath.slice(2));
  }
  return filePath;
}

function expandChatInstructions(value: string): string {
  return value === "auto" || value === "off" ? value : expandTilde(value);
}

/** 对配置中的路径字段做 tilde 展开 */
function expandPaths(config: RollConfig): RollConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      dataDir: expandTilde(config.agents.dataDir),
    },
    chat: {
      ...config.chat,
      instructions: expandChatInstructions(config.chat.instructions),
    },
    runtime: {
      ...config.runtime,
      threadsDir: expandTilde(config.runtime.threadsDir),
    },
    scheduler: {
      ...config.scheduler,
      dataDir: expandTilde(config.scheduler.dataDir),
    },
    skills: {
      ...config.skills,
      dirs: config.skills.dirs.map(expandTilde),
    },
    browser: {
      ...config.browser,
      instances: Object.fromEntries(
        Object.entries(config.browser.instances).map(([id, instance]) => [
          id,
          {
            ...instance,
            userDataDir: expandTilde(instance.userDataDir),
            ...(instance.sessionsDir !== undefined
              ? { sessionsDir: expandTilde(instance.sessionsDir) }
              : {}),
          },
        ]),
      ),
    },
  };
}

export interface LoadConfigOptions {
  /** 指定配置文件路径（跳过自动查找） */
  readonly configPath?: string;
  /** 起始查找目录，默认 process.cwd() */
  readonly cwd?: string;
}

export interface LoadConfigResult {
  readonly config: RollConfig;
  /** 实际加载的配置文件路径，undefined 表示使用默认配置 */
  readonly configPath: string | undefined;
}

export interface LoadAgentsConfigResult {
  readonly agentsConfig: RollConfig["agents"];
  /** 实际加载的配置文件路径，undefined 表示使用默认配置 */
  readonly configPath: string | undefined;
}

export interface LoadInstallConfigResult {
  readonly installConfig: RollConfig["install"];
  /** 实际加载的配置文件路径，undefined 表示使用默认配置 */
  readonly configPath: string | undefined;
}

const CONFIG_INSPECTION_STATUSES = {
  notFound: "not-found",
  valid: "valid",
  needsMigration: "needs-migration",
  invalid: "invalid",
} as const;

type ConfigInspectionStatus =
  (typeof CONFIG_INSPECTION_STATUSES)[keyof typeof CONFIG_INSPECTION_STATUSES];

interface ConfigInspectionBase {
  readonly status: ConfigInspectionStatus;
}

export interface ConfigInspectionNotFound extends ConfigInspectionBase {
  readonly status: typeof CONFIG_INSPECTION_STATUSES.notFound;
  readonly configPath: undefined;
}

export interface ConfigInspectionValid extends ConfigInspectionBase {
  readonly status: typeof CONFIG_INSPECTION_STATUSES.valid;
  readonly configPath: string;
  readonly config: RollConfig;
}

export interface ConfigInspectionNeedsMigration extends ConfigInspectionBase {
  readonly status: typeof CONFIG_INSPECTION_STATUSES.needsMigration;
  readonly configPath: string;
  readonly raw: string;
  readonly report: ConfigMigrationReport;
}

export interface ConfigInspectionInvalid extends ConfigInspectionBase {
  readonly status: typeof CONFIG_INSPECTION_STATUSES.invalid;
  readonly configPath: string;
  readonly raw: string;
  readonly error: Error;
}

export type ConfigInspectionResult =
  | ConfigInspectionNotFound
  | ConfigInspectionValid
  | ConfigInspectionNeedsMigration
  | ConfigInspectionInvalid;

export function parseConfigDocument(raw: string, configPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new Error(formatYamlSyntaxError(configPath, error), {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid config file: ${configPath} (expected YAML object)`);
  }

  return parsed;
}

function parseAndCheckMigrations(
  raw: string,
  configPath: string,
  options: { readonly scope?: ConfigMigrationScope } = {},
): Record<string, unknown> {
  const parsed = parseConfigDocument(raw, configPath);
  const migrationReport = detectKnownConfigMigrations(parsed, options);
  if (migrationReport.needsMigration) {
    throw new Error(formatConfigMigrationError(configPath, migrationReport));
  }
  return parsed;
}

export function validateConfigText(raw: string, configPath: string): RollConfig {
  const parsed = parseAndCheckMigrations(raw, configPath);

  const transformed = resolveEnvVars(decodeFromYaml(parsed));
  if (!isRecord(transformed)) {
    throw new Error(`Invalid config file: ${configPath} (expected YAML object)`);
  }

  const merged = deepMerge(DEFAULT_CONFIG, transformed);
  const result = rollConfigSchema.safeParse(merged);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed (${configPath}):\n${issues}`);
  }

  return expandPaths(result.data);
}

function validateAgentsConfigText(raw: string, configPath: string): RollConfig["agents"] {
  const parsed = parseAndCheckMigrations(raw, configPath, { scope: "agents" });

  const transformed = resolveEnvVars(decodeFromYaml(parsed));
  if (!isRecord(transformed)) {
    throw new Error(`Invalid config file: ${configPath} (expected YAML object)`);
  }

  const agentsSection = isRecord(transformed["agents"]) ? transformed["agents"] : {};
  const merged = deepMerge(
    DEFAULT_CONFIG.agents as unknown as Record<string, unknown>,
    agentsSection,
  );
  const result = agentsConfigSchema.safeParse(merged);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - agents.${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Config validation failed (${configPath}):\n${issues}`);
  }

  return {
    ...result.data,
    dataDir: expandTilde(result.data.dataDir),
  };
}

/**
 * 仅解析并校验 `install` 段。
 *
 * 与 {@link validateAgentsConfigText} 同理，刻意只读取一个 section，
 * 且不做 breaking schema migration 检测——即使全局配置处于待迁移状态，
 * `roll agent install` / `roll update` 的安装链路也应保持可用。
 */
function validateInstallConfigText(raw: string, configPath: string): RollConfig["install"] {
  const parsed = parseConfigDocument(raw, configPath);

  const transformed = resolveEnvVars(decodeFromYaml(parsed));
  if (!isRecord(transformed)) {
    throw new Error(`Invalid config file: ${configPath} (expected YAML object)`);
  }

  const installSection = isRecord(transformed["install"]) ? transformed["install"] : {};
  const merged = deepMerge(
    DEFAULT_CONFIG.install as unknown as Record<string, unknown>,
    installSection,
  );
  const result = installConfigSchema.safeParse(merged);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - install.${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Config validation failed (${configPath}):\n${issues}`);
  }

  return result.data;
}

/**
 * 加载 `install` 段配置（npm 安装/更新行为）。
 *
 * 解析失败（缺失文件、YAML 语法错误、install 段非法）时抛错，
 * 避免用户显式配置 registry 时因局部错误静默回退到 npm 默认源。
 */
export function loadInstallConfig(options: LoadConfigOptions = {}): LoadInstallConfigResult {
  const configPath = resolveConfigPath(options);

  if (!configPath) {
    return { installConfig: DEFAULT_CONFIG.install, configPath: undefined };
  }

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = readFileSync(configPath, "utf-8");
  return { installConfig: validateInstallConfigText(raw, configPath), configPath };
}

/**
 * 加载并校验 Roll 配置。
 *
 * 1. 查找配置文件（指定路径 > 向上查找 > 默认配置）
 * 2. 解析 YAML
 * 3. kebab-case → camelCase 键转换
 * 4. ${ENV_VAR} 环境变量替换
 * 5. Zod schema 校验
 * 6. 路径展开（~/）
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  // 1. 查找配置文件
  const configPath = resolveConfigPath(options);

  if (!configPath) {
    return { config: expandPaths(DEFAULT_CONFIG), configPath: undefined };
  }

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = readFileSync(configPath, "utf-8");
  return { config: validateConfigText(raw, configPath), configPath };
}

export function loadAgentsConfig(options: LoadConfigOptions = {}): LoadAgentsConfigResult {
  const configPath = resolveConfigPath(options);

  if (!configPath) {
    return {
      agentsConfig: {
        ...DEFAULT_CONFIG.agents,
        dataDir: expandTilde(DEFAULT_CONFIG.agents.dataDir),
      },
      configPath: undefined,
    };
  }

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = readFileSync(configPath, "utf-8");
  return { agentsConfig: validateAgentsConfigText(raw, configPath), configPath };
}

export function resolveConfigPath(options: LoadConfigOptions = {}): string | undefined {
  const { configPath, cwd = process.cwd() } = options;
  return configPath ?? findConfigFile(cwd);
}

export function inspectConfigFile(options: LoadConfigOptions = {}): ConfigInspectionResult {
  const configPath = resolveConfigPath(options);

  if (!configPath) {
    return {
      status: CONFIG_INSPECTION_STATUSES.notFound,
      configPath: undefined,
    };
  }

  if (!existsSync(configPath)) {
    return {
      status: CONFIG_INSPECTION_STATUSES.invalid,
      configPath,
      raw: "",
      error: new Error(`Config file not found: ${configPath}`),
    };
  }

  const raw = readFileSync(configPath, "utf-8");

  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfigDocument(raw, configPath);
  } catch (error) {
    return {
      status: CONFIG_INSPECTION_STATUSES.invalid,
      configPath,
      raw,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  const migrationReport = detectKnownConfigMigrations(parsed);
  if (migrationReport.needsMigration) {
    return {
      status: CONFIG_INSPECTION_STATUSES.needsMigration,
      configPath,
      raw,
      report: migrationReport,
    };
  }

  try {
    return {
      status: CONFIG_INSPECTION_STATUSES.valid,
      configPath,
      config: validateConfigText(raw, configPath),
    };
  } catch (error) {
    return {
      status: CONFIG_INSPECTION_STATUSES.invalid,
      configPath,
      raw,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** 简单的深度合并：target 中的值覆盖 defaults */
function deepMerge(
  defaults: Record<string, unknown>,
  target: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(target)) {
    const defaultValue = defaults[key];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof defaultValue === "object" &&
      defaultValue !== null &&
      !Array.isArray(defaultValue)
    ) {
      result[key] = deepMerge(
        defaultValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
