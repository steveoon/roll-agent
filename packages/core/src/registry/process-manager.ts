import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { RegisteredAgent } from "../types/agent.ts";

/** PID 文件存放目录 */
function pidFilePath(dataDir: string, agentName: string): string {
  return resolve(dataDir, "pids", `${agentName}.pid`);
}

/** 检查进程是否仍在运行 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 读取 Agent 的 PID，如果不存在或进程已死则返回 undefined */
export function getAgentPid(dataDir: string, agentName: string): number | undefined {
  const pidFile = pidFilePath(dataDir, agentName);
  if (!existsSync(pidFile)) return undefined;

  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  if (Number.isNaN(pid) || !isProcessAlive(pid)) {
    // 清理过期的 PID 文件
    unlinkSync(pidFile);
    return undefined;
  }
  return pid;
}

/**
 * 启动一个 Agent 为后台进程（detached）。
 *
 * 仅对 stdio 模式有意义——后台运行 MCP Server。
 * Streamable HTTP Agent 应由用户自行管理（独立服务）。
 */
export function startAgent(agent: RegisteredAgent, dataDir: string): number {
  if (agent.transport.type === "streamable-http") {
    throw new Error(
      `Agent "${agent.skill.name}" 使用 streamable-http 传输，请手动启动服务。` +
        `\n  端点: ${agent.transport.endpoint}`,
    );
  }

  const existingPid = getAgentPid(dataDir, agent.skill.name);
  if (existingPid !== undefined) {
    throw new Error(`Agent "${agent.skill.name}" 已在运行 (PID: ${String(existingPid)})`);
  }

  const child = spawn(agent.transport.command, [...(agent.transport.args ?? [])], {
    cwd: agent.installPath,
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  if (!child.pid) {
    throw new Error(`Failed to start agent "${agent.skill.name}"`);
  }

  // 写入 PID 文件
  const pidFile = pidFilePath(dataDir, agent.skill.name);
  const pidDir = dirname(pidFile);
  if (!existsSync(pidDir)) {
    mkdirSync(pidDir, { recursive: true });
  }
  writeFileSync(pidFile, String(child.pid), "utf-8");

  return child.pid;
}

/** 停止一个后台运行的 Agent */
export function stopAgent(dataDir: string, agentName: string): boolean {
  const pid = getAgentPid(dataDir, agentName);
  if (pid === undefined) return false;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 进程可能已退出
  }

  // 清理 PID 文件
  const pidFile = pidFilePath(dataDir, agentName);
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }

  return true;
}
