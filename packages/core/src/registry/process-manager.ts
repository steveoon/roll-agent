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

const RUNTIME_SIDECAR_SCHEMA_VERSION = 1 as const;
const UNKNOWN_CORE_VERSION = "unknown";
const DEFAULT_READY_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_READY_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_READY_INTERVAL_MS = 500;

export type ManagedAgentRuntimeIssueCode =
  | "missing-sidecar"
  | "invalid-sidecar"
  | "orphan-sidecar"
  | "pid-mismatch"
  | "version-mismatch"
  | "endpoint-mismatch";

export interface ManagedAgentRuntimeSidecar {
  readonly schemaVersion: typeof RUNTIME_SIDECAR_SCHEMA_VERSION;
  readonly agentName: string;
  readonly pid: number;
  readonly coreVersion: string;
  readonly startedAt: string;
  readonly endpoint?: string;
}

export interface ManagedAgentRuntimeIssue {
  readonly code: ManagedAgentRuntimeIssueCode;
  readonly message: string;
  readonly fix: string;
}

export interface ManagedAgentRuntimeInspection {
  readonly pid?: number;
  readonly sidecar?: ManagedAgentRuntimeSidecar;
  readonly expectedCoreVersion: string;
  readonly expectedEndpoint?: string;
  readonly issues: readonly ManagedAgentRuntimeIssue[];
}

/** PID 文件存放目录 */
function pidFilePath(dataDir: string, agentName: string): string {
  return resolve(dataDir, "pids", `${agentName}.pid`);
}

function runtimeSidecarPath(dataDir: string, agentName: string): string {
  return resolve(dataDir, "pids", `${agentName}.runtime.json`);
}

function removeAgentRuntimeFiles(dataDir: string, agentName: string): void {
  for (const filePath of [
    pidFilePath(dataDir, agentName),
    runtimeSidecarPath(dataDir, agentName),
  ]) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

/** 仅在没有活动 PID 时清理 runtime 元数据。 */
export function cleanupOrphanAgentRuntimeMetadata(dataDir: string, agentName: string): boolean {
  if (getAgentPid(dataDir, agentName) !== undefined) {
    return false;
  }

  removeAgentRuntimeFiles(dataDir, agentName);
  return true;
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
    removeAgentRuntimeFiles(dataDir, agentName);
    return undefined;
  }
  return pid;
}

