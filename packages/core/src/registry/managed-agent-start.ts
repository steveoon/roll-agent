import {
  MANAGED_AGENT_RUNTIME_RETENTIONS,
  promoteManagedAgentRuntimeToPersistent,
  readVerifiedManagedAgentRuntime,
  sameManagedAgentRuntimeIdentity,
  startAgent,
  stopAgentGracefully,
  type AgentLifecycleLock,
  type ManagedAgentRuntimeIdentity,
} from "./process-manager.ts";
import {
  acquireAgentLifecycleLockWithRetry,
  AgentUsageBusyError,
  AgentUsageLeaseStateError,
  inspectAgentUsage,
  type AgentUsageBlocker,
} from "./agent-usage-lease.ts";
import {
  acquireAgentRegistryLockAsync,
  AgentRegistryBusyError,
  type AgentRegistryLock,
} from "./agent-registry-lock.ts";
import { rollbackStartedManagedAgentOrThrow } from "./managed-runtime-rollback.ts";
import { AgentStore } from "./store.ts";
import type { RegisteredAgent } from "../types/agent.ts";

type AgentStartFinalStatus = Extract<RegisteredAgent["status"], "online" | "error">;

export type AgentStartStore = Pick<AgentStore, "findByName" | "updateStatus">;

export interface AgentStartAttempt {
  readonly agent: RegisteredAgent;
  readonly runtimeIdentity: ManagedAgentRuntimeIdentity;
  readonly started: boolean;
}

export type AgentStartPreparationResult =
  | { readonly ok: true; readonly attempt: AgentStartAttempt }
  | { readonly ok: false; readonly error: unknown };

export type AgentStartFinalizationResult =
  | { readonly kind: "committed" }
  | { readonly kind: "in-use"; readonly blockers: readonly AgentUsageBlocker[] }
  | { readonly kind: "stale" };

export type FailedAgentStartCleanupResult =
  | { readonly kind: "stopped" }
  | { readonly kind: "in-use"; readonly blockers: readonly AgentUsageBlocker[] }
  | { readonly kind: "stale" };

interface PrepareAgentStartCollaborators {
  readonly readRuntime: typeof readVerifiedManagedAgentRuntime;
  readonly inspectUsage: typeof inspectAgentUsage;
  readonly promoteRuntime: typeof promoteManagedAgentRuntimeToPersistent;
  readonly start: typeof startAgent;
  readonly stopGracefully: typeof stopAgentGracefully;
}

interface PrepareAgentStartCommandCollaborators {
  readonly acquireLifecycleLock: typeof acquireAgentLifecycleLockWithRetry;
  readonly prepareAttempt: typeof prepareAgentStartAttempt;
}

interface FinalizeAgentStartCommandCollaborators {
  readonly finalizeAttempt: typeof finalizeAgentStartAttempt;
  readonly cleanupFailedAttempt: typeof cleanupFailedAgentStartAttempt;
}

interface FinalizeAgentStartCollaborators {
  readonly acquireRegistryLock: typeof acquireAgentRegistryLockAsync;
  readonly acquireLifecycleLock: typeof acquireAgentLifecycleLockWithRetry;
  readonly createStore: (dataDir: string, registryLock: AgentRegistryLock) => AgentStartStore;
  readonly readRuntime: typeof readVerifiedManagedAgentRuntime;
  readonly inspectUsage: typeof inspectAgentUsage;
  readonly stopGracefully: typeof stopAgentGracefully;
}

type FailedAgentStartCleanupCollaborators = Pick<
  FinalizeAgentStartCollaborators,
  "acquireLifecycleLock" | "inspectUsage" | "stopGracefully"
>;

const DEFAULT_PREPARE_COLLABORATORS: PrepareAgentStartCollaborators = {
  readRuntime: readVerifiedManagedAgentRuntime,
  inspectUsage: inspectAgentUsage,
  promoteRuntime: promoteManagedAgentRuntimeToPersistent,
  start: startAgent,
  stopGracefully: stopAgentGracefully,
};

