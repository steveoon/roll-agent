import spawn from "cross-spawn";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { McpClientManager } from "../mcp/client-manager.ts";
import { readJsonFile } from "./json-file.ts";
import {
  isProcessStartToken,
  readProcessStartToken,
  verifyProcessStartToken,
  type ProcessStartToken,
} from "./process-identity.ts";
import { resolveDevSpawnSpec } from "./dev-spawn.ts";
import { inferAgentSourceType } from "./source.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import { omitScheduleInvocationEnv } from "../scheduler-host/paths.ts";

const LEGACY_RUNTIME_SIDECAR_SCHEMA_VERSION = 2 as const;
const RUNTIME_SIDECAR_SCHEMA_VERSION = 3 as const;
const UNKNOWN_CORE_VERSION = "unknown";
const DEFAULT_READY_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_READY_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const DEFAULT_PROBE_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_LIST_TOOLS_TIMEOUT_MS = 60_000;
const AGENT_LIFECYCLE_LOCK_STALE_MS = 5 * 60_000;

export const MANAGED_AGENT_RUNTIME_RETENTIONS = {
  persistent: "persistent",
  leaseBound: "lease-bound",
} as const;
export type ManagedAgentRuntimeRetention =
  (typeof MANAGED_AGENT_RUNTIME_RETENTIONS)[keyof typeof MANAGED_AGENT_RUNTIME_RETENTIONS];

export interface AgentLifecycleLock {
  release(): void;
}

interface AgentLifecycleLockState {
  readonly dataDir: string;
  readonly agentName: string;
  readonly lockPath: string;
  readonly token: string;
  released: boolean;
}

interface AgentLifecycleLockFile {
  readonly pid: number;
  readonly processStartToken: ProcessStartToken;
  readonly token: string;
  readonly createdAtMs: number;
}

const agentLifecycleLockStates = new WeakMap<AgentLifecycleLock, AgentLifecycleLockState>();

export class AgentLifecycleBusyError extends Error {
  readonly code = "agent_lifecycle_busy" as const;

  constructor(agentName: string) {
    super(`Agent "${agentName}" 正在执行另一项生命周期操作，请稍后重试。`);
    this.name = "AgentLifecycleBusyError";
  }
}

export class AgentRuntimeIdentityError extends Error {
  readonly code = "agent_runtime_identity_unverifiable" as const;
  readonly pid: number;

  constructor(agentName: string, pid: number, reason: string) {
    super(
      `Agent "${agentName}" 的 runtime 身份无法安全验证 (PID: ${String(pid)})：${reason}` +
        "。为避免停止无关进程，Roll 未发送信号且保留了 runtime 元数据。" +
        `请先用系统工具确认并手动停止 PID ${String(pid)}，再运行 \`roll doctor --fix\` 清理过期元数据。`,
    );
    this.name = "AgentRuntimeIdentityError";
    this.pid = pid;
  }
}

export type ManagedAgentRuntimeIssueCode =
  | "missing-sidecar"
  | "invalid-sidecar"
  | "orphan-sidecar"
  | "agent-name-mismatch"
  | "pid-mismatch"
  | "process-identity-unavailable"
  | "process-identity-mismatch"
  | "version-mismatch"
  | "endpoint-mismatch";

export interface ManagedAgentRuntimeIdentity {
  readonly pid: number;
  readonly processStartToken: ProcessStartToken;
  readonly startedAt: string;
}

export interface ManagedAgentRuntimeSidecar extends ManagedAgentRuntimeIdentity {
  readonly schemaVersion:
    | typeof LEGACY_RUNTIME_SIDECAR_SCHEMA_VERSION
    | typeof RUNTIME_SIDECAR_SCHEMA_VERSION;
  readonly agentName: string;
  readonly coreVersion: string;
  readonly retention: ManagedAgentRuntimeRetention;
  readonly endpoint?: string;
}

