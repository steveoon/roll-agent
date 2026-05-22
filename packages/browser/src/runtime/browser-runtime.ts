import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import type {
  BrowserChannel,
  BrowserRuntimeConfig,
  BrowserRuntimeMode,
  BrowserWindowBounds,
} from "../types/index.ts";
import { NativeCdpController } from "./native-cdp-controller.ts";
import type {
  NativeCdpControllerOptions,
  NativeCdpWindowBounds,
  NativeCdpWindowState,
} from "./native-cdp-controller.ts";
import { NativeCdpPageClient } from "./native-cdp-page-client.ts";
import type { BrowserInspectablePage } from "./native-cdp-page-client.ts";
import { decorateManagedProfile, ensureProfileCleanExit } from "./profile-decoration.ts";
import { assertBrowserActionPreflight } from "./security.ts";
import type { BrowserActionPolicyOptions } from "./security.ts";

const MANAGED_CDP_READY_TIMEOUT_MS = 15_000;
const MANAGED_CDP_READY_POLL_MS = 250;
const MANAGED_SHUTDOWN_TIMEOUT_MS = 5_000;

const DEFAULT_MANAGED_PROFILE_DIR = join(
  homedir(),
  ".roll-agent",
  "browser",
  "profiles",
  "managed-default",
);

type SupportedPlatform = "darwin" | "linux" | "win32";