const DEFAULT_PREPARE_COMMAND_COLLABORATORS: PrepareAgentStartCommandCollaborators = {
  acquireLifecycleLock: acquireAgentLifecycleLockWithRetry,
  prepareAttempt: prepareAgentStartAttempt,
};

const DEFAULT_FINALIZE_COMMAND_COLLABORATORS: FinalizeAgentStartCommandCollaborators = {
  finalizeAttempt: finalizeAgentStartAttempt,
  cleanupFailedAttempt: cleanupFailedAgentStartAttempt,
};

const DEFAULT_FINALIZE_COLLABORATORS: FinalizeAgentStartCollaborators = {
  acquireRegistryLock: acquireAgentRegistryLockAsync,
  acquireLifecycleLock: acquireAgentLifecycleLockWithRetry,
  createStore: (dataDir, registryLock) => new AgentStore(dataDir, { registryLock }),
  readRuntime: readVerifiedManagedAgentRuntime,
  inspectUsage: inspectAgentUsage,
  stopGracefully: stopAgentGracefully,
};

const DEFAULT_FAILED_START_CLEANUP_COLLABORATORS: FailedAgentStartCleanupCollaborators = {
  acquireLifecycleLock: acquireAgentLifecycleLockWithRetry,
  inspectUsage: inspectAgentUsage,
  stopGracefully: stopAgentGracefully,
};

export async function prepareAgentStartAttempt(
  agent: RegisteredAgent,
  store: AgentStartStore,
  dataDir: string,
  env: Readonly<Record<string, string>> | undefined,
  lifecycleLock: AgentLifecycleLock,
  options: {
    readonly collaborators?: Partial<PrepareAgentStartCollaborators>;
  } = {},
): Promise<AgentStartAttempt> {
  const collaborators = {
    ...DEFAULT_PREPARE_COLLABORATORS,
    ...options.collaborators,
  };
  const runtime = collaborators.readRuntime(dataDir, agent.skill.name);
  let spawnedRuntimeIdentity: ManagedAgentRuntimeIdentity | undefined;

  try {
    if (runtime !== undefined) {
      if (
        !collaborators.promoteRuntime(dataDir, agent.skill.name, {
          lifecycleLock,
        })
      ) {
        throw new AgentUsageLeaseStateError(
          agent.skill.name,
          "可验证 runtime 在提升为 persistent 前消失",
        );
      }
      const promotedRuntime = collaborators.readRuntime(dataDir, agent.skill.name);
      if (
        promotedRuntime === undefined ||
        !sameManagedAgentRuntimeIdentity(promotedRuntime.identity, runtime.identity)
      ) {
        throw new AgentUsageLeaseStateError(agent.skill.name, "提升后的 runtime 不再是原进程");
      }

      const expectedAgent = requireRegisteredAgentSnapshot(store, agent.skill.name);
      return { agent: expectedAgent, runtimeIdentity: promotedRuntime.identity, started: false };
    }

    const usage = await collaborators.inspectUsage(agent, dataDir, { lifecycleLock });
    if (usage.blockers.length > 0) {
      throw new AgentUsageBusyError(agent.skill.name, usage.blockers);
    }

    store.updateStatus(agent.skill.name, "starting");
    const spawnedPid = collaborators.start(agent, dataDir, env, {
      lifecycleLock,
      retention: MANAGED_AGENT_RUNTIME_RETENTIONS.persistent,
    });
    const startedRuntime = collaborators.readRuntime(dataDir, agent.skill.name);
    if (startedRuntime === undefined || startedRuntime.identity.pid !== spawnedPid) {
      throw new AgentUsageLeaseStateError(
        agent.skill.name,
        "启动后缺少与新进程匹配的可验证 runtime",
      );
    }
    spawnedRuntimeIdentity = startedRuntime.identity;
    const expectedAgent = requireRegisteredAgentSnapshot(store, agent.skill.name);
    return {
      agent: expectedAgent,
      runtimeIdentity: startedRuntime.identity,
      started: true,
    };
  } catch (error) {
    if (spawnedRuntimeIdentity !== undefined) {
      await rollbackStartedManagedAgentOrThrow({
        agentName: agent.skill.name,
        dataDir,
        expectedIdentity: spawnedRuntimeIdentity,
        lifecycleLock,
        cause: error,
        rollbackFailureMessage: `Agent "${agent.skill.name}" 启动准备失败，且新进程回滚失败。`,
        stopGracefully: collaborators.stopGracefully,
      });
    }
    throw error;
  }
}

