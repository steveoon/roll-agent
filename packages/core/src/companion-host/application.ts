import { defaultSecretsEnvPath } from "../config/secrets-env.ts";
import {
  inspectEnvironmentDiagnostics,
  describeEnvironmentDiagnostics,
} from "../config/environment-diagnostics.ts";
import type { EnvironmentDiagnostics } from "../config/environment-diagnostic-schema.ts";
import { buildScheduledServiceBaselineEnv } from "../config/placeholder-audit.ts";
import { access } from "node:fs/promises";
import {
  COMPANION_CONTROL_PROTOCOL_VERSION,
  OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE,
  OFFICIAL_RELAY_PROFILE,
  RELAY_HOST_OVERRIDE_ENV,
  resolveRelayEndpoint,
  type RelayEndpoint,
} from "./constants.ts";
import { FileCompanionConfigStore, type CompanionConfigStore } from "./config-store.ts";
import { createPlatformCredentialStore, type CompanionCredentialStore } from "./credentials.ts";
import {
  CompanionEnrollmentService,
  OfficialDeviceEnrollmentClient,
  type DeviceEnrollmentClient,
} from "./enrollment.ts";
import { DefaultCompanionSessionFactory, type CompanionSessionFactory } from "./host-session.ts";
import { CompanionControlServer, sendCompanionControlRequest } from "./ipc.ts";
import { createBundledRollInvocation, type BundledRollInvocation } from "./invocation.ts";
import {
  FileCompanionLogger,
  followCompanionLogs,
  readCompanionLogs,
  type CompanionLogger,
} from "./logger.ts";
import { createCompanionUserIdentityCheck, type CompanionUserIdentityCheck } from "./identity.ts";
import { createCompanionPaths, type CompanionPaths } from "./paths.ts";
import {
  companionServiceIdentity,
  createPlatformServiceController,
  type CompanionServiceController,
  type CompanionServiceStatus,
} from "./service.ts";
import type {
  CompanionConfig,
  CompanionDoctorCheck,
  CompanionDoctorResult,
  CompanionHostStatus,
  CompanionManagementStatus,
  CompanionControlRequest,
  CompanionControlResponse,
} from "./schema.ts";
import { CompanionHostSupervisor } from "./supervisor.ts";
import { canonicalizeCompanionWorkspace } from "./workspace.ts";

export interface CompanionApplicationOptions {
  readonly paths: CompanionPaths;
  readonly platform: NodeJS.Platform;
  readonly configStore: CompanionConfigStore;
  readonly credentialStore: CompanionCredentialStore;
  readonly enrollmentClient: DeviceEnrollmentClient;
  readonly serviceController: CompanionServiceController;
  readonly invocation: BundledRollInvocation;
  readonly logger: CompanionLogger;
  readonly sessionFactory: CompanionSessionFactory;
  readonly sendControlRequest?: CompanionControlClient;
  readonly assertUserIdentity?: CompanionUserIdentityCheck;
  readonly inspectEnvironment?: (
    cwd: string,
    environment: EnvironmentDiagnostics["environment"],
  ) => EnvironmentDiagnostics;
}

export type CompanionControlClient = (
  endpoint: string,
  request: CompanionControlRequest,
  options?: { readonly timeoutMs?: number },
) => Promise<CompanionControlResponse>;

export class CompanionApplication {
  readonly paths: CompanionPaths;
  private readonly platform: NodeJS.Platform;
  private readonly configStore: CompanionConfigStore;
  private readonly credentialStore: CompanionCredentialStore;
  private readonly enrollment: CompanionEnrollmentService;
  private readonly service: CompanionServiceController;
  private readonly invocation: BundledRollInvocation;
  private readonly logger: CompanionLogger;
  private readonly sessionFactory: CompanionSessionFactory;
  private readonly sendControlRequest: CompanionControlClient;
  private readonly assertUserIdentity: CompanionUserIdentityCheck;
  private readonly inspectEnvironment: NonNullable<
    CompanionApplicationOptions["inspectEnvironment"]
  >;