export interface VerifiedManagedAgentRuntime {
  readonly identity: ManagedAgentRuntimeIdentity;
  readonly retention: ManagedAgentRuntimeRetention;
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

function lifecycleLockPath(dataDir: string, agentName: string): string {
  const digest = createHash("sha256").update(agentName).digest("hex");
  return resolve(dataDir, "pids", `.${digest}.lifecycle.lock`);
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
  const lifecycleLock = acquireAgentLifecycleLock(dataDir, agentName);
  try {
    if (getAgentPid(dataDir, agentName) !== undefined) {
      return false;
    }

    removeAgentRuntimeFiles(dataDir, agentName);
    return true;
  } finally {
    lifecycleLock.release();
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
  } catch (error) {
    return isErrnoCode(error, "EPERM");
  }
}

/** 只读检查 Agent PID；过期元数据必须在持有 lifecycle lock 的清理路径中删除。 */
export function getAgentPid(dataDir: string, agentName: string): number | undefined {
  const pidFile = pidFilePath(dataDir, agentName);
  const pid = readRecordedPid(pidFile);
  return pid !== undefined && isProcessAlive(pid) ? pid : undefined;
}

export function getRollCoreVersion(): string {
  try {
    const packageJsonPath = resolve(import.meta.dirname, "../../package.json");
    const packageJson = readJsonFile(packageJsonPath);
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
  options: {
    readonly retention?: ManagedAgentRuntimeRetention;
  } = {},
): void {
  const processStartToken = readProcessStartToken(pid);
  if (processStartToken === undefined) {
    throw new AgentRuntimeIdentityError(agent.skill.name, pid, "无法读取 OS 进程启动身份");
  }
  const sidecarPath = runtimeSidecarPath(dataDir, agent.skill.name);
  const sidecarDir = dirname(sidecarPath);
  if (!existsSync(sidecarDir)) {
    mkdirSync(sidecarDir, { recursive: true });
  }

  const sidecar: ManagedAgentRuntimeSidecar = {
    schemaVersion: RUNTIME_SIDECAR_SCHEMA_VERSION,
    agentName: agent.skill.name,
    pid,
    processStartToken,
    coreVersion: getRollCoreVersion(),
    startedAt: new Date().toISOString(),
    retention: options.retention ?? MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
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
      fix: manualRuntimeIdentityFix(agent.skill.name, pid),
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
      fix: manualRuntimeIdentityFix(agent.skill.name, pid),
    });
    return {
      pid,
      expectedCoreVersion,
      ...(expectedEndpoint ? { expectedEndpoint } : {}),
      issues,
    };
  }

  if (sidecar.agentName !== agent.skill.name) {
    issues.push({
      code: "agent-name-mismatch",
      message: `runtime sidecar Agent 名称 ${sidecar.agentName} 与当前 Agent ${agent.skill.name} 不一致`,
      fix: manualRuntimeIdentityFix(agent.skill.name, pid),
    });
  }

  if (sidecar.pid !== pid) {
    issues.push({
      code: "pid-mismatch",
      message: `runtime sidecar PID ${String(sidecar.pid)} 与活动 PID ${String(pid)} 不一致`,
      fix: manualRuntimeIdentityFix(agent.skill.name, pid),
    });
  }

