import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { McpClientManager } from "../mcp/client-manager.ts";
import { resolveDevSpawnSpec } from "./dev-spawn.ts";
import { inferAgentSourceType } from "./source.ts";
import type { RegisteredAgent } from "../types/agent.ts";

/** PID 文件存放目录 */
function pidFilePath(dataDir: string, agentName: string): string {
  return resolve(dataDir, "pids", `${agentName}.pid`);
}

function removePidFile(dataDir: string, agentName: string): void {
  const pidFile = pidFilePath(dataDir, agentName);
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

/** Agent 日志文件路径 */
export function getAgentLogPath(dataDir: string, agentName: string): string {
  return resolve(dataDir, "logs", `${agentName}.log`);
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
    removePidFile(dataDir, agentName);
    return undefined;
  }
  return pid;
}

/** 检查 core-managed Agent 对应的 MCP endpoint 是否已就绪。 */
export async function probeAgentEndpoint(
  agent: RegisteredAgent,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const clientManager = new McpClientManager();

  try {
    const client = await clientManager.connect(
      agent.skill.name,
      agent.transport,
      agent.installPath,
      options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    );
    await client.listTools();
  } finally {
    await clientManager.disconnectAll();
  }
}

/** 轮询等待 Agent MCP endpoint 就绪。 */
export async function waitForAgentReady(
  agent: RegisteredAgent,
  options: {
    readonly startupTimeoutMs?: number;
    readonly probeTimeoutMs?: number;
    readonly intervalMs?: number;
  } = {},
): Promise<void> {
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + startupTimeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await probeAgentEndpoint(agent, { timeoutMs: probeTimeoutMs });
      return;
    } catch (err) {
      lastError = err;
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `Agent "${agent.skill.name}" did not become ready within ${startupTimeoutMs}ms${
      lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""
    }`,
  );
}

/**
 * 启动一个 Agent 为后台进程（detached）。
 *
 * - `stdio + on-demand`：保留给旧健康检查逻辑使用
 * - `streamable-http + core-managed`：作为本地常驻后台服务启动
 */
export function startAgent(
  agent: RegisteredAgent,
  dataDir: string,
  env?: Readonly<Record<string, string>>,
): number {
  if (agent.transport.type === "streamable-http" && agent.runtime.ownership !== "core-managed") {
    throw new Error(
      `Agent "${agent.skill.name}" 使用 streamable-http 传输且非 core-managed，请手动启动服务。` +
        `\n  端点: ${agent.transport.endpoint}`,
    );
  }

  const existingPid = getAgentPid(dataDir, agent.skill.name);
  if (existingPid !== undefined) {
    throw new Error(`Agent "${agent.skill.name}" 已在运行 (PID: ${String(existingPid)})`);
  }

  const spawnSpec = resolveSpawnSpec(agent);
  const logPath = getAgentLogPath(dataDir, agent.skill.name);
  const logDir = dirname(logPath);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logFd = openSync(logPath, "a");
  const child = spawn(spawnSpec.command, [...(spawnSpec.args ?? [])], {
    cwd: agent.installPath,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  closeSync(logFd);

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
  removePidFile(dataDir, agentName);

  return true;
}

export async function stopAgentGracefully(
  dataDir: string,
  agentName: string,
  options: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
  } = {},
): Promise<boolean> {
  const pid = getAgentPid(dataDir, agentName);
  if (pid === undefined) return false;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removePidFile(dataDir, agentName);
    return true;
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidFile(dataDir, agentName);
      return true;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Agent "${agentName}" did not stop within ${timeoutMs}ms`);
}

function resolveSpawnSpec(agent: RegisteredAgent): {
  readonly command: string;
  readonly args?: readonly string[];
} {
  if (agent.transport.type === "stdio") {
    const fallbackSpec = resolveDevSpawnSpec(
      agent.transport.command,
      agent.transport.args,
      agent.installPath,
      inferAgentSourceType(agent),
    );
    if (fallbackSpec) {
      return fallbackSpec;
    }

    return {
      command: agent.transport.command,
      ...(agent.transport.args ? { args: agent.transport.args } : {}),
    };
  }

  if (agent.runtime.ownership === "core-managed") {
    const fallbackSpec = resolveDevSpawnSpec(
      agent.runtime.start.command,
      agent.runtime.start.args,
      agent.installPath,
      inferAgentSourceType(agent),
    );
    if (fallbackSpec) {
      return fallbackSpec;
    }

    return {
      command: agent.runtime.start.command,
      ...(agent.runtime.start.args ? { args: agent.runtime.start.args } : {}),
    };
  }

  throw new Error(`Agent "${agent.skill.name}" does not have a managed runtime start command`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