  constructor(options: CompanionApplicationOptions) {
    this.inspectEnvironment =
      options.inspectEnvironment ??
      ((cwd, environment) =>
        inspectEnvironmentDiagnostics({
          cwd,
          environment,
          secretsPath: defaultSecretsEnvPath(options.paths.homeDir),
          env: environment === "service" ? process.env : buildScheduledServiceBaselineEnv(),
        }));
    this.paths = options.paths;
    this.platform = options.platform;
    this.configStore = options.configStore;
    this.credentialStore = options.credentialStore;
    this.enrollment = new CompanionEnrollmentService({
      configStore: options.configStore,
      credentialStore: options.credentialStore,
      enrollmentClient: options.enrollmentClient,
    });
    this.service = options.serviceController;
    this.invocation = options.invocation;
    this.logger = options.logger;
    this.sessionFactory = options.sessionFactory;
    this.sendControlRequest = options.sendControlRequest ?? sendCompanionControlRequest;
    this.assertUserIdentity =
      options.assertUserIdentity ??
      createCompanionUserIdentityCheck({ platform: options.platform });
  }

  async enroll(input: {
    readonly pairingCode: string;
    readonly workspace: string;
    readonly signal?: AbortSignal;
  }): Promise<CompanionConfig> {
    await this.assertUserIdentity();
    await this.stop();
    return this.enrollment.enroll(input);
  }

  async unenroll(): Promise<boolean> {
    await this.stop();
    return this.enrollment.unenroll();
  }

  async enable(): Promise<CompanionConfig> {
    await this.assertUserIdentity();
    const config = await this.enrollment.setEnabled(true);
    const service = await this.service.status();
    if (service.installed) {
      await this.service.start();
    }
    return config;
  }

  async disable(): Promise<CompanionConfig> {
    await this.stop();
    return this.enrollment.setEnabled(false);
  }

  async setWorkspace(workspace: string): Promise<CompanionConfig> {
    await this.assertUserIdentity();
    const service = await this.service.status();
    await this.stop();
    const config = await this.enrollment.setWorkspace(workspace);
    if (config.enabled && service.installed) {
      await this.service.start();
    }
    return config;
  }

  async installService(): Promise<void> {
    await this.assertUserIdentity();
    const config = await this.requireConfig();
    if (!config.enabled) {
      throw new Error("Enable Roll Companion before installing its service");
    }
    await this.stop();
    const preflight = this.inspectEnvironment(config.cwd, "estimated-service");
    if (preflight.issues.length > 0) {
      this.logger.info(
        `后台环境预检（估算，未验证实际服务环境）：${describeEnvironmentDiagnostics(preflight)}`,
      );
    }
    await this.service.install();
  }

  async uninstallService(): Promise<void> {
    await this.stop();
    await this.service.uninstall();
  }

  async start(): Promise<void> {
    await this.assertUserIdentity();
    const config = await this.requireConfig();
    if (!config.enabled) {
      throw new Error("Roll Companion is disabled");
    }
    await this.service.start();
  }