const CHANNEL_EXECUTABLE_CANDIDATES = {
  chrome: {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ],
    linux: ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  chromium: {
    darwin: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
    linux: ["chromium", "chromium-browser"],
    win32: [
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
    ],
  },
  msedge: {
    darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    linux: ["microsoft-edge", "microsoft-edge-stable"],
    win32: [
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
} as const satisfies Record<BrowserChannel, Record<SupportedPlatform, readonly string[]>>;

type BrowserRuntimeOwnership = {
  ownsBrowserProcess: boolean;
  managedProcess?: ChildProcess;
};

type SpawnBrowserProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: childProcess.SpawnOptions,
) => ChildProcess;

type ConnectBrowserOverCdp = (
  cdpUrl: string,
  options?: {
    readonly timeout?: number;
  },
) => Promise<Browser>;

type FetchCdpEndpoint = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => ReturnType<typeof globalThis.fetch>;

type ConnectNativeCdpPage = (options: NativeCdpControllerOptions) => Promise<NativeCdpController>;

type BrowserRuntimeDependencies = {
  readonly spawn: SpawnBrowserProcess;
  readonly connectOverCDP: ConnectBrowserOverCdp;
  readonly fetch: FetchCdpEndpoint;
  readonly connectNativePage: ConnectNativeCdpPage;
};

const DEFAULT_BROWSER_RUNTIME_DEPENDENCIES = {
  spawn: (...args) => childProcess.spawn(...args),
  connectOverCDP: (...args) => chromium.connectOverCDP(...args),
  fetch: (...args) => globalThis.fetch(...args),
  connectNativePage: (...args) => NativeCdpController.connect(...args),
} satisfies BrowserRuntimeDependencies;

function isSupportedExecutablePlatform(value: NodeJS.Platform): value is SupportedPlatform {
  return value === "darwin" || value === "linux" || value === "win32";
}

function resolveChannelExecutable(channel: BrowserChannel): string {
  if (!isSupportedExecutablePlatform(process.platform)) {
    throw new Error(`Unsupported platform for managed-cdp browser launch: ${process.platform}`);
  }

  const candidates = CHANNEL_EXECUTABLE_CANDIDATES[channel][process.platform];
  if (process.platform === "linux") {
    const firstCandidate = candidates[0];
    if (!firstCandidate) {
      throw new Error(`No executable candidates configured for channel "${channel}".`);
    }
    return firstCandidate;
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`No installed browser found for channel "${channel}".`);
}

function resolveExecutable(config: BrowserRuntimeConfig): string {
  if (config.executablePath !== undefined) {
    return config.executablePath;
  }
  return resolveChannelExecutable(config.channel);
}

function resolveManagedUserDataDir(config: BrowserRuntimeConfig): string {
  return config.userDataDir ?? DEFAULT_MANAGED_PROFILE_DIR;
}

function resolveManagedCdpUrl(config: BrowserRuntimeConfig): string {
  return `http://${config.cdpHost}:${config.cdpPort}`;
}

function resolveManagedProfileName(config: BrowserRuntimeConfig): string | undefined {
  return config.profileName ?? config.instanceId;
}

function resolveManagedProfileDecoration(
  config: BrowserRuntimeConfig,
): { readonly name?: string; readonly color?: string } | undefined {
  const name = resolveManagedProfileName(config);
  const color = config.profileColor;
  if (name === undefined && color === undefined) {
    return undefined;
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(color !== undefined ? { color } : {}),
  };
}

function resolveInspectableCdpBaseUrl(config: BrowserRuntimeConfig): string {
  if (config.mode === "managed-cdp") {
    return resolveManagedCdpUrl(config);
  }

  const cdpUrl = config.cdpUrl;
  if (cdpUrl === undefined) {
    throw new Error(`Browser runtime mode "${config.mode}" requires cdpUrl.`);
  }

  const parsed = new URL(cdpUrl);
  switch (parsed.protocol) {
    case "http:":
    case "https:":
      return `${parsed.protocol}//${parsed.host}`;
    case "ws:":
      return `http://${parsed.host}`;
    case "wss:":
      return `https://${parsed.host}`;
    default:
      throw new Error(`Unsupported CDP protocol for inspectable pages: ${parsed.protocol}`);
  }
}

async function isHttpCdpReady(cdpUrl: string, deps: BrowserRuntimeDependencies): Promise<boolean> {
  try {
    const versionUrl = new URL("/json/version", cdpUrl);
    const response = await deps.fetch(versionUrl, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildWindowLaunchArgs(bounds: BrowserWindowBounds | undefined): string[] {
  if (bounds === undefined) {
    return [];
  }

  return [
    ...(bounds.x !== undefined && bounds.y !== undefined
      ? [`--window-position=${String(bounds.x)},${String(bounds.y)}`]
      : []),
    ...(bounds.width !== undefined && bounds.height !== undefined
      ? [`--window-size=${String(bounds.width)},${String(bounds.height)}`]
      : []),
  ];
}

function toNormalNativeWindowBounds(bounds: BrowserWindowBounds): NativeCdpWindowBounds {
  return {
    ...(bounds.x !== undefined ? { x: bounds.x } : {}),
    ...(bounds.y !== undefined ? { y: bounds.y } : {}),
    ...(bounds.width !== undefined ? { width: bounds.width } : {}),
    ...(bounds.height !== undefined ? { height: bounds.height } : {}),
    state: "normal",
  };
}

async function waitForManagedCdp(
  cdpUrl: string,
  proc: ChildProcess,
  deps: BrowserRuntimeDependencies,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MANAGED_CDP_READY_TIMEOUT_MS) {
    if (proc.exitCode !== null) {
      throw new Error(
        `Managed browser exited before CDP became ready (exit code ${proc.exitCode}).`,
      );
    }
    if (await isHttpCdpReady(cdpUrl, deps)) {
      return;
    }
    await delay(MANAGED_CDP_READY_POLL_MS);
  }
  throw new Error(`Managed browser did not expose CDP within ${MANAGED_CDP_READY_TIMEOUT_MS}ms.`);
}

async function terminateProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) {
    return;
  }

  proc.kill("SIGTERM");
  const startedAt = Date.now();
  while (Date.now() - startedAt < MANAGED_SHUTDOWN_TIMEOUT_MS) {
    if (proc.exitCode !== null) {
      return;
    }
    await delay(50);
  }

  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
  }
}

/**
 * Browser runtime with explicit connection modes:
 * - lifecycle: launch / stop / own the browser process
 * - attach: expose Playwright Browser on demand
 * - native pages: delegate pre-attach tab management to NativeCdpPageClient
 */
export class BrowserRuntime {
  private browser: Browser | undefined;
  private nativePages: NativeCdpPageClient | undefined;
  private readonly config: BrowserRuntimeConfig;
  private readonly deps: BrowserRuntimeDependencies;
  private ownership: BrowserRuntimeOwnership = { ownsBrowserProcess: false };

  constructor(config: BrowserRuntimeConfig, deps: Partial<BrowserRuntimeDependencies> = {}) {
    this.config = config;
    this.deps = {
      ...DEFAULT_BROWSER_RUNTIME_DEPENDENCIES,
      ...deps,
    };
  }

  async start(): Promise<void> {
    if (this.hasConnectedBrowser()) return;
    if (this.mode === "managed-cdp" && this.hasManagedProcess()) return;

    switch (this.config.mode) {
      case "managed-cdp":
        await this.startManagedCdp();
        break;
      case "remote-cdp":
      case "existing-session":
        await this.connectViaCdp(this.requireCdpUrl());
        break;
    }
  }

