import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import {
  isProcessStartToken,
  readProcessStartToken,
  verifyProcessStartToken,
  type ProcessStartToken,
} from "./process-identity.ts";
import {
  AgentLifecycleBusyError,
  MANAGED_AGENT_RUNTIME_RETENTIONS,
  acquireAgentLifecycleLock,
  readVerifiedManagedAgentRuntime,
  sameManagedAgentRuntimeIdentity,
  startAgent,
  stopAgentGracefully,
  waitForAgentReady,
  type AgentLifecycleLock,
  type ManagedAgentRuntimeIdentity,
  type VerifiedManagedAgentRuntime,
} from "./process-manager.ts";
import { rollbackStartedManagedAgentOrThrow } from "./managed-runtime-rollback.ts";
import type { RegisteredAgent } from "../types/agent.ts";

const AGENT_USAGE_LEASE_SCHEMA_VERSION = 1 as const;
const DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS = 15_000;
const MIN_LIFECYCLE_LOCK_RETRY_MS = 50;
const MAX_LIFECYCLE_LOCK_RETRY_MS = 250;
const ABANDONED_TEMP_FILE_AGE_MS = 5 * 60_000;

export const AGENT_USAGE_HOLDER_KINDS = [
  "chat",
  "run",
  "ask",
  "agent-tools",
  "browser-stop",
  "diagnostics",
] as const;
export type AgentUsageHolderKind = (typeof AGENT_USAGE_HOLDER_KINDS)[number];

declare const AGENT_USAGE_LEASE_ID_BRAND: unique symbol;
export type AgentUsageLeaseId = string & {
  readonly [AGENT_USAGE_LEASE_ID_BRAND]: true;
};

const ProcessStartTokenSchema = z.custom<ProcessStartToken>(isProcessStartToken);
const RuntimeIdentitySchema = z.object({
  pid: z.number().int().positive(),
  processStartToken: ProcessStartTokenSchema,
  startedAt: z.string().datetime(),
});
const AgentUsageLeaseRecordSchema = z.object({
  schemaVersion: z.literal(AGENT_USAGE_LEASE_SCHEMA_VERSION),
  leaseId: z.string().uuid(),
  agentName: z.string().min(1),
  holderKind: z.enum(AGENT_USAGE_HOLDER_KINDS),
  ownerIdentity: z.object({
    pid: z.number().int().positive(),
    processStartToken: ProcessStartTokenSchema,
  }),
  runtimeIdentity: RuntimeIdentitySchema,
  acquiredAt: z.string().datetime(),
});

type AgentUsageLeaseRecord = z.infer<typeof AgentUsageLeaseRecordSchema>;

export type AgentUsageBlocker =
  | {
      readonly kind: "active" | "unverifiable";
      readonly leaseId: string;
      readonly holderKind: AgentUsageHolderKind;
      readonly pid: number;
      readonly acquiredAt: string;
    }
  | {
      readonly kind: "invalid";
      readonly filePath: string;
    };

export interface AgentUsageInspection {
  readonly agentName: string;
  readonly runtime: VerifiedManagedAgentRuntime | undefined;
  readonly blockers: readonly AgentUsageBlocker[];
}

export interface AgentUsageLease {
  readonly agentName: string;
  readonly leaseId: AgentUsageLeaseId;
  readonly runtimeIdentity: ManagedAgentRuntimeIdentity;
  release(): Promise<void>;
}

export interface AgentUsageMaintenanceGuard {
  readonly agentName: string;
  readonly runtime: VerifiedManagedAgentRuntime | undefined;
  readonly lifecycleLock: AgentLifecycleLock;
  release(): void;
}

interface AgentUsageLeaseState {
  readonly agent: RegisteredAgent;
  readonly dataDir: string;
  leasePath: string;
  readonly leaseFileIdentity: LeaseFileIdentity;
  readonly record: AgentUsageLeaseRecord;
  released: boolean;
}