  async stop(): Promise<void> {
    try {
      const response = await this.sendControlRequest(
        this.paths.controlEndpoint,
        {
          version: COMPANION_CONTROL_PROTOCOL_VERSION,
          type: "stop",
        },
        { timeoutMs: 60_000 },
      );
      if (!response.ok) {
        throw new Error("Roll Companion rejected the stop request");
      }
    } catch (error: unknown) {
      if (!isMissingControlEndpointError(error)) {
        throw error;
      }
      // A missing local control endpoint is expected when the service is already stopped or is
      // still starting; the platform service controller below remains authoritative.
    }
    await this.service.stop();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async getStatus(): Promise<CompanionManagementStatus> {
    try {
      const response = await this.sendControlRequest(this.paths.controlEndpoint, {
        version: COMPANION_CONTROL_PROTOCOL_VERSION,
        type: "diagnostics",
      });
      if (response.ok) {
        return {
          ...response.status,
          ...(response.environmentDiagnostics === undefined
            ? {}
            : { environmentDiagnostics: response.environmentDiagnostics }),
        };
      }
    } catch {
      // A failed diagnostics request does not prove that the service or Runtime is offline.
    }
    try {
      // Also covers older daemons rejecting diagnostics and diagnostic-only transport failures.
      const legacy = await this.sendControlRequest(this.paths.controlEndpoint, {
        version: COMPANION_CONTROL_PROTOCOL_VERSION,
        type: "status",
      });
      if (legacy.ok) return legacy.status;
    } catch {
      // Only estimate from persisted state after both read-only requests fail.
    }
    const config = await this.configStore.load();
    if (config === null) {
      return stoppedStatus(null);
    }
    const service = await this.service.status().catch(() => ({ installed: false, running: false }));
    return {
      ...stoppedStatus(config),
      phase: service.running ? "starting" : "stopped",
      environmentDiagnostics: this.inspectEnvironment(config.cwd, "estimated-service"),
    };
  }

  async runForeground(signal?: AbortSignal): Promise<void> {
    await this.assertUserIdentity();
    const config = await this.configStore.load();
    if (config === null) {
      this.logger.info("Companion Host is not enrolled; exiting cleanly");
      return;
    }
    if (!config.enabled) {
      // A disabled config is a deliberate clean stop. LaunchAgent KeepAlive only restarts
      // unsuccessful exits, so login startup cannot enter a restart loop.
      this.logger.info("Companion Host is disabled; exiting cleanly");
      return;
    }
    let relayEndpoint: RelayEndpoint;
    try {
      relayEndpoint = resolveRelayEndpoint();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE) {
        // An undecided official endpoint is a deliberate kill switch; a malformed override is a
        // configuration error and must fail the service instead of reading as a clean stop.
        this.logger.info(`${reason}; exiting cleanly`);
        return;
      }
      this.logger.error(reason);
      throw error;
    }
    this.logger.info(`Companion Host uses ${describeRelayEndpoint(relayEndpoint)}`);
    const supervisor = new CompanionHostSupervisor({
      config,
      credentialStore: this.credentialStore,
      sessionFactory: this.sessionFactory,
      logger: this.logger,
    });
    const control = new CompanionControlServer({
      endpoint: this.paths.controlEndpoint,
      platform: this.platform,
      logger: this.logger,
      handlers: {
        getStatus: () => supervisor.getStatus(),
        getDiagnostics: () => this.inspectEnvironment(config.cwd, "service"),
        stop: () => supervisor.stop(),
      },
    });
    await control.start();
    try {
      await supervisor.run(signal);
    } finally {
      await supervisor.stop().catch(() => undefined);
      await control.close();
    }
  }

