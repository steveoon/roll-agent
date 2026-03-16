import { defineCommand } from "citty";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../../config/loader.ts";
import { discoverAgent } from "../../registry/discovery.ts";
import { AgentStore } from "../../registry/store.ts";
import {
  parsePackageName,
  resolveInstalledPackageRoot,
  sanitizeInstallId,
} from "../../registry/source.ts";
import { log } from "../utils/output.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

const execFileAsync = promisify(execFile);

export default defineCommand({
  meta: { description: "安装已编译的 Agent 包并注册到本地" },
  args: {
    package: { type: "positional", description: "npm package spec", required: true },
  },
  async run({ args }) {
    const { config } = loadConfig();
    const packageSpec = args.package;
    const packageName = parsePackageName(packageSpec);
    const installDir = resolve(
      config.agents.dataDir,
      "installed",
      sanitizeInstallId(packageName),
    );

    if (!existsSync(installDir)) {
      mkdirSync(installDir, { recursive: true });
    }

    log.info(`安装 ${packageSpec}...`);
    try {
      await execFileAsync("npm", ["install", "--prefix", installDir, packageSpec], {
        timeout: 120_000,
      });
    } catch (err) {
      log.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    const packageRoot = resolveInstalledPackageRoot(installDir, packageName);
    if (!existsSync(packageRoot)) {
      log.error(`安装完成但未找到包目录: ${packageRoot}`);
      process.exitCode = 1;
      return;
    }

    log.info("解析已安装 Agent 的 SKILL.md...");
    const discovered = discoverAgent(packageRoot);
    const store = new AgentStore(config.agents.dataDir);

    const agent: RegisteredAgent = {
      skill: discovered.skill,
      transport: discovered.transport,
      installPath: packageRoot,
      registeredAt: new Date().toISOString(),
      status: "idle",
      source: {
        type: "installed",
        packageName,
        packageSpec,
        installDir,
      },
      ...(discovered.skillBody.length > 0 ? { skillBody: discovered.skillBody } : {}),
    };

    const existing = store.findByName(discovered.skill.name);
    try {
      if (existing?.source?.type === "installed") {
        store.replace(existing.skill.name, agent);
        log.success(`Agent "${discovered.skill.name}" 已更新安装并重新注册`);
        return;
      }

      store.add(agent);
      log.success(`Agent "${discovered.skill.name}" 安装并注册成功`);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
});
