import { defineCommand } from "citty";
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../../config/loader.ts";

export default defineCommand({
  meta: { description: "管理全局配置" },
  args: {
    action: { type: "positional", description: "操作（init/get）", required: true },
    key: { type: "positional", description: "配置键（get 时使用）", required: false },
  },
  async run({ args }) {
    if (args.action === "init") {
      await initConfig();
      return;
    }

    if (args.action === "get") {
      getConfig(args.key);
      return;
    }

    console.error(`✗ 未知操作: ${args.action}。可用: init, get`);
    process.exitCode = 1;
  },
});

/** 交互式初始化配置文件 */
async function initConfig(): Promise<void> {
  const configPath = resolve(process.cwd(), "roll.config.yaml");

  if (existsSync(configPath)) {
    console.error(`⚠ 配置文件已存在: ${configPath}`);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question("是否覆盖？(y/N) ");
    rl.close();
    if (answer.toLowerCase() !== "y") {
      console.error("已取消。");
      return;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const provider = (await rl.question("默认 LLM provider (anthropic/openai/qwen) [anthropic]: ")) || "anthropic";
  const model = (await rl.question("默认 model [claude-sonnet-4-20250514]: ")) || "claude-sonnet-4-20250514";
  const apiKeyEnv = (await rl.question("API Key 环境变量名 [ANTHROPIC_API_KEY]: ")) || "ANTHROPIC_API_KEY";

  rl.close();

  const yaml = `llm:
  default-provider: ${provider}
  default-model: ${model}
  providers:
    ${provider}:
      api-key: \${${apiKeyEnv}}

router:
  mode: declarative

agents:
  data-dir: ~/.roll-agent/agents
`;

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

  // 支持点号路径访问：llm.defaultProvider
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
