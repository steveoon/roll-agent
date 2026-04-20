import { createAgentLogger } from "@roll-agent/sdk";
import { BrowserRuntime, BrowserContextManager, SessionStore } from "@roll-agent/browser";
import type { BrowserRuntimeConfig } from "@roll-agent/browser";

/**
 * 模块级单例：所有 MCP session 共享同一个浏览器实例。
 *
 * 单进程 HTTP 服务无并发问题。
 */
let runtime: BrowserRuntime | undefined;
let contextManager: BrowserContextManager | undefined;
let sessionStore: SessionStore | undefined;
let replyAuthorityKeysLoaded = false;
const logger = createAgentLogger("browser-use-agent");

export async function initRuntime(config: BrowserRuntimeConfig): Promise<void> {
  if (runtime) return;

  replyAuthorityKeysLoaded = false;
  sessionStore = new SessionStore(config.sessionsDir);
  runtime = new BrowserRuntime(config);
  await runtime.start();
  contextManager = new BrowserContextManager(runtime, sessionStore);
}

export function getRuntime(): BrowserRuntime {
  if (!runtime) {
    throw new Error("BrowserRuntime not initialized. Call initRuntime() first.");
  }
  return runtime;
}

export function getContextManager(): BrowserContextManager {
  if (!contextManager) {
    throw new Error("BrowserContextManager not initialized. Call initRuntime() first.");
  }
  return contextManager;
}

export function getSessionStore(): SessionStore {
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

export function setRuntimeStateForTests(state: {
  readonly runtime?: BrowserRuntime;
  readonly contextManager?: BrowserContextManager;
  readonly sessionStore?: SessionStore;
}): void {
  runtime = state.runtime;
  contextManager = state.contextManager;
  sessionStore = state.sessionStore;
}

export async function shutdownRuntime(): Promise<void> {
  const currentContextManager = contextManager;
  const currentRuntime = runtime;
  const cleanupErrors: Error[] = [];

  contextManager = undefined;
  runtime = undefined;
  sessionStore = undefined;
  replyAuthorityKeysLoaded = false;

  if (currentContextManager) {
    logger.info("Closing browser contexts...");
    try {
      await currentContextManager.closeAll();
    } catch (error) {
      cleanupErrors.push(new Error("Failed to close browser contexts", { cause: error }));
      logger.error(
        `Failed to close browser contexts: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
    }
  }
  if (currentRuntime) {
    logger.info("Stopping browser process...");
    try {
      await currentRuntime.stop();
    } catch (error) {
      cleanupErrors.push(new Error("Failed to stop browser runtime", { cause: error }));
      logger.error(
        `Failed to stop browser runtime: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
    }
  }

  logger.info("Browser runtime shutdown complete");

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Browser runtime shutdown failed");
  }
}