export function getRollCoreVersion(): string {
  try {
    const packageJsonPath = resolve(import.meta.dirname, "../../package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown;
    return isRecordObject(packageJson) && typeof packageJson.version === "string"
      ? packageJson.version
      : UNKNOWN_CORE_VERSION;
  } catch {
    return UNKNOWN_CORE_VERSION;
  }
}

export function writeAgentRuntimeSidecar(
  agent: RegisteredAgent,
  dataDir: string,
  pid: number,
): void {
  const sidecarPath = runtimeSidecarPath(dataDir, agent.skill.name);
  const sidecarDir = dirname(sidecarPath);
  if (!existsSync(sidecarDir)) {
    mkdirSync(sidecarDir, { recursive: true });
  }

  const sidecar: ManagedAgentRuntimeSidecar = {
    schemaVersion: RUNTIME_SIDECAR_SCHEMA_VERSION,
    agentName: agent.skill.name,
    pid,
    coreVersion: getRollCoreVersion(),
    startedAt: new Date().toISOString(),
    ...(agent.transport.type === "streamable-http" ? { endpoint: agent.transport.endpoint } : {}),
  };
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf-8");
}

export function inspectManagedAgentRuntime(
  agent: RegisteredAgent,
  dataDir: string,
): ManagedAgentRuntimeInspection {
  const pid = getAgentPid(dataDir, agent.skill.name);
  const expectedCoreVersion = getRollCoreVersion();
  const expectedEndpoint =
    agent.transport.type === "streamable-http" ? agent.transport.endpoint : undefined;
  if (pid === undefined) {
    const sidecar = readAgentRuntimeSidecar(dataDir, agent.skill.name);
    if (sidecar !== undefined) {
      return {
        ...(sidecar !== "invalid" ? { sidecar } : {}),
        expectedCoreVersion,
        ...(expectedEndpoint ? { expectedEndpoint } : {}),
        issues: [
          {
            code: "orphan-sidecar",
            message:
              sidecar === "invalid"
                ? "runtime sidecar 存在但没有活动 PID，且无法解析"
                : `runtime sidecar 记录 PID ${String(sidecar.pid)}，但没有活动 PID`,
            fix: `运行 \`roll doctor --fix\` 清理 ${agent.skill.name} 的过期 runtime 元数据`,
          },
        ],
      };
    }

    return {
      expectedCoreVersion,
      ...(expectedEndpoint ? { expectedEndpoint } : {}),
      issues: [],
    };
  }

  const issues: ManagedAgentRuntimeIssue[] = [];
  const sidecar = readAgentRuntimeSidecar(dataDir, agent.skill.name);
  if (sidecar === "invalid") {
    issues.push({
      code: "invalid-sidecar",
      message: "runtime sidecar 无法解析",
      fix: `运行 \`roll agent stop ${agent.skill.name}\` 后重新 \`roll agent start ${agent.skill.name}\``,
    });
    return {
      pid,
      expectedCoreVersion,
      ...(expectedEndpoint ? { expectedEndpoint } : {}),
      issues,
    };
  }

  if (!sidecar) {
    issues.push({
      code: "missing-sidecar",
      message: "进程存在但缺少 runtime sidecar",
      fix: `运行 \`roll agent stop ${agent.skill.name}\` 后重新 \`roll agent start ${agent.skill.name}\``,
    });
    return {
      pid,
      expectedCoreVersion,
      ...(expectedEndpoint ? { expectedEndpoint } : {}),
      issues,
    };
  }

  if (sidecar.pid !== pid) {
    issues.push({
      code: "pid-mismatch",
      message: `runtime sidecar PID ${String(sidecar.pid)} 与活动 PID ${String(pid)} 不一致`,
      fix: `运行 \`roll agent stop ${agent.skill.name}\` 后重新 \`roll agent start ${agent.skill.name}\``,
    });
  }

  if (sidecar.coreVersion !== expectedCoreVersion) {
    issues.push({
      code: "version-mismatch",
      message: `runtime sidecar 来自 core ${sidecar.coreVersion}，当前 core 是 ${expectedCoreVersion}`,
      fix: `运行 \`roll agent stop ${agent.skill.name}\` 后重新 \`roll agent start ${agent.skill.name}\``,
    });
  }

  if (expectedEndpoint && sidecar.endpoint !== expectedEndpoint) {
    issues.push({
      code: "endpoint-mismatch",
      message: `runtime sidecar endpoint 是 ${sidecar.endpoint ?? "n/a"}，当前配置是 ${expectedEndpoint}`,
      fix: `运行 \`roll agent stop ${agent.skill.name}\` 后重新 \`roll agent start ${agent.skill.name}\``,
    });
  }

  return {
    pid,
    sidecar,
    expectedCoreVersion,
    ...(expectedEndpoint ? { expectedEndpoint } : {}),
    issues,
  };
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

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    return undefined;
  }
  return value;
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
  const startupTimeoutMs =
    readPositiveIntegerEnv("ROLL_AGENT_READY_STARTUP_TIMEOUT_MS") ??
    options.startupTimeoutMs ??
    DEFAULT_READY_STARTUP_TIMEOUT_MS;
  const probeTimeoutMs =
    readPositiveIntegerEnv("ROLL_AGENT_READY_PROBE_TIMEOUT_MS") ??
    options.probeTimeoutMs ??
    DEFAULT_READY_PROBE_TIMEOUT_MS;
  const intervalMs =
    readPositiveIntegerEnv("ROLL_AGENT_READY_INTERVAL_MS") ??
    options.intervalMs ??
    DEFAULT_READY_INTERVAL_MS;
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

  if (!child.pid) {
    throw new Error(`Failed to start agent "${agent.skill.name}"`);
  }

  // 写入 PID 文件
  const pidFile = pidFilePath(dataDir, agent.skill.name);
  const pidDir = dirname(pidFile);
  if (!existsSync(pidDir)) {
    mkdirSync(pidDir, { recursive: true });
  }
  try {
    writeFileSync(pidFile, String(child.pid), "utf-8");
    writeAgentRuntimeSidecar(agent, dataDir, child.pid);
  } catch (err) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // The child may already have exited after spawn; cleanup below still removes stale metadata.
    }
    removeAgentRuntimeFiles(dataDir, agent.skill.name);
    throw new Error(`Failed to persist runtime metadata for agent "${agent.skill.name}"`, {
      cause: err,
    });
  }

  child.unref();

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

  // 清理 PID 与 runtime sidecar
  removeAgentRuntimeFiles(dataDir, agentName);

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
    removeAgentRuntimeFiles(dataDir, agentName);
    return true;
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removeAgentRuntimeFiles(dataDir, agentName);
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

function readAgentRuntimeSidecar(
  dataDir: string,
  agentName: string,
): ManagedAgentRuntimeSidecar | "invalid" | undefined {
  const sidecarPath = runtimeSidecarPath(dataDir, agentName);
  if (!existsSync(sidecarPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath, "utf-8")) as unknown;
  } catch {
    return "invalid";
  }

  if (!isManagedAgentRuntimeSidecar(parsed)) {
    return "invalid";
  }

  return parsed;
}

function isManagedAgentRuntimeSidecar(value: unknown): value is ManagedAgentRuntimeSidecar {
  if (!isRecordObject(value)) {
    return false;
  }

  if (value.schemaVersion !== RUNTIME_SIDECAR_SCHEMA_VERSION) {
    return false;
  }

  if (
    typeof value.agentName !== "string" ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    typeof value.coreVersion !== "string" ||
    typeof value.startedAt !== "string"
  ) {
    return false;
  }

  return value.endpoint === undefined || typeof value.endpoint === "string";
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
