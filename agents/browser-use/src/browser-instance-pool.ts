import { AsyncLocalStorage } from "node:async_hooks";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StructuredToolError } from "@roll-agent/sdk";
import {
  BrowserContextManager,
  BrowserRuntime,
  BrowserRuntimeConfigSchema,
  probeBrowserRuntimeCdpHealth,
  SessionStore,
  type BrowserInstanceStatus,
  type BrowserRuntimeConfig,
  type BrowserWindowBounds,
  type Platform,
} from "@roll-agent/browser";
import {
  getPrimaryWorkArea,
  resolveAutoWindowBoundsForIndex,
} from "./auto-window-layout.ts";
import type { BrowserInstancesConfig } from "./runtime-config.ts";

export const LEGACY_INSTANCE_ID = "default";
const DEFAULT_SESSIONS_ROOT = join(homedir(), ".roll-agent", "browser", "sessions");

export interface BrowserRuntimeBundle {
  readonly id: string;
  readonly platform?: Platform;
  readonly trackingAgentId?: string;
  readonly runtime: BrowserRuntime;
  readonly contextManager: BrowserContextManager;
  readonly sessionStore: SessionStore;
  readonly config: BrowserRuntimeConfig;
}

type BrowserInstanceRuntimeConfig = BrowserInstancesConfig["instances"][string];

const currentBrowserInstance = new AsyncLocalStorage<string | undefined>();

export class BrowserInstancePool {
  private readonly bundles = new Map<string, BrowserRuntimeBundle>();
  private readonly defaultInstanceId: string | undefined;
  private readonly startPromises = new Map<string, Promise<void>>();

  constructor(
    globalRuntimeConfig: BrowserRuntimeConfig,
    instancesConfig: BrowserInstancesConfig | undefined,
  ) {
    if (instancesConfig === undefined || Object.keys(instancesConfig.instances).length === 0) {
      const bundle = createRuntimeBundle({
        id: LEGACY_INSTANCE_ID,
        runtimeConfig: globalRuntimeConfig,
      });
      this.bundles.set(bundle.id, bundle);
      this.defaultInstanceId = bundle.id;
      return;
    }

    this.defaultInstanceId = instancesConfig.defaultInstance;
    const instanceEntries = Object.entries(instancesConfig.instances);
    for (const [index, [id, instance]] of instanceEntries.entries()) {
      const runtimeConfig = buildInstanceRuntimeConfig(globalRuntimeConfig, id, instance, {
        index,
        total: instanceEntries.length,
      });
      const bundle = createRuntimeBundle({
        id,
        runtimeConfig,
        ...(instance.platform !== undefined ? { platform: instance.platform } : {}),
        ...(instance.trackingAgentId !== undefined
          ? { trackingAgentId: instance.trackingAgentId }
          : {}),
      });
      this.bundles.set(id, bundle);
    }
  }

  getDefaultInstanceId(): string | undefined {
    return this.defaultInstanceId;
  }

  listBundles(): readonly BrowserRuntimeBundle[] {
    return [...this.bundles.values()];
  }

  isLegacySingleInstancePool(): boolean {
    if (this.bundles.size !== 1) {
      return false;
    }
    return this.bundles.keys().next().value === LEGACY_INSTANCE_ID;
  }

  resolvePrimaryInstanceId(): string | undefined {
    return this.defaultInstanceId ?? this.getOnlyInstanceId();
  }

  async ensureBundleStarted(browserInstance?: string): Promise<BrowserRuntimeBundle> {
    const bundle = this.getBundle(browserInstance);
    await this.ensureStarted(bundle.id);
    return bundle;
  }

  async ensureStarted(bundleId: string): Promise<void> {
    const bundle = this.bundles.get(bundleId);
    if (bundle === undefined) {
      throw new Error(`Browser instance "${bundleId}" was not found.`);
    }

    if (bundle.runtime.isRunning()) {
      return;
    }

    const existingPromise = this.startPromises.get(bundleId);
    if (existingPromise !== undefined) {
      await existingPromise;
      return;
    }

    const startPromise = bundle.runtime.start().catch(async (error: unknown) => {
      this.startPromises.delete(bundleId);
      throw error;
    });
    this.startPromises.set(bundleId, startPromise);
    try {
      await startPromise;
    } finally {
      this.startPromises.delete(bundleId);
    }
  }

  getBundle(browserInstance?: string): BrowserRuntimeBundle {
    const requested = browserInstance ?? currentBrowserInstance.getStore();
    const id = requested ?? this.defaultInstanceId ?? this.getOnlyInstanceId();
    if (id === undefined) {
      throw new StructuredToolError({
        code: "needs_input",
        message: "browserInstance is required because multiple browser instances are configured.",
        details: {
          availableInstances: [...this.bundles.keys()],
        },
      });
    }

    const bundle = this.bundles.get(id);
    if (bundle === undefined) {
      throw new StructuredToolError({
        code: "browser_instance_not_found",
        message: `Browser instance "${id}" was not found.`,
        details: {
          availableInstances: [...this.bundles.keys()],
        },
      });
    }
    return bundle;
  }

