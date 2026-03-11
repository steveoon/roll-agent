import { defineCommand } from "citty";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../../config/loader.ts";
import { discoverAgent } from "../../registry/discovery.ts";
import { AgentStore } from "../../registry/store.ts";
import { log } from "../utils/output.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

const execFileAsync = promisify(execFile);

export default defineCommand({
  meta: { description: "注册一个 Agent" },
  args: {
    path: { type: "positional", description: "Agent 本地路径", required: true },
  },
  async run({ args }) {
    const agentDir = resolve(args.path);

    if (!existsSync(agentDir)) {
      log.error(`路径不存在: ${agentDir}`);
      process.exitCode = 1;
      return;
    }

    // 1. 解析 SKILL.md
    log.info("解析 SKILL.md...");
    const discovered = discoverAgent(agentDir);
    log.debug(`名称: ${discovered.skill.name}`);
    log.debug(`描述: ${discovered.skill.description}`);
    log.debug(`传输: ${discovered.transport.type}`);

    // 2. 安装依赖（如果存在 package.json）
    const packageJsonPath = resolve(agentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      log.info("安装依赖...");
      try {
        await execFileAsync("pnpm", ["install"], { cwd: agentDir });
        log.success("依赖安装完成");
      } catch (err) {
        log.error(`依赖安装失败: ${err instanceof Error ? err.message : ""}`);
        process.exitCode = 1;
        return;
      }
    }

    // 3. 注册到 store
    const { config } = loadConfig();
    const store = new AgentStore(config.agents.dataDir);

    const agent: RegisteredAgent = {
      skill: discovered.skill,
      transport: discovered.transport,
      installPath: agentDir,
      registeredAt: new Date().toISOString(),
      status: "idle",
      ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
    };

    try {
      store.add(agent);
      log.success(`Agent "${discovered.skill.name}" 注册成功`);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
});
