import { resolve } from "node:path";
import {
  AgentLifecycleBusyError,
  acquireAgentLifecycleLock,
  type AgentLifecycleLock,
} from "./process-manager.ts";

const AGENT_REGISTRY_LIFECYCLE_LOCK_NAME = "\u0000roll-agent-registry";
const DEFAULT_AGENT_REGISTRY_LOCK_TIMEOUT_MS = 15_000;
const AGENT_REGISTRY_LOCK_RETRY_MS = 50;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface AgentRegistryLock {
  release(): void;
}

interface AgentRegistryLockState {
  readonly dataDir: string;
  readonly lifecycleLock: AgentLifecycleLock;
  released: boolean;
}

const registryLockStates = new WeakMap<AgentRegistryLock, AgentRegistryLockState>();

export function acquireAgentRegistryLock(
  dataDir: string,
  options: { readonly timeoutMs?: number } = {},
): AgentRegistryLock {
  const resolvedDataDir = resolve(dataDir);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_AGENT_REGISTRY_LOCK_TIMEOUT_MS);
  let lifecycleLock: AgentLifecycleLock;
  while (true) {
    try {
      lifecycleLock = acquireAgentLifecycleLock(
        resolvedDataDir,
        AGENT_REGISTRY_LIFECYCLE_LOCK_NAME,
      );
      break;
    } catch (error) {
      if (!(error instanceof AgentLifecycleBusyError)) throw error;
      if (Date.now() >= deadline) {
        throw new AgentRegistryBusyError();
      }
      Atomics.wait(sleepBuffer, 0, 0, AGENT_REGISTRY_LOCK_RETRY_MS);
    }
  }

  return createAgentRegistryLock(resolvedDataDir, lifecycleLock);
}

export async function acquireAgentRegistryLockAsync(
  dataDir: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<AgentRegistryLock> {
  const resolvedDataDir = resolve(dataDir);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_AGENT_REGISTRY_LOCK_TIMEOUT_MS);
  while (true) {
    try {
      const lifecycleLock = acquireAgentLifecycleLock(
        resolvedDataDir,
        AGENT_REGISTRY_LIFECYCLE_LOCK_NAME,
      );
      return createAgentRegistryLock(resolvedDataDir, lifecycleLock);
    } catch (error) {
      if (!(error instanceof AgentLifecycleBusyError)) throw error;
      if (Date.now() >= deadline) throw new AgentRegistryBusyError();
      await sleep(AGENT_REGISTRY_LOCK_RETRY_MS);
    }
  }
}

export function assertAgentRegistryLock(lock: AgentRegistryLock, dataDir: string): void {
  const state = registryLockStates.get(lock);
  if (state === undefined || state.released || state.dataDir !== resolve(dataDir)) {
    throw new Error("Invalid Agent registry lock handle.");
  }
}

export class AgentRegistryBusyError extends Error {
  readonly code = "agent_registry_busy" as const;

  constructor() {
    super("Agent 注册表正在被另一项操作修改，请稍后重试。");
    this.name = "AgentRegistryBusyError";
  }
}

function releaseAgentRegistryLock(lock: AgentRegistryLock): void {
  const state = registryLockStates.get(lock);
  if (state === undefined || state.released) return;
  state.released = true;
  registryLockStates.delete(lock);
  state.lifecycleLock.release();
}

function createAgentRegistryLock(
  dataDir: string,
  lifecycleLock: AgentLifecycleLock,
): AgentRegistryLock {
  const lock: AgentRegistryLock = {
    release: () => releaseAgentRegistryLock(lock),
  };
  registryLockStates.set(lock, {
    dataDir,
    lifecycleLock,
    released: false,
  });
  return lock;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
