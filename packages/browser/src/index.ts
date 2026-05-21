// Playwright re-exports（避免 agent 直接依赖 playwright-core）
export type { Page, BrowserContext, Browser } from "playwright-core";

// Types
export {
  PLATFORMS,
  PlatformSchema,
  BROWSER_CHANNELS,
  BROWSER_RUNTIME_MODES,
  BROWSER_ACTION_POLICIES,
  BROWSER_FOREGROUND_POLICIES,
  BrowserActionPolicySchema,
  BrowserForegroundPolicySchema,
  BrowserActionApprovalSchema,
  BrowserChannelSchema,
  BrowserPageInfoSchema,
  BrowserLoginStateSourceSchema,
  BrowserRuntimeModeSchema,
  BrowserRuntimeConfigSchema,
  BrowserSecurityConfigSchema,
  BrowserSessionInfoSchema,
  BrowserStatusSchema,
  BrowserAxNodeSchema,
  BrowserAxPropertyValueSchema,
  BrowserAxSnapshotSchema,
  BrowserElementRefHandleSchema,
  BrowserElementRefSchema,
  PageSnapshotSchema,
  WaitOptionsSchema,
} from "./types/index.ts";
export type {
  Platform,
  BrowserActionPolicy,
  BrowserForegroundPolicy,
  BrowserActionApproval,
  BrowserChannel,
  BrowserPageInfo,
  BrowserLoginStateSource,
  BrowserRuntimeMode,
  BrowserRuntimeConfig,
  BrowserSecurityConfig,
  BrowserSessionInfo,
  BrowserStatus,
  BrowserAxNode,
  BrowserAxPropertyValue,
  BrowserAxSnapshot,
  BrowserElementRef,
  BrowserElementRefHandle,
  PageSnapshot,
  WaitOptions,
} from "./types/index.ts";

// Runtime
export { BrowserRuntime } from "./runtime/browser-runtime.ts";
export { NativeCdpController } from "./runtime/native-cdp-controller.ts";
export type {
  NativeCdpControllerOptions,
  NativeCdpCreateIsolatedWorldOptions,
  NativeCdpDescribeNodeOptions,
  NativeCdpDomNode,
  NativeCdpEvaluateOptions,
  NativeCdpBoxModel,
  NativeCdpFrame,
  NativeCdpFrameTree,
  NativeCdpGetBoxModelOptions,
  NativeCdpGetDocumentOptions,
  NativeCdpGetFullAxTreeOptions,
  NativeCdpKeyEventInput,
  NativeCdpMouseEventInput,
  NativeCdpNavigateResult,
  NativeCdpQuerySelectorAllOptions,
  NativeCdpScrollIntoViewOptions,
  NativeCdpWindowState,
} from "./runtime/native-cdp-controller.ts";
export { NativeCdpLocator } from "./runtime/native-cdp-locator.ts";
export type {
  NativeCdpLocatorClickResult,
  NativeCdpLocatorClickOptions,
  NativeCdpLocatorOptions,
  NativeCdpLocatorTarget,
  NativeCdpLocatorWaitOptions,
  NativeCdpRect,
} from "./runtime/native-cdp-locator.ts";
export type { BrowserInspectablePage } from "./runtime/native-cdp-page-client.ts";
export { BrowserContextManager } from "./runtime/context-manager.ts";
export {
  BrowserActionPolicyError,
  assertBrowserActionPreflight,
  isBrowserActionPolicyError,
  isUrlAllowedByDomainAllowlist,
  preflightBrowserAction,
  truncateTextToUtf8Bytes,
} from "./runtime/security.ts";
export type {
  BrowserActionLogHandler,
  BrowserActionApprovalValidationInput,
  BrowserActionApprovalValidator,
  BrowserActionPolicyOptions,
  BrowserActionPreflightDetails,
  BrowserActionPreflightInput,
  BrowserActionPreflightResult,
  BrowserSecurityErrorPayload,
  BrowserSecurityFailureCode,
  TextTruncationResult,
} from "./runtime/security.ts";
export { createBrowserAxSnapshot, isBrowserElementRefHandle } from "./runtime/ax-snapshot.ts";
export { BROWSER_DOM_ACTION_KINDS } from "./runtime/ax-snapshot.ts";
export type {
  BrowserAxSnapshotOptions,
  BrowserDomActionHint,
  BrowserDomActionKind,
} from "./runtime/ax-snapshot.ts";
export { BrowserElementRefStore, clickElementRef, typeElementRef } from "./runtime/element-ref.ts";
export type {
  BrowserElementRefActionResult,
  BrowserElementRefClickDispatcher,
  BrowserElementRefClickOptions,
  BrowserElementRefResolveStrategy,
  BrowserElementRefTarget,
  BrowserElementRefTypeOptions,
} from "./runtime/element-ref.ts";

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