  private requireCdpUrl(): string {
    const cdpUrl = this.config.cdpUrl;
    if (cdpUrl === undefined) {
      throw new Error(`Browser runtime mode "${this.config.mode}" requires cdpUrl.`);
    }
    return cdpUrl;
  }

  private hasConnectedBrowser(): boolean {
    return this.browser !== undefined && this.browser.isConnected();
  }

  private hasManagedProcess(): boolean {
    return (
      this.ownership.ownsBrowserProcess &&
      this.ownership.managedProcess !== undefined &&
      this.ownership.managedProcess.exitCode === null
    );
  }

  private async connectViaCdp(
    cdpUrl: string,
    options: { readonly preserveOwnership?: boolean } = {},
  ): Promise<Browser> {
    const browser = await this.deps.connectOverCDP(cdpUrl, {
      timeout: 10_000,
    });
    this.browser = browser;
    if (!options.preserveOwnership) {
      this.ownership = { ownsBrowserProcess: false };
    }
    return browser;
  }

  private async ensureInspectableCdpReady(): Promise<void> {
    if (this.mode === "managed-cdp" && !this.hasManagedProcess()) {
      await this.startManagedCdp();
    }
  }

  private getInspectableCdpBaseUrl(): string {
    return resolveInspectableCdpBaseUrl(this.config);
  }

  private getNativePageClient(): NativeCdpPageClient {
    if (!this.nativePages) {
      this.nativePages = new NativeCdpPageClient({
        fetch: this.deps.fetch,
        ensureReady: async () => await this.ensureInspectableCdpReady(),
        resolveBaseUrl: () => this.getInspectableCdpBaseUrl(),
      });
    }
    return this.nativePages;
  }

  private async getBrowserWebSocketDebuggerUrl(): Promise<string | undefined> {
    await this.ensureInspectableCdpReady();
    const versionUrl = new URL("/json/version", this.getInspectableCdpBaseUrl());
    const response = await this.deps.fetch(versionUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return undefined;
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!isRecord(payload)) {
      return undefined;
    }

    const webSocketDebuggerUrl = payload["webSocketDebuggerUrl"];
    return typeof webSocketDebuggerUrl === "string" ? webSocketDebuggerUrl : undefined;
  }