interface LeaseFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface WrittenLeaseRecord {
  readonly leasePath: string;
  readonly leaseFileIdentity: LeaseFileIdentity;
}

interface OwnedLeaseFile {
  readonly leasePath: string;
  readonly expectedFileName: string;
  readonly leaseFileIdentity: LeaseFileIdentity;
}

type OwnedLeaseQuarantineResult =
  | { readonly kind: "missing" }
  | { readonly kind: "replaced" }
  | { readonly kind: "owned"; readonly file: OwnedLeaseFile };

interface ReconciledLeaseState {
  readonly activeRecords: readonly AgentUsageLeaseRecord[];
  readonly blockers: readonly AgentUsageBlocker[];
}

const agentUsageLeaseStates = new WeakMap<AgentUsageLease, AgentUsageLeaseState>();

export class AgentUsageBusyError extends Error {
  readonly code = "agent_usage_busy" as const;
  readonly agentName: string;
  readonly blockers: readonly AgentUsageBlocker[];

  constructor(agentName: string, blockers: readonly AgentUsageBlocker[]) {
    super(formatAgentUsageBusyMessage(agentName, blockers));
    this.name = "AgentUsageBusyError";
    this.agentName = agentName;
    this.blockers = blockers;
  }
}

export class AgentUsageLeaseStateError extends Error {
  readonly code = "agent_usage_lease_state_invalid" as const;

  constructor(agentName: string, message: string) {
    super(`Agent "${agentName}" 的使用租约状态无效：${message}`);
    this.name = "AgentUsageLeaseStateError";
  }
}

export function isAgentUsageLeaseManaged(agent: RegisteredAgent): boolean {
  return agent.runtime.ownership === "core-managed" && agent.transport.type === "streamable-http";
}