export async function prepareAgentStartForCommand(
  agent: RegisteredAgent,
  store: AgentStartStore,
  dataDir: string,
  resolveEnv: () => Readonly<Record<string, string>> | undefined,
  options: {
    readonly collaborators?: Partial<PrepareAgentStartCommandCollaborators>;
  } = {},
): Promise<AgentStartPreparationResult> {
  const collaborators = {
    ...DEFAULT_PREPARE_COMMAND_COLLABORATORS,
    ...options.collaborators,
  };
  try {
    const env = resolveEnv();
    const lifecycleLock = await collaborators.acquireLifecycleLock(dataDir, agent.skill.name);
    try {
      const attempt = await collaborators.prepareAttempt(agent, store, dataDir, env, lifecycleLock);
      return { ok: true, attempt };
    } finally {
      lifecycleLock.release();
    }
  } catch (error) {
    if (!(error instanceof AgentUsageBusyError)) {
      try {
        store.updateStatus(agent.skill.name, "error");
      } catch (statusError) {
        return {
          ok: false,
          error: new AggregateError(
            [error, statusError],
            `Agent "${agent.skill.name}" 启动准备失败，且 error 状态写回失败。`,
          ),
        };
      }
    }
    return { ok: false, error };
  }
}

export async function finalizeAgentStartAttempt(
  attempt: AgentStartAttempt,
  dataDir: string,
  status: AgentStartFinalStatus,
  options: {
    readonly collaborators?: Partial<FinalizeAgentStartCollaborators>;
  } = {},
): Promise<AgentStartFinalizationResult> {
  const collaborators = {
    ...DEFAULT_FINALIZE_COLLABORATORS,
    ...options.collaborators,
  };
  const registryLock = await collaborators.acquireRegistryLock(dataDir);
  try {
    const store = collaborators.createStore(dataDir, registryLock);
    const currentAgent = store.findByName(attempt.agent.skill.name);
    if (currentAgent === undefined || !sameRegisteredAgentSnapshot(currentAgent, attempt.agent)) {
      return { kind: "stale" };
    }

    const lifecycleLock = await collaborators.acquireLifecycleLock(
      dataDir,
      attempt.agent.skill.name,
    );
    try {
      const runtime = collaborators.readRuntime(dataDir, attempt.agent.skill.name);
      if (
        runtime === undefined ||
        !sameManagedAgentRuntimeIdentity(runtime.identity, attempt.runtimeIdentity)
      ) {
        return { kind: "stale" };
      }
      if (status === "error") {
        if (attempt.started) {
          if (currentAgent.status !== "starting" && currentAgent.status !== "error") {
            return { kind: "stale" };
          }
          const usage = await collaborators.inspectUsage(attempt.agent, dataDir, {
            lifecycleLock,
          });
          if (
            usage.runtime === undefined ||
            !sameManagedAgentRuntimeIdentity(usage.runtime.identity, attempt.runtimeIdentity)
          ) {
            return { kind: "stale" };
          }
          if (usage.blockers.length > 0) {
            if (currentAgent.status === "starting") {
              store.updateStatus(attempt.agent.skill.name, status);
            }
            return { kind: "in-use", blockers: usage.blockers };
          }
          const stopped = await collaborators.stopGracefully(dataDir, attempt.agent.skill.name, {
            expectedIdentity: attempt.runtimeIdentity,
            lifecycleLock,
          });
          if (!stopped) return { kind: "stale" };
          if (currentAgent.status === "starting") {
            store.updateStatus(attempt.agent.skill.name, status);
          }
          return { kind: "committed" };
        }
        if (currentAgent.status !== attempt.agent.status) {
          return { kind: "stale" };
        }
      }
      store.updateStatus(attempt.agent.skill.name, status);
      return { kind: "committed" };
    } finally {
      lifecycleLock.release();
    }
  } finally {
    registryLock.release();
  }
}