  private buildLaunchArgs(userDataDir: string): string[] {
    const profileName = resolveManagedProfileName(this.config);
    return [
      `--remote-debugging-port=${this.config.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--password-store=basic",
      ...(profileName !== undefined ? [`--window-name=${profileName}`] : []),
      ...(!this.config.headless ? buildWindowLaunchArgs(this.config.windowBounds) : []),
      ...(this.config.headless ? ["--headless=new", "--disable-gpu"] : []),
      ...(this.config.args ?? []),
    ];
  }

  private async applyManagedWindowBounds(): Promise<void> {
    const bounds = this.config.windowBounds;
    if (bounds === undefined || this.config.headless) {
      return;
    }

    try {
      const browserWebSocketDebuggerUrl = await this.getBrowserWebSocketDebuggerUrl();
      if (browserWebSocketDebuggerUrl === undefined) {
        return;
      }

      const page = (await this.getNativePageClient().listPages())[0];
      if (page === undefined) {
        return;
      }

      const controller = await this.deps.connectNativePage({
        webSocketDebuggerUrl: browserWebSocketDebuggerUrl,
        commandTimeoutMs: 2_000,
      });
      try {
        const windowId = await controller.getWindowIdForTarget(page.targetId, {
          timeoutMs: 2_000,
        });
        await controller.setWindowBounds(windowId, toNormalNativeWindowBounds(bounds), {
          timeoutMs: 2_000,
        });
      } finally {
        controller.close();
      }
    } catch {
      // Window placement is a desktop UX hint. Browser startup must not fail if
      // the OS/window manager rejects the move or the CDP window target is absent.
    }
  }

  private async startManagedCdp(): Promise<void> {
    const executable = resolveExecutable(this.config);
    const userDataDir = resolveManagedUserDataDir(this.config);
    const cdpUrl = resolveManagedCdpUrl(this.config);

    mkdirSync(userDataDir, { recursive: true });
    decorateManagedProfile(userDataDir, resolveManagedProfileDecoration(this.config));
    ensureProfileCleanExit(userDataDir);

    const proc = this.deps.spawn(executable, this.buildLaunchArgs(userDataDir), {
      stdio: ["ignore", "ignore", "pipe"],
    });

    try {
      await waitForManagedCdp(cdpUrl, proc, this.deps);
      this.ownership = {
        ownsBrowserProcess: true,
        managedProcess: proc,
      };
      await this.applyManagedWindowBounds();
    } catch (error) {
      await terminateProcess(proc).catch(() => {});
      throw error;
    }
  }

  async stop(): Promise<void> {
    const browser = this.browser;
    const ownership = this.ownership;

    this.browser = undefined;
    this.ownership = { ownsBrowserProcess: false };

    if (browser) {
      await browser.close();
    }

    if (ownership.ownsBrowserProcess && ownership.managedProcess) {
      await terminateProcess(ownership.managedProcess);
    }
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;

    if (browser) {
      await browser.close();
    }
  }

  isRunning(): boolean {
    return this.hasConnectedBrowser() || this.hasManagedProcess();
  }

  async getBrowser(): Promise<Browser> {
    if (this.hasConnectedBrowser() && this.browser) {
      return this.browser;
    }

    switch (this.mode) {
      case "managed-cdp":
        if (!this.hasManagedProcess()) {
          await this.startManagedCdp();
        }
        return await this.connectViaCdp(resolveManagedCdpUrl(this.config), {
          preserveOwnership: true,
        });
      case "remote-cdp":
      case "existing-session":
        return await this.connectViaCdp(this.requireCdpUrl());
    }
  }

  async listNativePages(): Promise<ReadonlyArray<BrowserInspectablePage>> {
    return await this.getNativePageClient().listPages();
  }

  async activateNativePage(targetId: string): Promise<void> {
    await this.getNativePageClient().activatePage(targetId);
  }

  async openNativePage(
    url: string,
    options: BrowserActionPolicyOptions = {},
  ): Promise<BrowserInspectablePage> {
    assertBrowserActionPreflight({
      action: "navigate",
      target: url,
      url,
      security: options.security ?? this.config.security,
      ...(options.approval !== undefined ? { approval: options.approval } : {}),
      ...(options.approveAction !== undefined ? { approveAction: options.approveAction } : {}),
      ...(options.onActionLog !== undefined ? { onActionLog: options.onActionLog } : {}),
    });
    return await this.getNativePageClient().openPage(url);
  }

  async connectNativePage(
    pageOrTargetId: string | BrowserInspectablePage,
    options: {
      readonly commandTimeoutMs?: number;
      readonly connectTimeoutMs?: number;
      readonly allowUnsafeRuntimeEnableForDiagnostics?: boolean;
    } & BrowserActionPolicyOptions = {},
  ): Promise<NativeCdpController> {
    const page =
      typeof pageOrTargetId === "string"
        ? (await this.listNativePages()).find((candidate) => candidate.targetId === pageOrTargetId)
        : pageOrTargetId;

    if (page === undefined) {
      throw new Error(`Native CDP target "${pageOrTargetId}" was not found in /json/list.`);
    }

    if (page.webSocketDebuggerUrl === undefined) {
      throw new Error(`Native CDP target "${page.targetId}" does not expose webSocketDebuggerUrl.`);
    }

    await this.ensureInspectableCdpReady();
    return await this.deps.connectNativePage({
      webSocketDebuggerUrl: page.webSocketDebuggerUrl,
      ...options,
    });
  }

  async getNativePageWindowState(targetId: string): Promise<NativeCdpWindowState> {
    try {
      const webSocketDebuggerUrl = await this.getBrowserWebSocketDebuggerUrl();
      if (webSocketDebuggerUrl === undefined) {
        return "unknown";
      }

      const controller = await this.deps.connectNativePage({
        webSocketDebuggerUrl,
        commandTimeoutMs: 2_000,
        connectTimeoutMs: 2_000,
      });
      try {
        return await controller.getWindowStateForTarget(targetId, {
          timeoutMs: 2_000,
        });
      } finally {
        controller.close();
      }
    } catch {
      return "unknown";
    }
  }

  getConfig(): BrowserRuntimeConfig {
    return this.config;
  }

  get mode(): BrowserRuntimeMode {
    return this.config.mode;
  }

  usesPersistentProfile(): boolean {
    return this.mode === "managed-cdp" || this.mode === "existing-session";
  }

  prefersExistingContext(): boolean {
    return true;
  }

  allowsNewContext(): boolean {
    return this.mode === "remote-cdp";
  }

  shouldRestoreSessionSnapshot(): boolean {
    return this.mode === "remote-cdp";
  }
}
