// Playwright re-exports（避免 agent 直接依赖 playwright-core）
export type { Page, BrowserContext, Browser } from "playwright-core";

// Types
export {
  PLATFORMS,
  PlatformSchema,
  BROWSER_CHANNELS,
  BROWSER_RUNTIME_MODES,
  BrowserChannelSchema,
  BrowserPageInfoSchema,
  BrowserLoginStateSourceSchema,
  BrowserRuntimeModeSchema,
  BrowserRuntimeConfigSchema,
  BrowserSessionInfoSchema,
  BrowserStatusSchema,
  PageSnapshotSchema,
  WaitOptionsSchema,
} from "./types/index.ts";
export type {
  Platform,
  BrowserChannel,
  BrowserPageInfo,
  BrowserLoginStateSource,
  BrowserRuntimeMode,
  BrowserRuntimeConfig,
  BrowserSessionInfo,
  BrowserStatus,
  PageSnapshot,
  WaitOptions,
} from "./types/index.ts";

// Runtime
export { BrowserRuntime } from "./runtime/browser-runtime.ts";
export { BrowserContextManager } from "./runtime/context-manager.ts";

// Session
export { SessionStore } from "./session/session-store.ts";
export { captureLocalStorage, installLocalStorageSnapshot } from "./session/session-state.ts";

// Page actions
export {
  snapshot,
  clickElement,
  typeText,
  navigateTo,
  waitForSelector,
} from "./page/page-actions.ts";

// Wait strategies
export {
  waitForNetworkIdle,
  waitForSelectorVisible,
  waitForCondition,
} from "./page/wait-strategies.ts";