  if (sidecar.pid === pid) {
    const verification = verifyProcessStartToken(pid, sidecar.processStartToken);
    switch (verification.status) {
      case "match":
        break;
      case "mismatch":
        issues.push({
          code: "process-identity-mismatch",
          message: `PID ${String(pid)} 当前属于另一个进程实例，runtime 元数据已过期`,
          fix: manualRuntimeIdentityFix(agent.skill.name, pid),
        });
        break;
      case "unavailable":
        issues.push({
          code: "process-identity-unavailable",
          message: `无法可靠验证 PID ${String(pid)} 的 OS 进程启动身份：${verification.reason}`,
          fix: manualRuntimeIdentityFix(agent.skill.name, pid),
        });
        break;
    }
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

function manualRuntimeIdentityFix(agentName: string, pid: number): string {
  return (
    `先用系统工具确认并手动停止 PID ${String(pid)}，` +
    `再运行 \`roll doctor --fix\` 清理 ${agentName} 的过期 runtime 元数据`
  );
}

class AgentProbeCleanupError extends AggregateError {
  constructor(agentName: string, errors: readonly unknown[]) {
    super(errors, `Agent "${agentName}" endpoint probe failed to clean up its MCP connection.`);
    this.name = "AgentProbeCleanupError";
  }
}

/** 检查 core-managed Agent 对应的 MCP endpoint 是否已就绪。 */
export async function probeAgentEndpoint(
  agent: RegisteredAgent,
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const clientManager = new McpClientManager();
  const deadline =
    options.timeoutMs === undefined ? undefined : Date.now() + Math.max(0, options.timeoutMs);
  let probeFailure: { readonly error: unknown } | undefined;

  try {
    const client = await clientManager.connect(
      agent.skill.name,
      agent.transport,
      agent.installPath,
      {
        timeoutMs: requestTimeoutMs(DEFAULT_PROBE_CONNECT_TIMEOUT_MS, deadline),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    options.signal?.throwIfAborted();
    await client.listTools(undefined, {
      timeout: requestTimeoutMs(DEFAULT_PROBE_LIST_TOOLS_TIMEOUT_MS, deadline),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    probeFailure = { error };
  }

  try {
    await clientManager.disconnectAll();
  } catch (cleanupError) {
    throw new AgentProbeCleanupError(
      agent.skill.name,
      probeFailure === undefined ? [cleanupError] : [probeFailure.error, cleanupError],
    );
  }
  if (probeFailure !== undefined) {
    throw probeFailure.error;
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
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      await probeAgentEndpoint(agent, {
        timeoutMs: Math.min(probeTimeoutMs, remainingMs),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return;
    } catch (err) {
      if (err instanceof AgentProbeCleanupError) {
        throw err;
      }
      options.signal?.throwIfAborted();
      lastError = err;
      const remainingAfterProbeMs = deadline - Date.now();
      if (remainingAfterProbeMs <= 0) break;
      await sleep(Math.min(intervalMs, remainingAfterProbeMs), options.signal);
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
  options: {
    readonly lifecycleLock?: AgentLifecycleLock;
    readonly retention?: ManagedAgentRuntimeRetention;
  } = {},
): number {
  const resolvedLock = resolveAgentLifecycleLock(dataDir, agent.skill.name, options.lifecycleLock);
  try {
    return startAgentUnlocked(
      agent,
      dataDir,
      env,
      options.retention ?? MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
    );
  } finally {
    if (resolvedLock.acquired) resolvedLock.lock.release();
  }
}

function startAgentUnlocked(
  agent: RegisteredAgent,
  dataDir: string,
  env?: Readonly<Record<string, string>>,
  retention: ManagedAgentRuntimeRetention = MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
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
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: omitScheduleInvocationEnv({ ...process.env, ...(env ?? {}) }),
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
    writeAgentRuntimeSidecar(agent, dataDir, child.pid, { retention });
  } catch (err) {
    try {
      // This handle belongs to the process returned by this exact spawn operation; do not fall
      // back to a persisted numeric PID on this rollback path.
      child.kill("SIGTERM");
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
  const lock = acquireAgentLifecycleLock(dataDir, agentName);
  try {
    return stopAgentUnlocked(dataDir, agentName);
  } finally {
    lock.release();
  }
}

function stopAgentUnlocked(dataDir: string, agentName: string): boolean {
  const pid = getAgentPid(dataDir, agentName);
  if (pid === undefined) {
    removeAgentRuntimeFiles(dataDir, agentName);
    return false;
  }

  const identity = readVerifiedAgentRuntimeIdentity(dataDir, agentName, pid);
  try {
    signalVerifiedAgentProcess(agentName, identity);
  } catch (error) {
    if (!isErrnoCode(error, "ESRCH")) throw error;
  }

  removeAgentRuntimeFilesForIdentity(dataDir, agentName, identity);

  return true;
}

export async function stopAgentGracefully(
  dataDir: string,
  agentName: string,
  options: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly expectedIdentity?: ManagedAgentRuntimeIdentity;
    readonly lifecycleLock?: AgentLifecycleLock;
  } = {},
): Promise<boolean> {
  const resolvedLock = resolveAgentLifecycleLock(dataDir, agentName, options.lifecycleLock);
  try {
    return await stopAgentGracefullyUnlocked(dataDir, agentName, options);
  } finally {
    if (resolvedLock.acquired) resolvedLock.lock.release();
  }
}

async function stopAgentGracefullyUnlocked(
  dataDir: string,
  agentName: string,
  options: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly expectedIdentity?: ManagedAgentRuntimeIdentity;
  },
): Promise<boolean> {
  const pid = getAgentPid(dataDir, agentName);
  if (pid === undefined) {
    removeAgentRuntimeFiles(dataDir, agentName);
    return false;
  }

  const identity = readVerifiedAgentRuntimeIdentity(dataDir, agentName, pid);
  if (
    options.expectedIdentity !== undefined &&
    !sameManagedAgentRuntimeIdentity(identity, options.expectedIdentity)
  ) {
    return false;
  }

  try {
    signalVerifiedAgentProcess(agentName, identity);
  } catch (error) {
    if (!isErrnoCode(error, "ESRCH")) throw error;
    removeAgentRuntimeFilesForIdentity(dataDir, agentName, identity);
    return true;
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removeAgentRuntimeFilesForIdentity(dataDir, agentName, identity);
      return true;
    }
    const verification = verifyProcessStartToken(pid, identity.processStartToken);
    if (verification.status === "mismatch") {
      removeAgentRuntimeFilesForIdentity(dataDir, agentName, identity);
      return true;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Agent "${agentName}" did not stop within ${timeoutMs}ms`);
}

export function readVerifiedAgentRuntimeIdentity(
  dataDir: string,
  agentName: string,
  pid: number,
): ManagedAgentRuntimeIdentity {
  const sidecar = readAgentRuntimeSidecar(dataDir, agentName);
  if (sidecar === undefined) {
    throw new AgentRuntimeIdentityError(agentName, pid, "缺少 runtime sidecar");
  }
  if (sidecar === "invalid") {
    throw new AgentRuntimeIdentityError(
      agentName,
      pid,
      "runtime sidecar 无效或来自不含 processStartToken 的旧版本",
    );
  }
  if (sidecar.agentName !== agentName || sidecar.pid !== pid) {
    throw new AgentRuntimeIdentityError(agentName, pid, "runtime sidecar 与当前 Agent/PID 不一致");
  }

  const verification = verifyProcessStartToken(pid, sidecar.processStartToken);
  if (verification.status !== "match") {
    throw new AgentRuntimeIdentityError(
      agentName,
      pid,
      verification.status === "mismatch"
        ? "PID 当前属于另一个进程实例"
        : `无法可靠验证 OS 进程启动身份：${verification.reason}`,
    );
  }

  return {
    pid,
    processStartToken: sidecar.processStartToken,
    startedAt: sidecar.startedAt,
  };
}

export function readVerifiedManagedAgentRuntime(
  dataDir: string,
  agentName: string,
): VerifiedManagedAgentRuntime | undefined {
  const pid = getAgentPid(dataDir, agentName);
  if (pid === undefined) return undefined;
  const identity = readVerifiedAgentRuntimeIdentity(dataDir, agentName, pid);
  const sidecar = readAgentRuntimeSidecar(dataDir, agentName);
  if (sidecar === undefined || sidecar === "invalid") {
    throw new AgentRuntimeIdentityError(agentName, pid, "runtime sidecar 无法读取");
  }
  return { identity, retention: sidecar.retention };
}

export function promoteManagedAgentRuntimeToPersistent(
  dataDir: string,
  agentName: string,
  options: { readonly lifecycleLock?: AgentLifecycleLock } = {},
): boolean {
  const resolvedLock = resolveAgentLifecycleLock(dataDir, agentName, options.lifecycleLock);
  try {
    const runtime = readVerifiedManagedAgentRuntime(dataDir, agentName);
    if (runtime === undefined) return false;
    if (runtime.retention === MANAGED_AGENT_RUNTIME_RETENTIONS.persistent) return true;

    const sidecar = readAgentRuntimeSidecar(dataDir, agentName);
    if (sidecar === undefined || sidecar === "invalid") {
      throw new AgentRuntimeIdentityError(
        agentName,
        runtime.identity.pid,
        "runtime sidecar 无法读取",
      );
    }
    const promoted: ManagedAgentRuntimeSidecar = {
      ...sidecar,
      schemaVersion: RUNTIME_SIDECAR_SCHEMA_VERSION,
      retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
    };
    writeFileSync(
      runtimeSidecarPath(dataDir, agentName),
      `${JSON.stringify(promoted, null, 2)}\n`,
      "utf-8",
    );
    return true;
  } finally {
    if (resolvedLock.acquired) resolvedLock.lock.release();
  }
}

function signalVerifiedAgentProcess(
  agentName: string,
  identity: ManagedAgentRuntimeIdentity,
): void {
  const verification = verifyProcessStartToken(identity.pid, identity.processStartToken);
  if (verification.status !== "match") {
    throw new AgentRuntimeIdentityError(
      agentName,
      identity.pid,
      verification.status === "mismatch"
        ? "发送信号前 PID 已被其他进程复用"
        : `发送信号前无法可靠验证 OS 身份：${verification.reason}`,
    );
  }

  // This closes stale-PID reuse observed before validation. PID-based signaling still has a tiny
  // check-to-kill race; eliminating it requires a stable OS process handle or authenticated control
  // channel rather than a persisted numeric PID.
  process.kill(identity.pid, "SIGTERM");
}

export function sameManagedAgentRuntimeIdentity(
  current: ManagedAgentRuntimeIdentity | undefined,
  expected: ManagedAgentRuntimeIdentity,
): boolean {
  return (
    current?.pid === expected.pid &&
    current.processStartToken === expected.processStartToken &&
    current.startedAt === expected.startedAt
  );
}

let ownProcessStartToken: ProcessStartToken | undefined;

function readOwnProcessStartToken(): ProcessStartToken | undefined {
  ownProcessStartToken ??= readProcessStartToken(process.pid);
  return ownProcessStartToken;
}

export function acquireAgentLifecycleLock(dataDir: string, agentName: string): AgentLifecycleLock {
  const resolvedDataDir = resolve(dataDir);
  const lockPath = lifecycleLockPath(resolvedDataDir, agentName);
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const processStartToken = readOwnProcessStartToken();
  if (processStartToken === undefined) {
    throw new Error(
      `无法验证当前 Roll 进程 (PID: ${String(process.pid)}) 的 OS 启动身份，拒绝获取 Agent lifecycle lock。`,
    );
  }
  const record: AgentLifecycleLockFile = {
    pid: process.pid,
    processStartToken,
    token,
    createdAtMs: Date.now(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      const lock: AgentLifecycleLock = {
        release: () => releaseAgentLifecycleLock(lock),
      };
      agentLifecycleLockStates.set(lock, {
        dataDir: resolvedDataDir,
        agentName,
        lockPath,
        token,
        released: false,
      });
      return lock;
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      if (attempt === 0 && removeStaleAgentLifecycleLock(lockPath)) continue;
      throw new AgentLifecycleBusyError(agentName);
    }
  }

  throw new AgentLifecycleBusyError(agentName);
}

function resolveAgentLifecycleLock(
  dataDir: string,
  agentName: string,
  provided: AgentLifecycleLock | undefined,
): { readonly lock: AgentLifecycleLock; readonly acquired: boolean } {
  if (provided === undefined) {
    return { lock: acquireAgentLifecycleLock(dataDir, agentName), acquired: true };
  }

  const state = agentLifecycleLockStates.get(provided);
  if (
    state === undefined ||
    state.released ||
    state.dataDir !== resolve(dataDir) ||
    state.agentName !== agentName
  ) {
    throw new Error("Invalid Agent lifecycle lock handle.");
  }
  return { lock: provided, acquired: false };
}

function releaseAgentLifecycleLock(lock: AgentLifecycleLock): void {
  const state = agentLifecycleLockStates.get(lock);
  if (state === undefined || state.released) return;
  state.released = true;
  agentLifecycleLockStates.delete(lock);
  try {
    const current = readAgentLifecycleLockFile(state.lockPath);
    if (current?.token === state.token) unlinkSync(state.lockPath);
  } catch {
    // A crashed/replaced lock must never be removed using a stale handle.
  }
}

function removeStaleAgentLifecycleLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    return false;
  }
  const record = parseAgentLifecycleLockFile(raw);
  let ageMs: number;
  try {
    ageMs = Date.now() - (record?.createdAtMs ?? statSync(lockPath).mtimeMs);
  } catch {
    return false;
  }
  const stale =
    record === undefined ? ageMs > AGENT_LIFECYCLE_LOCK_STALE_MS : isLifecycleLockStale(record);
  if (!stale) {
    return false;
  }
  try {
    if (readFileSync(lockPath, "utf-8") !== raw) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function readAgentLifecycleLockFile(lockPath: string): AgentLifecycleLockFile | undefined {
  if (!existsSync(lockPath)) return undefined;
  return parseAgentLifecycleLockFile(readFileSync(lockPath, "utf-8"));
}

function parseAgentLifecycleLockFile(raw: string): AgentLifecycleLockFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecordObject(value) ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    !isProcessStartToken(value.processStartToken) ||
    typeof value.token !== "string" ||
    typeof value.createdAtMs !== "number" ||
    !Number.isFinite(value.createdAtMs)
  ) {
    return undefined;
  }
  return {
    pid: value.pid,
    processStartToken: value.processStartToken,
    token: value.token,
    createdAtMs: value.createdAtMs,
  };
}

function isLifecycleLockStale(record: AgentLifecycleLockFile): boolean {
  if (!isPidAlive(record.pid)) return true;
  return verifyProcessStartToken(record.pid, record.processStartToken).status === "mismatch";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoCode(error, "EPERM");
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function removeAgentRuntimeFilesForIdentity(
  dataDir: string,
  agentName: string,
  expectedIdentity: ManagedAgentRuntimeIdentity,
): boolean {
  const pidFile = pidFilePath(dataDir, agentName);
  if (readRecordedPid(pidFile) !== expectedIdentity.pid) {
    return false;
  }

  const sidecarPath = runtimeSidecarPath(dataDir, agentName);
  const sidecar = readAgentRuntimeSidecar(dataDir, agentName);
  if (
    sidecar === undefined ||
    sidecar === "invalid" ||
    sidecar.agentName !== agentName ||
    !sameManagedAgentRuntimeIdentity(sidecar, expectedIdentity)
  ) {
    return false;
  }

  try {
    unlinkSync(pidFile);
    unlinkSync(sidecarPath);
    return true;
  } catch (error) {
    // Cooperative writers hold the lifecycle lock. An external deletion/replacement must not be
    // reported as a successful compare-and-delete of the expected runtime identity.
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

function readRecordedPid(pidFile: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
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

function requestTimeoutMs(localLimitMs: number, deadline: number | undefined): number {
  if (deadline === undefined) return localLimitMs;
  return Math.max(1, Math.min(localLimitMs, deadline - Date.now()));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    const handleAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted === true) handleAbort();
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
    parsed = readJsonFile(sidecarPath);
  } catch {
    return "invalid";
  }

  const sidecar = parseManagedAgentRuntimeSidecar(parsed);
  if (sidecar === undefined) {
    return "invalid";
  }

  return sidecar;
}

function parseManagedAgentRuntimeSidecar(value: unknown): ManagedAgentRuntimeSidecar | undefined {
  if (!isRecordObject(value)) {
    return undefined;
  }

  if (
    value.schemaVersion !== LEGACY_RUNTIME_SIDECAR_SCHEMA_VERSION &&
    value.schemaVersion !== RUNTIME_SIDECAR_SCHEMA_VERSION
  ) {
    return undefined;
  }

  if (
    typeof value.agentName !== "string" ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    !isProcessStartToken(value.processStartToken) ||
    typeof value.coreVersion !== "string" ||
    typeof value.startedAt !== "string"
  ) {
    return undefined;
  }

  if (value.endpoint !== undefined && typeof value.endpoint !== "string") {
    return undefined;
  }

  const retention =
    value.schemaVersion === LEGACY_RUNTIME_SIDECAR_SCHEMA_VERSION
      ? MANAGED_AGENT_RUNTIME_RETENTIONS.persistent
      : value.retention;
  if (!isManagedAgentRuntimeRetention(retention)) {
    return undefined;
  }

  return {
    schemaVersion: value.schemaVersion,
    agentName: value.agentName,
    pid: value.pid,
    processStartToken: value.processStartToken,
    coreVersion: value.coreVersion,
    startedAt: value.startedAt,
    retention,
    ...(typeof value.endpoint === "string" ? { endpoint: value.endpoint } : {}),
  };
}

function isManagedAgentRuntimeRetention(value: unknown): value is ManagedAgentRuntimeRetention {
  return Object.values(MANAGED_AGENT_RUNTIME_RETENTIONS).some((retention) => retention === value);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