export async function acquireAgentUsageLease(
  agent: RegisteredAgent,
  dataDir: string,
  env: Readonly<Record<string, string>> | undefined,
  options: {
    readonly holderKind: AgentUsageHolderKind;
    readonly startIfStopped: boolean;
    readonly waitUntilReady?: boolean;
    readonly lifecycleLockTimeoutMs?: number;
  },
): Promise<AgentUsageLease | undefined> {
  if (!isAgentUsageLeaseManaged(agent)) return undefined;

  const lifecycleLock = await acquireAgentLifecycleLockWithRetry(
    dataDir,
    agent.skill.name,
    options.lifecycleLockTimeoutMs,
  );
  let lease: AgentUsageLease | undefined;
  let runtimeStartedForLease: ManagedAgentRuntimeIdentity | undefined;
  let startedAgentForLease = false;
  try {
    let runtime = readVerifiedManagedAgentRuntime(dataDir, agent.skill.name);
    if (runtime === undefined) {
      const reconciled = reconcileLeaseFiles(dataDir, agent.skill.name, undefined);
      if (reconciled.blockers.length > 0) {
        throw new AgentUsageBusyError(agent.skill.name, reconciled.blockers);
      }
      if (!options.startIfStopped) {
        throw new Error(
          `Agent "${agent.skill.name}" 当前未运行；请先执行 \`roll agent start ${agent.skill.name}\`。`,
        );
      }
      startAgent(agent, dataDir, env, {
        lifecycleLock,
        retention: MANAGED_AGENT_RUNTIME_RETENTIONS.leaseBound,
      });
      startedAgentForLease = true;
      runtime = readVerifiedManagedAgentRuntime(dataDir, agent.skill.name);
      if (runtime === undefined) {
        throw new AgentUsageLeaseStateError(agent.skill.name, "启动后缺少可验证 runtime");
      }
      runtimeStartedForLease = runtime.identity;
    } else {
      const reconciled = reconcileLeaseFiles(dataDir, agent.skill.name, runtime.identity);
      const compatibleLeaseIds = new Set(reconciled.activeRecords.map((record) => record.leaseId));
      const incompatibleBlockers = reconciled.blockers.filter(
        (blocker) => blocker.kind === "invalid" || !compatibleLeaseIds.has(blocker.leaseId),
      );
      if (incompatibleBlockers.length > 0) {
        throw new AgentUsageBusyError(agent.skill.name, incompatibleBlockers);
      }
    }

    const record = createLeaseRecord(agent.skill.name, options.holderKind, runtime.identity);
    const writtenLease = writeLeaseRecord(dataDir, record);
    lease = createLeaseHandle(agent, dataDir, writtenLease, record);
  } catch (error) {
    if (startedAgentForLease) {
      await rollbackStartedManagedAgentOrThrow({
        agentName: agent.skill.name,
        dataDir,
        expectedIdentity: runtimeStartedForLease,
        lifecycleLock,
        cause: error,
        rollbackFailureMessage: `Agent "${agent.skill.name}" 使用租约创建失败，且新启动进程回滚失败。`,
        stopGracefully: stopAgentGracefully,
      });
    }
    throw error;
  } finally {
    lifecycleLock.release();
  }

  if ((options.waitUntilReady ?? options.startIfStopped) === false) {
    return lease;
  }
  try {
    await waitForAgentReady(agent);
    return lease;
  } catch (error) {
    try {
      await lease?.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Agent "${agent.skill.name}" readiness 检查失败，且使用租约释放失败。`,
      );
    }
    throw error;
  }
}

export async function inspectAgentUsage(
  agent: RegisteredAgent,
  dataDir: string,
  options: {
    readonly lifecycleLock?: AgentLifecycleLock;
    readonly lifecycleLockTimeoutMs?: number;
  } = {},
): Promise<AgentUsageInspection> {
  if (!isAgentUsageLeaseManaged(agent)) {
    return { agentName: agent.skill.name, runtime: undefined, blockers: [] };
  }

  const acquiredLock =
    options.lifecycleLock ??
    (await acquireAgentLifecycleLockWithRetry(
      dataDir,
      agent.skill.name,
      options.lifecycleLockTimeoutMs,
    ));
  try {
    const runtime = readVerifiedManagedAgentRuntime(dataDir, agent.skill.name);
    const state = reconcileLeaseFiles(dataDir, agent.skill.name, runtime?.identity);
    return {
      agentName: agent.skill.name,
      runtime,
      blockers: state.blockers,
    };
  } finally {
    if (options.lifecycleLock === undefined) acquiredLock.release();
  }
}

export async function acquireAgentUsageMaintenanceGuard(
  agent: RegisteredAgent,
  dataDir: string,
  options: { readonly lifecycleLockTimeoutMs?: number } = {},
): Promise<AgentUsageMaintenanceGuard | undefined> {
  if (!isAgentUsageLeaseManaged(agent)) return undefined;

  const lifecycleLock = await acquireAgentLifecycleLockWithRetry(
    dataDir,
    agent.skill.name,
    options.lifecycleLockTimeoutMs,
  );
  try {
    const inspection = await inspectAgentUsage(agent, dataDir, { lifecycleLock });
    if (inspection.blockers.length > 0) {
      throw new AgentUsageBusyError(agent.skill.name, inspection.blockers);
    }
    let released = false;
    return {
      agentName: agent.skill.name,
      runtime: inspection.runtime,
      lifecycleLock,
      release: () => {
        if (released) return;
        released = true;
        lifecycleLock.release();
      },
    };
  } catch (error) {
    lifecycleLock.release();
    throw error;
  }
}

export async function acquireAgentLifecycleLockWithRetry(
  dataDir: string,
  agentName: string,
  timeoutMs = DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS,
): Promise<AgentLifecycleLock> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return acquireAgentLifecycleLock(dataDir, agentName);
    } catch (error) {
      if (!(error instanceof AgentLifecycleBusyError) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(randomRetryDelayMs());
    }
  }
}

async function releaseAgentUsageLease(lease: AgentUsageLease): Promise<void> {
  const state = agentUsageLeaseStates.get(lease);
  if (state === undefined || state.released) return;

  const lifecycleLock = await acquireAgentLifecycleLockWithRetry(
    state.dataDir,
    state.agent.skill.name,
  );
  try {
    if (state.released) return;

    const quarantine = quarantineOwnedLeaseFile(state);
    if (quarantine.kind !== "owned") {
      markLeaseReleased(lease, state);
      return;
    }

    const runtime = readVerifiedManagedAgentRuntime(state.dataDir, state.agent.skill.name);
    if (
      runtime === undefined ||
      !sameManagedAgentRuntimeIdentity(runtime.identity, state.record.runtimeIdentity)
    ) {
      unlinkOwnedLeaseFileIfUnchanged(state);
      markLeaseReleased(lease, state);
      return;
    }

    const reconciled = reconcileLeaseFiles(
      state.dataDir,
      state.agent.skill.name,
      runtime.identity,
      quarantine.file,
    );
    // `blockers` intentionally covers more than compatible active records: an invalid,
    // unverifiable, or different-runtime lease cannot prove that stopping is safe.
    const hasOtherUsage = reconciled.activeRecords.length > 0 || reconciled.blockers.length > 0;
    if (runtime.retention === MANAGED_AGENT_RUNTIME_RETENTIONS.persistent || hasOtherUsage) {
      unlinkOwnedLeaseFileIfUnchanged(state);
      markLeaseReleased(lease, state);
      return;
    }

    await stopAgentGracefully(state.dataDir, state.agent.skill.name, {
      expectedIdentity: state.record.runtimeIdentity,
      lifecycleLock,
    });
    unlinkOwnedLeaseFileIfUnchanged(state);
    markLeaseReleased(lease, state);
  } finally {
    lifecycleLock.release();
  }
}

function createLeaseHandle(
  agent: RegisteredAgent,
  dataDir: string,
  writtenLease: WrittenLeaseRecord,
  record: AgentUsageLeaseRecord,
): AgentUsageLease {
  const leaseId = createAgentUsageLeaseId(record.leaseId);
  const lease: AgentUsageLease = {
    agentName: agent.skill.name,
    leaseId,
    runtimeIdentity: record.runtimeIdentity,
    release: () => releaseAgentUsageLease(lease),
  };
  agentUsageLeaseStates.set(lease, {
    agent,
    dataDir: resolve(dataDir),
    leasePath: writtenLease.leasePath,
    leaseFileIdentity: writtenLease.leaseFileIdentity,
    record,
    released: false,
  });
  return lease;
}

function createLeaseRecord(
  agentName: string,
  holderKind: AgentUsageHolderKind,
  runtimeIdentity: ManagedAgentRuntimeIdentity,
): AgentUsageLeaseRecord {
  const processStartToken = readProcessStartToken(process.pid);
  if (processStartToken === undefined) {
    throw new AgentUsageLeaseStateError(agentName, "无法验证当前 Roll 进程身份");
  }
  return AgentUsageLeaseRecordSchema.parse({
    schemaVersion: AGENT_USAGE_LEASE_SCHEMA_VERSION,
    leaseId: randomUUID(),
    agentName,
    holderKind,
    ownerIdentity: {
      pid: process.pid,
      processStartToken,
    },
    runtimeIdentity,
    acquiredAt: new Date().toISOString(),
  });
}

function writeLeaseRecord(dataDir: string, record: AgentUsageLeaseRecord): WrittenLeaseRecord {
  const directory = leaseDirectory(dataDir, record.agentName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const finalPath = resolve(directory, `${record.leaseId}.json`);
  const tempPath = resolve(directory, `.${record.leaseId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tempPath, finalPath);
    return {
      leasePath: finalPath,
      leaseFileIdentity: readRequiredLeaseFileIdentity(finalPath),
    };
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function reconcileLeaseFiles(
  dataDir: string,
  agentName: string,
  runtimeIdentity: ManagedAgentRuntimeIdentity | undefined,
  ownedLeaseFile?: OwnedLeaseFile,
): ReconciledLeaseState {
  const directory = leaseDirectory(dataDir, agentName);
  if (!existsSync(directory)) {
    return { activeRecords: [], blockers: [] };
  }

  const activeRecords: AgentUsageLeaseRecord[] = [];
  const blockers: AgentUsageBlocker[] = [];
  for (const fileName of readdirSync(directory)) {
    const leasePath = resolve(directory, fileName);
    if (fileName.endsWith(".tmp")) {
      removeAbandonedTempFile(leasePath);
      continue;
    }
    if (!fileName.endsWith(".json")) continue;
    if (
      ownedLeaseFile !== undefined &&
      isExpectedOwnedLeasePath(leasePath, fileName, ownedLeaseFile)
    ) {
      if (isSameOwnedLeaseFile(leasePath, fileName, ownedLeaseFile)) continue;
      blockers.push({ kind: "invalid", filePath: leasePath });
      continue;
    }

    const record = readLeaseRecord(leasePath);
    if (record === undefined) {
      blockers.push({ kind: "invalid", filePath: leasePath });
      continue;
    }
    if (record.agentName !== agentName || basename(leasePath) !== `${record.leaseId}.json`) {
      blockers.push({ kind: "invalid", filePath: leasePath });
      continue;
    }
    const verification = verifyProcessStartToken(
      record.ownerIdentity.pid,
      record.ownerIdentity.processStartToken,
    );
    if (verification.status === "mismatch") {
      unlinkLeaseIfUnchanged(leasePath, record);
      continue;
    }

    const matchesRuntime =
      runtimeIdentity !== undefined &&
      sameManagedAgentRuntimeIdentity(runtimeIdentity, record.runtimeIdentity);
    if (matchesRuntime) activeRecords.push(record);
    blockers.push({
      kind: verification.status === "match" ? "active" : "unverifiable",
      leaseId: record.leaseId,
      holderKind: record.holderKind,
      pid: record.ownerIdentity.pid,
      acquiredAt: record.acquiredAt,
    });
  }

  return { activeRecords, blockers };
}

function readLeaseRecord(leasePath: string): AgentUsageLeaseRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(leasePath, "utf-8"));
    const result = AgentUsageLeaseRecordSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function unlinkLeaseIfUnchanged(leasePath: string, expected: AgentUsageLeaseRecord): boolean {
  const current = readLeaseRecord(leasePath);
  if (current === undefined || current.leaseId !== expected.leaseId) return false;
  try {
    unlinkSync(leasePath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

function createOwnedLeaseFile(state: AgentUsageLeaseState): OwnedLeaseFile {
  return {
    leasePath: state.leasePath,
    expectedFileName: basename(state.leasePath),
    leaseFileIdentity: state.leaseFileIdentity,
  };
}

function quarantineOwnedLeaseFile(state: AgentUsageLeaseState): OwnedLeaseQuarantineResult {
  const sourcePath = state.leasePath;
  const quarantinePath = resolve(
    dirname(sourcePath),
    `.${state.record.leaseId}.${randomUUID()}.releasing.json`,
  );
  try {
    renameSync(sourcePath, quarantinePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }

  const quarantinedFile: OwnedLeaseFile = {
    leasePath: quarantinePath,
    expectedFileName: basename(quarantinePath),
    leaseFileIdentity: state.leaseFileIdentity,
  };
  if (
    !isSameOwnedLeaseFile(
      quarantinedFile.leasePath,
      quarantinedFile.expectedFileName,
      quarantinedFile,
    )
  ) {
    // Keep the unexpected inode under a `.json` name so future reconciliation blocks
    // maintenance instead of silently treating it as this handle's lease.
    return { kind: "replaced" };
  }

  // A failed stop can retry from this exact quarantined inode. If the process exits first,
  // the mismatched filename remains an invalid blocker for explicit recovery.
  state.leasePath = quarantinePath;
  return { kind: "owned", file: quarantinedFile };
}

function unlinkOwnedLeaseFileIfUnchanged(state: AgentUsageLeaseState): boolean {
  const ownedLeaseFile = createOwnedLeaseFile(state);
  if (!isSameOwnedLeaseFile(state.leasePath, basename(state.leasePath), ownedLeaseFile)) {
    return false;
  }
  try {
    unlinkSync(state.leasePath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isSameOwnedLeaseFile(
  leasePath: string,
  fileName: string,
  ownedLeaseFile: OwnedLeaseFile,
): boolean {
  if (!isExpectedOwnedLeasePath(leasePath, fileName, ownedLeaseFile)) return false;
  const currentIdentity = readLeaseFileIdentity(leasePath);
  return (
    currentIdentity !== undefined &&
    currentIdentity.dev === ownedLeaseFile.leaseFileIdentity.dev &&
    currentIdentity.ino === ownedLeaseFile.leaseFileIdentity.ino
  );
}

function isExpectedOwnedLeasePath(
  leasePath: string,
  fileName: string,
  ownedLeaseFile: OwnedLeaseFile,
): boolean {
  return leasePath === ownedLeaseFile.leasePath && fileName === ownedLeaseFile.expectedFileName;
}

function readRequiredLeaseFileIdentity(leasePath: string): LeaseFileIdentity {
  const identity = readLeaseFileIdentity(leasePath);
  if (identity === undefined) {
    throw new Error(`无法读取刚创建的 Agent 使用租约文件身份：${leasePath}`);
  }
  return identity;
}

function readLeaseFileIdentity(leasePath: string): LeaseFileIdentity | undefined {
  try {
    const stats = lstatSync(leasePath, { bigint: true });
    return {
      dev: stats.dev,
      ino: stats.ino,
    };
  } catch {
    return undefined;
  }
}

function removeAbandonedTempFile(filePath: string): void {
  try {
    if (Date.now() - statSync(filePath).mtimeMs > ABANDONED_TEMP_FILE_AGE_MS) {
      unlinkSync(filePath);
    }
  } catch {
    // Temp files are never active leases; a later reconciliation can retry cleanup.
  }
}

function leaseDirectory(dataDir: string, agentName: string): string {
  const digest = createHash("sha256").update(agentName).digest("hex");
  return resolve(dataDir, "pids", ".leases", digest);
}

function createAgentUsageLeaseId(value: string): AgentUsageLeaseId {
  if (!z.string().uuid().safeParse(value).success) {
    throw new Error("Invalid Agent usage lease id.");
  }
  return value as AgentUsageLeaseId;
}

function markLeaseReleased(lease: AgentUsageLease, state: AgentUsageLeaseState): void {
  state.released = true;
  agentUsageLeaseStates.delete(lease);
}

function randomRetryDelayMs(): number {
  return (
    MIN_LIFECYCLE_LOCK_RETRY_MS +
    Math.floor(Math.random() * (MAX_LIFECYCLE_LOCK_RETRY_MS - MIN_LIFECYCLE_LOCK_RETRY_MS + 1))
  );
}

function formatAgentUsageBusyMessage(
  agentName: string,
  blockers: readonly AgentUsageBlocker[],
): string {
  const details = blockers.map((blocker) => {
    if (blocker.kind === "invalid") {
      return `  - 无法安全解析租约文件 ${blocker.filePath}`;
    }
    const status = blocker.kind === "active" ? "活动" : "身份不可验证";
    return (
      `  - ${status} ${blocker.holderKind}，PID ${String(blocker.pid)}，` +
      `自 ${blocker.acquiredAt}`
    );
  });
  const recovery = blockers.some((blocker) => blocker.kind === "invalid")
    ? "损坏租约无法自动确认所有者。请先关闭所有相关 Roll 进程并确认 Agent 不再被使用，再备份并删除上述单个文件后重试。"
    : "请关闭相关 roll chat/命令后重试。";
  return [
    `Agent "${agentName}" 正被其他 Roll 进程使用，已拒绝生命周期操作。`,
    ...details,
    recovery,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
