import { defineCommand } from "citty";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig, parseConfigDocument, validateConfigText } from "../../config/loader.ts";

export default defineCommand({
  meta: { description: "管理全局配置" },
  args: {
    action: { type: "positional", description: "操作（init/get/set）", required: true },
    key: { type: "positional", description: "配置键（get/set 时使用，点号分隔）", required: false },
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

      console.error(`✗ 未知操作: ${args.action}。可用: init, get, set`);
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

function normalizeAnswer(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
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
    return {
      provider: normalizeAnswer(provider, "anthropic"),
      model: normalizeAnswer(model, "claude-sonnet-4-20250514"),
      apiKeyEnv: normalizeAnswer(apiKeyEnv, "ANTHROPIC_API_KEY"),
    };
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const provider = normalizeAnswer(
    await rl.question("默认 LLM provider (anthropic/openai/qwen) [anthropic]: "),
    "anthropic",
  );
  const model = normalizeAnswer(
    await rl.question("默认 model [claude-sonnet-4-20250514]: "),
    "claude-sonnet-4-20250514",
  );
  const apiKeyEnv = normalizeAnswer(
    await rl.question("API Key 环境变量名 [ANTHROPIC_API_KEY]: "),
    "ANTHROPIC_API_KEY",
  );

  rl.close();
  return { provider, model, apiKeyEnv };
}

/** 交互式初始化配置文件 */
async function initConfig(): Promise<void> {
  const configPath = resolve(process.cwd(), "roll.config.yaml");

  if (existsSync(configPath)) {
    try {
      validateConfigText(readFileSync(configPath, "utf-8"), configPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`⚠ 现有配置文件存在问题:\n${message}`);
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

  validateConfigText(yaml, configPath);
  writeFileSync(configPath, yaml, "utf-8");
  console.log(`✓ 配置文件已创建: ${configPath}`);
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

  // 支持点号路径访问：llm.defaultProvider / ask.confirmThreshold
  const parts = key.split(".");
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

/**
 * camelCase 键转换为 kebab-case（与 YAML 文件格式保持一致）。
 * 例如 `defaultProvider` → `default-provider`
 */
function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/** 设置配置值并写回 YAML 文件 */
function setConfig(key: string | undefined, value: string | undefined): void {
  if (!key || value === undefined) {
    console.error("✗ 用法: roll config set <key> <value>");
    console.error("  示例: roll config set ask.confirmThreshold 0.5");
    process.exitCode = 1;
    return;
  }

  const { configPath } = loadConfig();

  if (!configPath) {
    console.error("✗ 未找到配置文件。请先运行 roll config init");
    process.exitCode = 1;
    return;
  }

  // 读取原始 YAML 为 JS 对象
  const raw = readFileSync(configPath, "utf-8");
  const doc = parseConfigDocument(raw, configPath);

  // 按点号路径设置值（使用 kebab-case 键匹配 YAML 格式）
  const parts = key.split(".");
  let current: Record<string, unknown> = doc;

  for (let i = 0; i < parts.length - 1; i++) {
    const kebabKey = camelToKebab(parts[i] as string);
    const next = current[kebabKey];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[kebabKey] = {};
    }
    current = current[kebabKey] as Record<string, unknown>;
  }

  const lastKey = camelToKebab(parts[parts.length - 1] as string);

  // 尝试解析为数字/布尔值，否则保持字符串
  let parsed: unknown = value;
  if (value === "true") parsed = true;
  else if (value === "false") parsed = false;
  else if (/^\d+(\.\d+)?$/.test(value)) parsed = Number(value);

  current[lastKey] = parsed;

  const nextYaml = stringifyYaml(doc, { lineWidth: 0 });
  validateConfigText(nextYaml, configPath);
  writeFileSync(configPath, nextYaml, "utf-8");
  console.log(`✓ ${key} = ${String(parsed)}`);
  console.error(`  (已写入: ${configPath})`);
}
