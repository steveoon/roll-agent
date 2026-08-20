import type { CompanionCredentialStore } from "./credentials.ts";
import type { CompanionLogger } from "./logger.ts";
import type { CompanionConfig, CompanionHostStatus } from "./schema.ts";
import type { CompanionSessionFactory, ManagedCompanionSession } from "./host-session.ts";
import {
  COMPANION_RUNTIME_RESTART_MAX_MS,
  COMPANION_RUNTIME_RESTART_MIN_MS,
  OFFICIAL_RELAY_PROFILE,
} from "./constants.ts";

const STABLE_RUNTIME_WINDOW_MS = 30_000;

export class CompanionHostSupervisor {
  private readonly config: CompanionConfig;
  private readonly credentialStore: CompanionCredentialStore;
  private readonly sessionFactory: CompanionSessionFactory;
  private readonly logger: CompanionLogger;
  private phase: CompanionHostStatus["phase"] = "stopped";
  private runtimeOnline = false;
  private lastError: string | undefined;
  private activeSession: ManagedCompanionSession | undefined;
  private activeSessionStopPromise: Promise<void> | undefined;
  private stopSignal = Promise.withResolvers<void>();
  private runPromise: Promise<void> | undefined;
  private stopRequested = false;

  constructor(options: {
    readonly config: CompanionConfig;
    readonly credentialStore: CompanionCredentialStore;
    readonly sessionFactory: CompanionSessionFactory;
    readonly logger: CompanionLogger;
  }) {
    this.config = options.config;
    this.credentialStore = options.credentialStore;
    this.sessionFactory = options.sessionFactory;
    this.logger = options.logger;
  }

  run(signal?: AbortSignal): Promise<void> {
    if (this.runPromise !== undefined) {
      return this.runPromise;
    }
    if (signal?.aborted === true) {
      return Promise.resolve();
    }
    const abort = () => {
      this.requestStop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.runPromise = this.runLoop().finally(() => {
      signal?.removeEventListener("abort", abort);
    });
    return this.runPromise;
  }

  async stop(): Promise<void> {
    this.requestStop();
    await this.runPromise;
  }

  getStatus(): CompanionHostStatus {
    return {
      phase: this.phase,
      enabled: this.config.enabled,
      enrolled: true,
      runtimeOnline: this.runtimeOnline,
      relayProfile: OFFICIAL_RELAY_PROFILE.id,
      deviceId: this.config.deviceId,
      workspaceId: this.config.workspaceId,
      cwd: this.config.cwd,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  private requestStop(): void {
    if (this.stopRequested) {
      return;
    }
    this.stopRequested = true;
    this.phase = "stopping";
    this.stopSignal.resolve();
  }

  private async runLoop(): Promise<void> {
    if (!this.config.enabled) {
      throw new Error("Roll Companion is disabled");
    }
    this.phase = "starting";
    this.logger.info("Companion Host starting with the official Relay profile");
    const credential = await this.credentialStore.get(this.config.credentialRef);
    let restartDelayMs = COMPANION_RUNTIME_RESTART_MIN_MS;
    try {
      while (!this.stopRequested) {
        const startedAt = Date.now();
        try {
          const session = await this.sessionFactory.create(this.config, credential);
          this.activeSession = session;
          this.activeSessionStopPromise = undefined;
          if (this.stopRequested) {
            await this.stopActiveSession();
            break;
          }
          this.runtimeOnline = true;
          this.phase = "running";
          this.lastError = undefined;
          this.logger.info("Companion Runtime is ready");
          await Promise.race([session.runtimeExit, this.stopSignal.promise]);
          this.runtimeOnline = false;
          await this.stopActiveSession();
          if (this.stopRequested) {
            break;
          }
          this.phase = "recovering";
          this.lastError = "Runtime exited unexpectedly";
          this.logger.error("Runtime exited unexpectedly; restarting it before reconnecting Relay");
          if (Date.now() - startedAt >= STABLE_RUNTIME_WINDOW_MS) {
            restartDelayMs = COMPANION_RUNTIME_RESTART_MIN_MS;
          }
        } catch (error: unknown) {
          this.runtimeOnline = false;
          await this.stopActiveSession();
          if (this.stopRequested) {
            throw error;
          }
          this.phase = "recovering";
          this.lastError = classifySessionError(error);
          this.logger.error(this.lastError);
        }
        await waitForRestart(restartDelayMs, this.stopSignal.promise);
        restartDelayMs = Math.min(restartDelayMs * 2, COMPANION_RUNTIME_RESTART_MAX_MS);
      }
    } finally {
      await this.stopActiveSession();
      this.runtimeOnline = false;
      this.phase = "stopped";
      this.logger.info("Companion Host stopped");
    }
  }

  private async stopActiveSession(): Promise<void> {
    const session = this.activeSession;
    if (session !== undefined) {
      const stopPromise =
        this.activeSessionStopPromise ?? Promise.resolve().then(() => session.stop());
      this.activeSessionStopPromise = stopPromise;
      await stopPromise;
      if (this.activeSession === session) {
        this.activeSession = undefined;
        this.activeSessionStopPromise = undefined;
      }
    }
  }
}

async function waitForRestart(delayMs: number, stopSignal: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, delayMs);
  });
  await Promise.race([delay, stopSignal]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

function classifySessionError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Companion session was interrupted";
  }
  const reason = error instanceof Error ? error.message : String(error);
  return `Companion session failed: ${reason}`;
}
