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

export async function shutdownRuntime(): Promise<void> {
  if (contextManager) {
    logger.info("Closing browser contexts...");
    await contextManager.closeAll();
    contextManager = undefined;
  }
  if (runtime) {
    logger.info("Stopping browser process...");
    await runtime.stop();
    runtime = undefined;
  }
  sessionStore = undefined;
  replyAuthorityKeysLoaded = false;
  logger.info("Browser runtime shutdown complete");
}
