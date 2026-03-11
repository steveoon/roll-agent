import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { rollConfigSchema } from "./schema.ts";
import type { RollConfig } from "./schema.ts";
import { DEFAULT_CONFIG, CONFIG_FILE_NAMES } from "./defaults.ts";

/**
 * 将 YAML 中 kebab-case 键递归转换为 camelCase。
 * 例如 `default-provider` → `defaultProvider`
 */
function kebabToCamelDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(kebabToCamelDeep);
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      result[camelKey] = kebabToCamelDeep(value);
    }
    return result;
  }
  return obj;
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
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }
  return obj;
}

/** 在指定目录及其父目录中查找配置文件 */
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
  return undefined;
}

/** 展开 `~` 为用户 home 目录 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
    return resolve(home, filePath.slice(2));
  }
  return filePath;
}

/** 对配置中的路径字段做 tilde 展开 */
function expandPaths(config: RollConfig): RollConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      dataDir: expandTilde(config.agents.dataDir),
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
  const { configPath: explicitPath, cwd = process.cwd() } = options;

  // 1. 查找配置文件
  const configPath = explicitPath ?? findConfigFile(cwd);

  if (!configPath) {
    return { config: expandPaths(DEFAULT_CONFIG), configPath: undefined };
  }

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  // 2. 解析 YAML
  const raw = readFileSync(configPath, "utf-8");
  const parsed: unknown = parseYaml(raw);

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid config file: ${configPath} (expected YAML object)`);
  }

  // 3-4. 键转换 + 环境变量替换
  const transformed = resolveEnvVars(kebabToCamelDeep(parsed));

  // 5. Zod 校验（与默认值深度合并）
  const merged = deepMerge(DEFAULT_CONFIG, transformed as Record<string, unknown>);
  const result = rollConfigSchema.safeParse(merged);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed (${configPath}):\n${issues}`);
  }

  // 6. 路径展开
  return { config: expandPaths(result.data), configPath };
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