  async getInstanceStatuses(): Promise<BrowserInstanceStatus[]> {
    return await Promise.all(
      this.listBundles().map(async (bundle) => {
        const [cdp, profile] = await Promise.all([
          probeBrowserRuntimeCdpHealth(bundle.config),
          inspectProfile(bundle.config.userDataDir),
        ]);
        return {
          id: bundle.id,
          ...(bundle.platform !== undefined ? { platform: bundle.platform } : {}),
          mode: bundle.config.mode,
          cdp,
          profile,
          tracking: getTrackingStatus(bundle.trackingAgentId),
        };
      }),
    );
  }

  async closeAll(): Promise<void> {
    const cleanupErrors: Error[] = [];
    const pendingStarts = [...this.startPromises.entries()];
    const startResults = await Promise.allSettled(pendingStarts.map(([, promise]) => promise));
    for (const [index, result] of startResults.entries()) {
      if (result.status === "rejected") {
        cleanupErrors.push(
          new Error(
            `Failed to finish browser startup for ${pendingStarts[index]?.[0] ?? "unknown"}`,
            { cause: result.reason },
          ),
        );
      }
    }

    for (const bundle of this.bundles.values()) {
      try {
        await bundle.contextManager.closeAll();
      } catch (error) {
        cleanupErrors.push(
          new Error(`Failed to close browser contexts for ${bundle.id}`, { cause: error }),
        );
      }
      try {
        await bundle.runtime.stop();
      } catch (error) {
        cleanupErrors.push(
          new Error(`Failed to stop browser runtime for ${bundle.id}`, { cause: error }),
        );
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Browser instance pool shutdown failed");
    }
  }

  private getOnlyInstanceId(): string | undefined {
    if (this.bundles.size !== 1) {
      return undefined;
    }
    return this.bundles.keys().next().value;
  }
}

export async function runWithBrowserInstance<T>(
  browserInstance: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return await currentBrowserInstance.run(browserInstance, run);
}

function buildInstanceRuntimeConfig(
  globalRuntimeConfig: BrowserRuntimeConfig,
  id: string,
  instance: BrowserInstanceRuntimeConfig,
  layout: { readonly index: number; readonly total: number },
): BrowserRuntimeConfig {
  const headless = instance.headless ?? globalRuntimeConfig.headless;
  const windowBounds =
    instance.windowBounds ?? resolveAutoWindowBounds({ instance, headless, ...layout });

  return BrowserRuntimeConfigSchema.parse({
    ...globalRuntimeConfig,
    mode: instance.mode,
    headless,
    instanceId: id,
    profileName: instance.profileName ?? id,
    cdpUrl: instance.cdpUrl,
    cdpHost: instance.cdpHost,
    cdpPort: instance.cdpPort,
    channel: instance.channel,
    executablePath: instance.executablePath,
    userDataDir: instance.userDataDir,
    args: instance.args,
    windowBounds,
    sessionsDir: instance.sessionsDir ?? join(DEFAULT_SESSIONS_ROOT, id),
  });
}

function resolveAutoWindowBounds(input: {
  readonly instance: BrowserInstanceRuntimeConfig;
  readonly headless: boolean;
  readonly index: number;
  readonly total: number;
}): BrowserWindowBounds | undefined {
  if (input.total <= 1 || input.headless || input.instance.mode !== "managed-cdp") {
    return undefined;
  }

  return resolveAutoWindowBoundsForIndex({
    index: input.index,
    total: input.total,
    workArea: getPrimaryWorkArea(),
  });
}

function createRuntimeBundle(input: {
  readonly id: string;
  readonly runtimeConfig: BrowserRuntimeConfig;
  readonly platform?: Platform;
  readonly trackingAgentId?: string;
}): BrowserRuntimeBundle {
  const sessionStore = new SessionStore(input.runtimeConfig.sessionsDir);
  const runtime = new BrowserRuntime(input.runtimeConfig);
  const contextManager = new BrowserContextManager(runtime, sessionStore);
  return {
    id: input.id,
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    ...(input.trackingAgentId !== undefined ? { trackingAgentId: input.trackingAgentId } : {}),
    runtime,
    contextManager,
    sessionStore,
    config: input.runtimeConfig,
  };
}

async function inspectProfile(
  userDataDir: string | undefined,
): Promise<BrowserInstanceStatus["profile"]> {
  if (userDataDir === undefined) {
    return {
      exists: false,
      writable: false,
    };
  }

  const exists = await canAccess(userDataDir, constants.F_OK);
  const writable = await canAccess(userDataDir, constants.W_OK);
  return {
    userDataDir,
    exists,
    writable,
  };
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function getTrackingStatus(trackingAgentId: string | undefined): BrowserInstanceStatus["tracking"] {
  if (trackingAgentId !== undefined) {
    return {
      source: "instance",
      agentIdFingerprint: createFingerprint(trackingAgentId),
    };
  }

  const defaultAgentId = process.env["RECRUITMENT_EVENTS_DEFAULT_AGENT_ID"]?.trim();
  if (defaultAgentId !== undefined && defaultAgentId.length > 0) {
    return {
      source: "default-env",
      agentIdFingerprint: createFingerprint(defaultAgentId),
    };
  }

  return { source: "missing" };
}

function createFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
