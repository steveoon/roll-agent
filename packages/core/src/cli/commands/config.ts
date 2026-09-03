import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ConfigApplicationService } from "../../config/application-service.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_LLM_MODELS,
  LLM_PROVIDER_OPTIONS,
  type LlmProviderOption,
} from "../../config/defaults.ts";
import {
  inspectConfigFile,
  loadConfig,
  parseConfigDocument,
  resolveConfigPath,
} from "../../config/loader.ts";
import { createConfigRevision, type ConfigRevision } from "../../config/document-store.ts";
import { decodeFromYaml, normalizeUserPath } from "../../config/key-codec.ts";
import { applyKnownConfigMigrations } from "../../config/migration.ts";
import { explainConfig } from "./config-explain.ts";
import { runConfigSetup } from "./config-setup.ts";

export default defineCommand({
  meta: { description: "管理全局配置" },
  args: {
    action: {
      type: "positional",
      description: "操作（init/get/set/migrate/setup/explain）",
      required: true,
    },
    key: {
      type: "positional",
      description: "配置键（get/set 时使用，用英文句点 `.` 分隔，如 ask.confirm-threshold）",
      required: false,
    },
    value: { type: "positional", description: "配置值（set 时使用）", required: false },
  },
  async run({ args }) {
    try {
      if (args.action === "init") {
        await initConfig();
        return;
      }

      if (args.action === "get") {
        getConfig(args.key);
        return;
      }

      if (args.action === "set") {
        setConfig(args.key, args.value);
        return;
      }

      if (args.action === "migrate") {
        migrateConfig();
        return;
      }

      if (args.action === "setup") {
        if (!process.stdin.isTTY) {
          console.error("✗ `roll config setup` 需要交互式终端。");
          console.error(
            "  非交互环境请改用 `roll config set <key> <value>` 或直接编辑 roll.config.yaml。",
          );
          console.error("  查看配置说明：`roll config explain <key>`。");
          process.exitCode = 1;
          return;
        }
        await runConfigSetup(args.key, args.value);
        return;
      }

      if (args.action === "explain") {
        explainConfig(args.key);
        return;
      }

      console.error(`✗ 未知操作: ${args.action}。可用: init, get, set, migrate, setup, explain`);
      process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ ${message}`);
      process.exitCode = 1;
    }
  },
});

interface InitConfigAnswers {
  readonly provider: string;
  readonly model: string;
  readonly apiKeyEnv: string;
}

const INIT_API_KEY_ENV_BY_PROVIDER = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const satisfies Record<LlmProviderOption, string>;

function normalizeAnswer(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function isLlmProviderOption(value: string): value is LlmProviderOption {
  return LLM_PROVIDER_OPTIONS.some((candidate) => candidate === value);
}

function getDefaultModelForProvider(provider: string): string {
  return isLlmProviderOption(provider)
    ? DEFAULT_LLM_MODELS[provider]
    : DEFAULT_CONFIG.llm.defaultModel;
}

function getDefaultApiKeyEnvForProvider(provider: string): string {
  return isLlmProviderOption(provider)
    ? INIT_API_KEY_ENV_BY_PROVIDER[provider]
    : INIT_API_KEY_ENV_BY_PROVIDER.anthropic;
}

function buildInitialConfigYaml({ provider, model, apiKeyEnv }: InitConfigAnswers): string {
  return `llm:
  default-provider: ${provider}
  default-model: ${model}
  providers:
    ${provider}:
      api-key: \${${apiKeyEnv}}

ask:
  confirm-threshold: 0.5

agents:
  data-dir: ~/.roll-agent/agents
`;
}

async function readInitConfigAnswers(): Promise<InitConfigAnswers> {
  if (!process.stdin.isTTY) {
    const [provider, model, apiKeyEnv] = readFileSync(0, "utf-8").split(/\r?\n/u);
    const normalizedProvider = normalizeAnswer(provider, DEFAULT_CONFIG.llm.defaultProvider);
    return {
      provider: normalizedProvider,
      model: normalizeAnswer(model, getDefaultModelForProvider(normalizedProvider)),
      apiKeyEnv: normalizeAnswer(apiKeyEnv, getDefaultApiKeyEnvForProvider(normalizedProvider)),
    };
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const provider = normalizeAnswer(
    await rl.question(
      `默认 LLM provider (${LLM_PROVIDER_OPTIONS.join("/")}) [${DEFAULT_CONFIG.llm.defaultProvider}]: `,
    ),
    DEFAULT_CONFIG.llm.defaultProvider,
  );
  const defaultModel = getDefaultModelForProvider(provider);
  const model = normalizeAnswer(await rl.question(`默认 model [${defaultModel}]: `), defaultModel);
  const defaultApiKeyEnv = getDefaultApiKeyEnvForProvider(provider);
  const apiKeyEnv = normalizeAnswer(
    await rl.question(`API Key 环境变量名 [${defaultApiKeyEnv}]: `),
    defaultApiKeyEnv,
  );

  rl.close();
  return { provider, model, apiKeyEnv };
}

/** 交互式初始化配置文件 */
async function initConfig(): Promise<void> {
  const configPath = resolveConfigPath() ?? resolve(homedir(), "roll.config.yaml");
  let existingRevision: ConfigRevision | undefined;
  let requiresRawRecovery = false;

  if (existsSync(configPath)) {
    existingRevision = createConfigRevision(readFileSync(configPath, "utf-8"));
    const inspection = inspectConfigFile({ configPath });
    switch (inspection.status) {
      case "needs-migration":
        console.error(`⚠ 现有配置文件需要迁移: ${configPath}`);
        console.error("  建议先运行 `roll config migrate`，再决定是否重新初始化。");
        break;
      case "invalid":
        requiresRawRecovery = true;
        console.error(`⚠ 现有配置文件存在问题:\n${inspection.error.message}`);
        break;
    }

    console.error(`⚠ 配置文件已存在: ${configPath}`);
    if (!process.stdin.isTTY) {
      throw new Error("非交互模式下不会覆盖现有配置文件，请手动删除后重试。");
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question("是否覆盖？(y/N) ");
    rl.close();
    if (answer.toLowerCase() !== "y") {
      console.error("已取消。");
      return;
    }
  }

  const yaml = buildInitialConfigYaml(await readInitConfigAnswers());

  const service = new ConfigApplicationService({ configPath });
  const saveResult =
    existingRevision === undefined
      ? service.saveYaml(yaml)
      : requiresRawRecovery
        ? service.replaceYamlForInit(yaml, existingRevision)
        : service.saveYaml(yaml, existingRevision);
  console.log(`✓ 配置文件已创建: ${configPath}`);
  if (saveResult.backupPath !== undefined) {
    console.log(`✓ 已备份原文件: ${saveResult.backupPath}`);
  }
}

export function migrateConfig(): void {
  const inspection = inspectConfigFile();

  if (inspection.status === "not-found") {
    throw new Error("未找到配置文件。请先运行 roll config init");
  }

  if (inspection.status === "valid") {
    console.log(`✓ 配置文件已是最新格式，无需迁移: ${inspection.configPath}`);
    return;
  }

  if (inspection.status === "invalid") {
    throw inspection.error;
  }

  const document = parseConfigDocument(inspection.raw, inspection.configPath);
  const migrationResult = applyKnownConfigMigrations(document);
  if (!migrationResult.ok) {
    const issues = migrationResult.issues.map((issue) => `  - ${issue.message}`).join("\n");
    throw new Error(`配置无法自动迁移:\n${issues}`);
  }

  if (!migrationResult.changed) {
    console.log(`✓ 配置文件已是最新格式，无需迁移: ${inspection.configPath}`);
    return;
  }

  const saveResult = new ConfigApplicationService({
    configPath: inspection.configPath,
  }).saveStructured(decodeFromYaml(migrationResult.document), createConfigRevision(inspection.raw));

  console.log(`✓ 配置文件已迁移: ${inspection.configPath}`);
  if (saveResult.backupPath !== undefined) {
    console.log(`✓ 已备份原文件: ${saveResult.backupPath}`);
  }
  for (const step of migrationResult.summary) {
    console.log(`  - ${step}`);
  }
}

/** 查看配置值 */
function getConfig(key: string | undefined): void {
  const { config, configPath } = loadConfig();

  if (!key) {
    console.log(JSON.stringify(config, null, 2));
    if (configPath) {
      console.error(`(来源: ${configPath})`);
    }
    return;
  }

  const parts = normalizeUserPath(key.split("."));
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      console.error(`✗ 配置键 "${key}" 不存在`);
      process.exitCode = 1;
      return;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined) {
    console.error(`✗ 配置键 "${key}" 不存在`);
    process.exitCode = 1;
    return;
  }

  console.log(typeof current === "object" ? JSON.stringify(current, null, 2) : String(current));
}

/** 设置配置值并写回 YAML 文件 */
function setConfig(key: string | undefined, value: string | undefined): void {
  if (!key || value === undefined) {
    console.error("✗ 用法: roll config set <key> <value>");
    console.error("  示例: roll config set ask.confirm-threshold 0.5");
    process.exitCode = 1;
    return;
  }

  const { configPath } = loadConfig();

  if (!configPath) {
    console.error("✗ 未找到配置文件。请先运行 roll config init");
    process.exitCode = 1;
    return;
  }

  const path = normalizeUserPath(key.split("."));
  if (path.length === 0) {
    console.error("✗ 配置键不能为空");
    process.exitCode = 1;
    return;
  }

  // 尝试解析为数字/布尔值，否则保持字符串
  let parsed: unknown = value;
  if (value === "true") parsed = true;
  else if (value === "false") parsed = false;
  else if (/^\d+(\.\d+)?$/.test(value)) parsed = Number(value);

  const service = new ConfigApplicationService({ configPath });
  const snapshot = service.read();
  service.savePatches([{ op: "set", path, value: parsed }], snapshot.revision);
  console.log(`✓ ${key} = ${String(parsed)}`);
  console.error(`  (已写入: ${configPath})`);
}
