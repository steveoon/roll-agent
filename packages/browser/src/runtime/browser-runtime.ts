import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import type { BrowserChannel, BrowserRuntimeConfig, BrowserRuntimeMode } from "../types/index.ts";
import { NativeCdpPageClient } from "./native-cdp-page-client.ts";
import type { BrowserInspectablePage } from "./native-cdp-page-client.ts";
import { decorateManagedProfile, ensureProfileCleanExit } from "./profile-decoration.ts";

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

type BrowserRuntimeDependencies = {
  readonly spawn: SpawnBrowserProcess;
  readonly connectOverCDP: ConnectBrowserOverCdp;
  readonly fetch: FetchCdpEndpoint;
};

const DEFAULT_BROWSER_RUNTIME_DEPENDENCIES = {
  spawn: (...args) => childProcess.spawn(...args),
  connectOverCDP: (...args) => chromium.connectOverCDP(...args),
  fetch: (...args) => globalThis.fetch(...args),
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

async function isHttpCdpReady(
  cdpUrl: string,
  deps: BrowserRuntimeDependencies,
): Promise<boolean> {
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

  constructor(
    config: BrowserRuntimeConfig,
    deps: Partial<BrowserRuntimeDependencies> = {},
  ) {
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

  private buildLaunchArgs(userDataDir: string): string[] {
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
      ...(this.config.headless ? ["--headless=new", "--disable-gpu"] : []),
      ...(this.config.args ?? []),
    ];
  }

  private async startManagedCdp(): Promise<void> {
    const executable = resolveExecutable(this.config);
    const userDataDir = resolveManagedUserDataDir(this.config);
    const cdpUrl = resolveManagedCdpUrl(this.config);

    mkdirSync(userDataDir, { recursive: true });
    decorateManagedProfile(userDataDir);
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

  async openNativePage(url: string): Promise<BrowserInspectablePage> {
    return await this.getNativePageClient().openPage(url);
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