export async function cleanupFailedAgentStartAttempt(
  attempt: AgentStartAttempt,
  dataDir: string,
  options: {
    readonly collaborators?: Partial<FailedAgentStartCleanupCollaborators>;
  } = {},
): Promise<FailedAgentStartCleanupResult> {
  const collaborators = {
    ...DEFAULT_FAILED_START_CLEANUP_COLLABORATORS,
    ...options.collaborators,
  };
  const lifecycleLock = await collaborators.acquireLifecycleLock(dataDir, attempt.agent.skill.name);
  try {
    const usage = await collaborators.inspectUsage(attempt.agent, dataDir, { lifecycleLock });
    if (
      usage.runtime === undefined ||
      !sameManagedAgentRuntimeIdentity(usage.runtime.identity, attempt.runtimeIdentity)
    ) {
      return { kind: "stale" };
    }
    if (usage.blockers.length > 0) {
      return { kind: "in-use", blockers: usage.blockers };
    }
    const stopped = await collaborators.stopGracefully(dataDir, attempt.agent.skill.name, {
      expectedIdentity: attempt.runtimeIdentity,
      lifecycleLock,
    });
    return stopped ? { kind: "stopped" } : { kind: "stale" };
  } finally {
    lifecycleLock.release();
  }
}

export interface AgentStartCommandFinalization {
  readonly finalization: AgentStartFinalizationResult | undefined;
  readonly finalizationError: unknown;
  readonly fallbackCleanup: FailedAgentStartCleanupResult | undefined;
  readonly fallbackCleanupError: unknown;
}

export async function finalizeAgentStartForCommand(
  attempt: AgentStartAttempt,
  dataDir: string,
  status: AgentStartFinalStatus,
  options: {
    readonly collaborators?: Partial<FinalizeAgentStartCommandCollaborators>;
  } = {},
): Promise<AgentStartCommandFinalization> {
  const collaborators = {
    ...DEFAULT_FINALIZE_COMMAND_COLLABORATORS,
    ...options.collaborators,
  };
  let finalization: AgentStartFinalizationResult | undefined;
  let finalizationError: unknown;
  let fallbackCleanup: FailedAgentStartCleanupResult | undefined;
  let fallbackCleanupError: unknown;
  try {
    finalization = await collaborators.finalizeAttempt(attempt, dataDir, status);
  } catch (error) {
    finalizationError = error;
    if (status === "error" && attempt.started && error instanceof AgentRegistryBusyError) {
      try {
        fallbackCleanup = await collaborators.cleanupFailedAttempt(attempt, dataDir);
      } catch (cleanupError) {
        fallbackCleanupError = cleanupError;
      }
    }
  }
  return {
    finalization,
    finalizationError,
    fallbackCleanup,
    fallbackCleanupError,
  };
}

function sameRegisteredAgentSnapshot(left: RegisteredAgent, right: RegisteredAgent): boolean {
  const { status: _leftStatus, ...leftRegistration } = left;
  const { status: _rightStatus, ...rightRegistration } = right;
  return JSON.stringify(leftRegistration) === JSON.stringify(rightRegistration);
}

function requireRegisteredAgentSnapshot(
  store: AgentStartStore,
  agentName: string,
): RegisteredAgent {
  const agent = store.findByName(agentName);
  if (agent === undefined) {
    throw new Error(`Agent "${agentName}" 在启动准备期间已从注册表消失。`);
  }
  return agent;
}
