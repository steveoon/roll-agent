import { defineCommand } from "citty";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../../config/loader.ts";
import { discoverAgent } from "../../registry/discovery.ts";
import { writeRemoteSkillManifest } from "../../registry/manifest.ts";
import { AgentStore } from "../../registry/store.ts";
import { log } from "../utils/output.ts";
import type { AgentSource, RegisteredAgent } from "../../types/agent.ts";

const execFileAsync = promisify(execFile);

/** 判断输入是否为 Git URL */
function isGitUrl(input: string): boolean {
  return (
    input.startsWith("https://") ||
    input.startsWith("http://") ||
    input.startsWith("git@") ||
    input.endsWith(".git")
  );
}

/** 从 Git URL 中提取仓库名作为目录名 */
function repoNameFromUrl(url: string): string {
  const last = url.split("/").pop() ?? url;
  return last.replace(/\.git$/, "");
}

export default defineCommand({
  meta: { description: "注册一个 Agent（本地路径、Git URL 或远程 endpoint）" },
  args: {
    path: { type: "positional", description: "Agent 本地路径或 Git URL", required: false },
    remote: { type: "string", description: "远程 MCP endpoint（需配合 --name/--description）" },
    name: { type: "string", description: "远程 Agent 名称" },
    description: { type: "string", description: "远程 Agent 描述" },
  },
  async run({ args }) {
    const { config } = loadConfig();
    let agentDir: string;

    if (args.remote) {
      if (!args.name || !args.description) {
        log.error("远程注册需要同时提供 --name 和 --description");
        process.exitCode = 1;
        return;
      }

      agentDir = writeRemoteSkillManifest({
        dataDir: config.agents.dataDir,
        name: args.name,
        description: args.description,
        endpoint: args.remote,
      });
    } else if (!args.path) {
      log.error("请提供本地路径、Git URL，或使用 --remote <endpoint> 注册远程 Agent");
      process.exitCode = 1;
      return;
    } else if (isGitUrl(args.path)) {
      // Git URL 模式：克隆到 dataDir 下
      const repoName = repoNameFromUrl(args.path);
      const cloneTarget = resolve(config.agents.dataDir, "repos", repoName);

      if (existsSync(cloneTarget)) {
        log.info(`仓库目录已存在，拉取最新代码: ${cloneTarget}`);
        try {
          await execFileAsync("git", ["pull"], { cwd: cloneTarget });
        } catch (err) {
          log.error(`git pull 失败: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          return;
        }
      } else {
        log.info(`克隆 ${args.path}...`);
        const parentDir = resolve(config.agents.dataDir, "repos");
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        try {
          await execFileAsync("git", ["clone", args.path, cloneTarget]);
          log.success("克隆完成");
        } catch (err) {
          log.error(`git clone 失败: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          return;
        }
      }
      agentDir = cloneTarget;
    } else {
      agentDir = resolve(args.path);
      if (!existsSync(agentDir)) {
        log.error(`路径不存在: ${agentDir}`);
        process.exitCode = 1;
        return;
      }
    }

    // 1. 解析 SKILL.md
    log.info("解析 SKILL.md...");
    const discovered = discoverAgent(agentDir);
    log.debug(`名称: ${discovered.skill.name}`);
    log.debug(`描述: ${discovered.skill.description}`);
    log.debug(`传输: ${discovered.transport.type}`);

    // 2. 安装依赖（如果存在 package.json）
    const packageJsonPath = resolve(agentDir, "package.json");
    const skipInstall = process.env["ROLL_SKIP_INSTALL"] === "1";
    if (args.remote) {
      log.info("远程 Agent 使用本地 manifest，无需安装依赖。");
    } else if (existsSync(packageJsonPath) && !skipInstall) {
      log.info("安装依赖...");
      try {
        await execFileAsync("pnpm", ["install"], { cwd: agentDir });
        log.success("依赖安装完成");
      } catch (err) {
        log.error(`依赖安装失败: ${err instanceof Error ? err.message : ""}`);
        process.exitCode = 1;
        return;
      }
    } else if (existsSync(packageJsonPath) && skipInstall) {
      log.warn("检测到 ROLL_SKIP_INSTALL=1，跳过依赖安装。");
    }

    // 3. 确定 Agent 来源
    const source: AgentSource = args.remote
      ? { type: "remote-manifest", endpoint: args.remote }
      : args.path && isGitUrl(args.path)
        ? { type: "git", url: args.path }
        : { type: "local-path", path: agentDir };

    // 4. 注册到 store
    const store = new AgentStore(config.agents.dataDir);

    const agent: RegisteredAgent = {
      skill: discovered.skill,
      transport: discovered.transport,
      runtime: discovered.runtime,
      installPath: agentDir,
      registeredAt: new Date().toISOString(),
      status: "idle",
      source,
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