  async doctor(): Promise<CompanionDoctorResult> {
    const checks: CompanionDoctorCheck[] = [];
    checks.push({
      name: "platform",
      ok: this.platform === "darwin" || this.platform === "win32",
      detail:
        this.platform === "darwin" || this.platform === "win32"
          ? `Supported per-user service platform: ${this.platform}`
          : `Unsupported Companion platform: ${this.platform}`,
    });
    try {
      const endpoint = resolveRelayEndpoint();
      checks.push({
        name: "relay-endpoint",
        ok: true,
        detail: describeRelayEndpoint(endpoint),
      });
    } catch (error: unknown) {
      checks.push({
        name: "relay-endpoint",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    checks.push({
      name: "bundled-runtime",
      ok:
        (await pathExists(this.invocation.command)) &&
        (await pathExists(this.invocation.cliEntrypoint)),
      detail: "Companion uses absolute bundled Node and Roll CLI paths",
    });
    let config: CompanionConfig | null = null;
    try {
      config = await this.configStore.load();
      checks.push({
        name: "enrollment",
        ok: config !== null,
        detail: config === null ? "Companion is not enrolled" : "Companion config is valid",
      });
    } catch {
      checks.push({ name: "enrollment", ok: false, detail: "Companion config is invalid" });
    }
    if (config !== null) {
      try {
        const canonical = await canonicalizeCompanionWorkspace(config.cwd);
        checks.push({
          name: "workspace",
          ok: canonical === config.cwd,
          detail:
            canonical === config.cwd
              ? "Workspace is an existing canonical directory"
              : "Workspace path is no longer canonical",
        });
      } catch {
        checks.push({ name: "workspace", ok: false, detail: "Workspace directory is unavailable" });
      }
      try {
        const credential = await this.credentialStore.get(config.credentialRef);
        checks.push({
          name: "credential",
          ok: credential.length >= 16,
          detail:
            credential.length >= 16
              ? "Device credential is available in OS-protected storage"
              : "Device credential is invalid",
        });
      } catch {
        checks.push({
          name: "credential",
          ok: false,
          detail: "Device credential is unavailable from OS-protected storage",
        });
      }
    }
    const service = await this.service.status().catch(() => ({ installed: false, running: false }));
    checks.push({
      name: "service",
      ok: service.installed,
      detail: describeService(service),
    });
    const status = await this.getStatus().catch(
      (): CompanionManagementStatus => stoppedStatus(config),
    );
    const diagnostics = status.environmentDiagnostics;
    checks.push({
      name: "runtime",
      ok: status.runtimeOnline,
      detail: status.runtimeOnline
        ? "Runtime 已完成初始化；未验证模型远端认证。"
        : "Runtime 尚未在线；服务已安装不代表 Runtime 可用。",
    });
    checks.push({
      name: "environment",
      ok: diagnostics?.environment === "service" && !diagnostics.blocking,
      detail:
        diagnostics === undefined
          ? "当前后台服务未提供环境诊断。检查配置和服务状态；旧版服务需升级并重启后再检查。"
          : `${diagnostics.environment === "service" ? "后台进程实际环境" : "后台环境预检（估算，尚未验证实际服务环境）"}。${diagnostics.issues.length === 0 ? "未发现配置引用问题；未验证远端认证。" : describeEnvironmentDiagnostics(diagnostics)}`,
    });
    return {
      ok: checks.every((check) => check.ok),
      checks,
      ...(diagnostics === undefined ? {} : { environmentDiagnostics: diagnostics }),
    };
  }

  readLogs(): Promise<string> {
    return readCompanionLogs(this.paths.logPath);
  }

  followLogs(onText: (text: string) => void, signal: AbortSignal): Promise<void> {
    return followCompanionLogs(this.paths.logPath, onText, signal);
  }

  private async requireConfig(): Promise<CompanionConfig> {
    const config = await this.configStore.load();
    if (config === null) {
      throw new Error("Roll Companion is not enrolled");
    }
    return config;
  }
}

export function createDefaultCompanionApplication(
  options: {
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
    readonly invocation?: BundledRollInvocation;
  } = {},
): CompanionApplication {
  const platform = options.platform ?? process.platform;
  const paths = createCompanionPaths(options.homeDir, platform);
  const invocation = options.invocation ?? createBundledRollInvocation();
  const logger = new FileCompanionLogger(paths.logPath);
  const credentialStore = createPlatformCredentialStore(paths.secretsDir, platform);
  return new CompanionApplication({
    paths,
    platform,
    configStore: new FileCompanionConfigStore(paths.configPath),
    credentialStore,
    enrollmentClient: new OfficialDeviceEnrollmentClient(),
    serviceController: createPlatformServiceController({
      identity: companionServiceIdentity(paths, invocation),
      platform,
    }),
    invocation,
    logger,
    sessionFactory: new DefaultCompanionSessionFactory({
      invocation,
      configPath: paths.configPath,
    }),
  });
}

function stoppedStatus(config: CompanionConfig | null): CompanionHostStatus {
  return {
    phase: "stopped",
    enabled: config?.enabled ?? false,
    enrolled: config !== null,
    runtimeOnline: false,
    relayProfile: OFFICIAL_RELAY_PROFILE.id,
    ...(config !== null
      ? { deviceId: config.deviceId, workspaceId: config.workspaceId, cwd: config.cwd }
      : {}),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function describeRelayEndpoint(endpoint: RelayEndpoint): string {
  return endpoint.source === "official"
    ? `the official Relay host ${endpoint.host}`
    : `a ${RELAY_HOST_OVERRIDE_ENV} override targeting ${endpoint.companionUrl}`;
}

function describeService(service: CompanionServiceStatus): string {
  if (!service.installed) {
    return "Per-user Companion service is not installed";
  }
  return service.running
    ? "Per-user Companion service is installed and running"
    : "Per-user Companion service is installed but stopped";
}

function isMissingControlEndpointError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED")
  );
}
