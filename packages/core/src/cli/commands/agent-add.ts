import { defineCommand } from "citty";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadConfig } from "../../config/loader.ts";
import { discoverAgent } from "../../registry/discovery.ts";
import { AgentStore } from "../../registry/store.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

export default defineCommand({
  meta: { description: "注册一个 Agent" },
  args: {
    path: { type: "positional", description: "Agent 本地路径", required: true },
  },
  run({ args }) {
    const agentDir = resolve(args.path);

    if (!existsSync(agentDir)) {
      console.error(`✗ 路径不存在: ${agentDir}`);
      process.exitCode = 1;
      return;
    }

    // 1. 解析 SKILL.md
    console.log("→ 解析 SKILL.md...");
    const discovered = discoverAgent(agentDir);
    console.log(`  名称: ${discovered.skill.name}`);
    console.log(`  描述: ${discovered.skill.description}`);
    console.log(`  传输: ${discovered.transport.type}`);

    // 2. 安装依赖（如果存在 package.json）
    const packageJsonPath = resolve(agentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      console.log("→ 安装依赖...");
      try {
        execSync("pnpm install", { cwd: agentDir, stdio: "pipe" });
        console.log("  ✓ 依赖安装完成");
      } catch {
        console.error("  ✗ 依赖安装失败");
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
    };

    try {
      store.add(agent);
      console.log(`✓ Agent "${discovered.skill.name}" 注册成功`);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  },
});
