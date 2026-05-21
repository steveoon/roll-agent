import { createAgentLogger } from "@roll-agent/sdk";
import { BrowserRuntime, BrowserContextManager, SessionStore } from "@roll-agent/browser";
import type { BrowserRuntimeConfig } from "@roll-agent/browser";
import { BrowserInstancePool, type BrowserRuntimeBundle } from "./browser-instance-pool.ts";
import type { BrowserInstancesConfig } from "./runtime-config.ts";

/**
 * 模块级运行时池：所有 MCP session 共享同一组 browser instances。
 *
 * 单进程 HTTP 服务中，通过 browserInstance 显式选择 profile/CDP runtime。
 */
let instancePool: BrowserInstancePool | undefined;
let runtime: BrowserRuntime | undefined;
let contextManager: BrowserContextManager | undefined;
let sessionStore: SessionStore | undefined;
let replyAuthorityKeysLoaded = false;
const logger = createAgentLogger("browser-use-agent");

export async function initRuntime(
  config: BrowserRuntimeConfig,
  instancesConfig?: BrowserInstancesConfig,
): Promise<void> {
  if (instancePool || runtime) return;

  replyAuthorityKeysLoaded = false;
  instancePool = new BrowserInstancePool(config, instancesConfig);

  const defaultInstanceId = instancePool.getDefaultInstanceId();
  const firstBundle = instancePool.listBundles()[0];
  const defaultBundle =
    defaultInstanceId !== undefined ? instancePool.getBundle(defaultInstanceId) : firstBundle;
  if (defaultBundle !== undefined) {
    runtime = defaultBundle.runtime;
    contextManager = defaultBundle.contextManager;
    sessionStore = defaultBundle.sessionStore;
  }
}

export function getRuntime(): BrowserRuntime {
  if (instancePool) {
    return instancePool.getBundle().runtime;
  }
  if (!runtime) {
    throw new Error("BrowserRuntime not initialized. Call initRuntime() first.");
  }
  return runtime;
}

export function getContextManager(): BrowserContextManager {
  if (instancePool) {
    return instancePool.getBundle().contextManager;
  }
  if (!contextManager) {
    throw new Error("BrowserContextManager not initialized. Call initRuntime() first.");
  }
  return contextManager;
}

export function getSessionStore(): SessionStore {
  if (instancePool) {
    return instancePool.getBundle().sessionStore;
  }
  if (!sessionStore) {
    throw new Error("SessionStore not initialized. Call initRuntime() first.");
  }
  return sessionStore;
}

export function setReplyAuthorityKeysLoaded(loaded: boolean): void {
  replyAuthorityKeysLoaded = loaded;
}

export function getReplyAuthorityKeysLoaded(): boolean {
  return replyAuthorityKeysLoaded;
}

export function getBrowserInstancePoolOrUndefined(): BrowserInstancePool | undefined {
  return instancePool;
}

export function getBrowserInstancePool(): BrowserInstancePool {
  if (!instancePool) {
    throw new Error("BrowserInstancePool not initialized. Call initRuntime() first.");
  }
  return instancePool;
}

export async function ensureCurrentBundleStarted(): Promise<void> {
  await getBrowserInstancePool().ensureBundleStarted();
}

export function isConfiguredMultiBrowserInstancePool(): boolean {
  return instancePool !== undefined && !instancePool.isLegacySingleInstancePool();
}

export function resolveRecruitmentTrackingAgentId(defaultAgentId?: string): string | undefined {
  if (!instancePool) {
    return defaultAgentId;
  }

  let bundle: BrowserRuntimeBundle;
  try {
    bundle = instancePool.getBundle();
  } catch {
    return undefined;
  }

  return bundle.trackingAgentId ?? defaultAgentId;
}

export function getCurrentBrowserBundle(): BrowserRuntimeBundle {
  return getBrowserInstancePool().getBundle();
}

export function setRuntimeStateForTests(state: {
  readonly runtime?: BrowserRuntime;
  readonly contextManager?: BrowserContextManager;
  readonly sessionStore?: SessionStore;
  readonly instancePool?: BrowserInstancePool;
}): void {
  instancePool = state.instancePool;
  runtime = state.runtime;
  contextManager = state.contextManager;
  sessionStore = state.sessionStore;
}

export async function shutdownRuntime(): Promise<void> {
  const currentInstancePool = instancePool;
  const currentContextManager = contextManager;
  const currentRuntime = runtime;
  const cleanupErrors: Error[] = [];

  instancePool = undefined;
  contextManager = undefined;
  runtime = undefined;
  sessionStore = undefined;
  replyAuthorityKeysLoaded = false;

  if (currentInstancePool) {
    logger.info("Closing browser instance pool...");
    try {
      await currentInstancePool.closeAll();
    } catch (error) {
      cleanupErrors.push(new Error("Failed to close browser instance pool", { cause: error }));
      logger.error(
        `Failed to close browser instance pool: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  } else if (currentContextManager) {
    logger.info("Closing browser contexts...");
    try {
      await currentContextManager.closeAll();
    } catch (error) {
      cleanupErrors.push(new Error("Failed to close browser contexts", { cause: error }));
      logger.error(
        `Failed to close browser contexts: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
  if (!currentInstancePool && currentRuntime) {
    logger.info("Stopping browser process...");
    try {
      await currentRuntime.stop();
    } catch (error) {
      cleanupErrors.push(new Error("Failed to stop browser runtime", { cause: error }));
      logger.error(
        `Failed to stop browser runtime: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  logger.info("Browser runtime shutdown complete");

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Browser runtime shutdown failed");
  }
}
