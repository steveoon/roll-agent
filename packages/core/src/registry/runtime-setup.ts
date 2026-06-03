import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RegisteredAgent } from "../types/agent.ts";

const execFileAsync = promisify(execFile);

export interface AgentSetupOptions {
  readonly skipBrowserSetup?: boolean;
}

export interface AgentSetupResult {
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly message: string;
  readonly retryCommand?: string;
}

export async function runAgentSetup(
  agent: RegisteredAgent,
  options: AgentSetupOptions = {},
): Promise<AgentSetupResult> {
  const browsers =
    agent.runtime.ownership === "core-managed"
      ? agent.runtime.setup?.playwright?.browsers
      : undefined;

  if (!browsers || browsers.length === 0) {
    return {
      ok: true,
      skipped: true,
      message: "该 Agent 无额外 setup 步骤",
    };
  }

  if (options.skipBrowserSetup) {
    return {
      ok: true,
      skipped: true,
      message: `已跳过浏览器运行时安装 (${browsers.join(", ")})`,
    };
  }

  const cliPath = resolvePlaywrightCli(agent.installPath);
  if (!cliPath) {
    return {
      ok: false,
      skipped: false,
      message: "未找到 playwright-core CLI，无法安装浏览器运行时",
    };
  }

  try {
    await execFileAsync(process.execPath, [cliPath, "install", ...browsers], {
      cwd: agent.installPath,
      timeout: 300_000,
      // 浏览器下载日志可能超过 execFile 默认 1MB 上限，放大避免误判失败。
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      ok: true,
      skipped: false,
      message: `浏览器运行时安装完成 (${browsers.join(", ")})`,
      retryCommand: `${process.execPath} ${cliPath} install ${browsers.join(" ")}`,
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      message: err instanceof Error ? err.message : String(err),
      retryCommand: `${process.execPath} ${cliPath} install ${browsers.join(" ")}`,
    };
  }
}

function resolvePlaywrightCli(agentInstallPath: string): string | undefined {
  const packageJsonPath = resolve(agentInstallPath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const require = createRequire(packageJsonPath);
    return require.resolve("playwright-core/cli.js");
  } catch {
    return undefined;
  }
}
