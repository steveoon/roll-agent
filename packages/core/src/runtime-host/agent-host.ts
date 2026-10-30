import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import {
  OBSERVATION_RETENTION_META_KEY,
  observationRetentionDeclarationSchema,
  type ObservationRetentionDeclaration,
} from "@roll-agent/protocol/observation-retention";
import {
  AGENT_BOOTSTRAP_MAX_CONCURRENCY,
  mapWithBoundedConcurrency,
  type AgentHost,
  type AgentHostOperation,
  type AgentHostSnapshot,
  type AgentHostRefresh,
  type AgentHostInstallResult,
  type AgentToolSource,
  type SourceTool,
  type ToolAnnotations,
  type ToolResourceHint,
} from "@roll-agent/runtime/host-contracts";
import {
  ROLL_RESOURCE_HINTS_META_KEY,
  TOOL_RESOURCE_ACCESS_MODES,
  TOOL_RESOURCE_HINT_KINDS,
} from "@roll-agent/runtime/tool-contracts";
import type { SkillLibrary } from "@roll-agent/runtime/skills";
import {
  McpClientManager,
  McpConnectionCleanupError,
  type McpScopedConnectionAcquisition,
} from "../mcp/client-manager.ts";
import { AgentStore } from "../registry/store.ts";
import { resolveTransportWithDevSpawnSpec } from "../registry/dev-spawn.ts";
import { getAgentPid, startAgent, waitForAgentReady } from "../registry/process-manager.ts";
import {
  acquireAgentUsageLease,
  getExitedAgentUsageNames,
  type AgentUsageLease,
} from "../registry/agent-usage-lease.ts";
import {
  formatToolSchemaIssue,
  formatAppOutputDiscoveryIssue,
  normalizeListedTools,
} from "../cli/utils/agent-tools.ts";
import { getAgentEnv } from "../config/helpers.ts";
import {
  catalogPackageSpec,
  getAgentCatalog,
  type AgentCatalogEntry,
} from "../registry/catalog.ts";
import { resolveAgentCatalog } from "../registry/catalog-discovery.ts";
import { installAgent, type InstallAgentEvent } from "../registry/install.ts";
import type { RollConfig } from "../config/schema.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import { createSkillLibrary } from "../skills/library.ts";

const HOST_CLOSING_MESSAGE = "CoreAgentHost is closing";
const AGENT_BOOTSTRAP_CONNECT_TIMEOUT_MS = 30_000;
const AGENT_BOOTSTRAP_LIST_TOOLS_TIMEOUT_MS = 60_000;

export interface AgentBootstrapIssue {
  readonly agentName: string;
  readonly message: string;
}

export type EnsureAgentReady = (
  agent: RegisteredAgent,
  env: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
) => Promise<void>;

export type AcquireAgentUsage = (
  agent: RegisteredAgent,
  env: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
) => Promise<AgentUsageLease | undefined>;

export interface CoreAgentHostOptions {
  readonly config: RollConfig;
  readonly agents?: readonly RegisteredAgent[];
  /** Defaults to a private manager. Shared connections also share one Sampling context. */
  readonly clientManager?: Pick<McpClientManager, "connectScoped">;
  readonly ensureAgentReady?: EnsureAgentReady;
  readonly acquireAgentUsage?: AcquireAgentUsage;
  readonly onAgentBootstrapIssue?: (issue: AgentBootstrapIssue) => void;
  readonly skillLibrary?: SkillLibrary | null;
  readonly onSkillLibraryIssue?: (message: string) => void;
  readonly installAgentFn?: typeof installAgent;
  readonly resolveCatalogFn?: typeof resolveAgentCatalog;
}

interface ConnectAgentSourceOptions {
  readonly signal: AbortSignal;
  readonly deadlineAt?: number;
}

interface AgentBootstrapAttempt {
  readonly source?: AgentToolSource;
  readonly issues: readonly AgentBootstrapIssue[];
}

class AgentBootstrapTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent bootstrap timed out after ${String(timeoutMs)}ms`);
    this.name = "AgentBootstrapTimeoutError";
  }
}

class AgentBootstrapCleanupError extends AggregateError {
  readonly cleanupErrors: readonly unknown[];

  constructor(agentName: string, operationError: unknown, cleanupErrors: readonly unknown[]) {
    const cleanupSummary = cleanupErrors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join("; ");
    super(
      [operationError, ...cleanupErrors],
      `Agent "${agentName}" bootstrap failed and resource cleanup also failed: ${cleanupSummary}`,
    );
    this.name = "AgentBootstrapCleanupError";
    this.cleanupErrors = cleanupErrors;
  }
}

function createEngineClosingError(): Error {
  return new Error(HOST_CLOSING_MESSAGE);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function remainingStepTimeout(localTimeoutMs: number, deadlineAt: number | undefined): number {
  if (deadlineAt === undefined) {
    return localTimeoutMs;
  }
  return Math.max(1, Math.min(localTimeoutMs, deadlineAt - Date.now()));
}

function throwIfDeadlineExpired(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new Error("Agent bootstrap deadline expired");
  }
}

function extractAnnotations(listed: unknown): ToolAnnotations | undefined {
  if (!isRecord(listed) || !isRecord(listed.annotations)) {
    return undefined;
  }
  const annotations = listed.annotations;
  const result: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
  if (typeof annotations.readOnlyHint === "boolean") {
    result.readOnlyHint = annotations.readOnlyHint;
  }
  if (typeof annotations.destructiveHint === "boolean") {
    result.destructiveHint = annotations.destructiveHint;
  }
  return result.readOnlyHint === undefined && result.destructiveHint === undefined
    ? undefined
    : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractObservationRetention(listed: unknown): {
  readonly declaration?: ObservationRetentionDeclaration;
  readonly issue?: string;
} {
  if (!isRecord(listed) || !isRecord(listed._meta)) return {};
  if (!Object.hasOwn(listed._meta, OBSERVATION_RETENTION_META_KEY)) return {};
  const parsed = observationRetentionDeclarationSchema.safeParse(
    listed._meta[OBSERVATION_RETENTION_META_KEY],
  );
  return parsed.success ? { declaration: parsed.data } : { issue: "声明字段无效" };
}

function isResourceHintKind(value: string): value is ToolResourceHint["kind"] {
  return Object.values(TOOL_RESOURCE_HINT_KINDS).some((kind) => kind === value);
}

function isResourceAccessMode(value: string): value is NonNullable<ToolResourceHint["mode"]> {
  return Object.values(TOOL_RESOURCE_ACCESS_MODES).some((mode) => mode === value);
}

interface ResourceHintExtraction {
  readonly hints: readonly ToolResourceHint[] | undefined;
  readonly issue: string | undefined;
}

function invalidResourceHints(issue: string): ResourceHintExtraction {
  return { hints: undefined, issue };
}

function extractResourceHints(listed: unknown): ResourceHintExtraction {
  if (!isRecord(listed) || !isRecord(listed._meta)) {
    return { hints: undefined, issue: undefined };
  }
  if (!Object.hasOwn(listed._meta, ROLL_RESOURCE_HINTS_META_KEY)) {
    return { hints: undefined, issue: undefined };
  }
  const rawHints = listed._meta[ROLL_RESOURCE_HINTS_META_KEY];
  if (!Array.isArray(rawHints)) {
    return invalidResourceHints("必须是数组");
  }
  const hints: ToolResourceHint[] = [];
  for (const [index, value] of rawHints.entries()) {
    if (
      !isRecord(value) ||
      typeof value.field !== "string" ||
      value.field.trim().length === 0 ||
      typeof value.kind !== "string" ||
      !isResourceHintKind(value.kind) ||
      (value.mode !== undefined &&
        (typeof value.mode !== "string" || !isResourceAccessMode(value.mode))) ||
      (value.namespace !== undefined && typeof value.namespace !== "string") ||
      (value.kind === TOOL_RESOURCE_HINT_KINDS.custom &&
        (typeof value.namespace !== "string" || value.namespace.trim().length === 0))
    ) {
      return invalidResourceHints(`第 ${String(index + 1)} 项字段无效`);
    }
    const namespace =
      value.kind === TOOL_RESOURCE_HINT_KINDS.custom && typeof value.namespace === "string"
        ? value.namespace.trim()
        : undefined;
    hints.push({
      field: value.field.trim(),
      kind: value.kind,
      ...(value.mode !== undefined ? { mode: value.mode } : {}),
      ...(namespace !== undefined ? { namespace } : {}),
    });
  }
  return { hints: hints.length > 0 ? hints : undefined, issue: undefined };
}

function formatInstallEventLine(event: InstallAgentEvent): string {
  if (event.type === "retry") {
    return `安装遇到网络问题，${Math.round(event.delayMs / 1000)}s 后重试（第 ${event.attempt + 1} 次）...`;
  }
  return event.type === "warn" ? `警告：${event.message}` : event.message;
}

async function ensureCoreManagedAgentReady(
  agent: RegisteredAgent,
  dataDir: string,
  env: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (agent.runtime.ownership !== "core-managed") {
    return;
  }

  if (getAgentPid(dataDir, agent.skill.name) === undefined) {
    startAgent(agent, dataDir, env);
  }
  await waitForAgentReady(agent, { ...(signal ? { signal } : {}) });
}

/** Owns host resources acquired for one engine; Runtime owns session state. */
export class CoreAgentHost implements AgentHost {
  private readonly config: RollConfig;
  private readonly manager: Pick<McpClientManager, "connectScoped">;
  private readonly explicitAgents: readonly RegisteredAgent[] | undefined;
  private readonly explicitSkillLibrary: SkillLibrary | null | undefined;
  private readonly onSkillLibraryIssue: CoreAgentHostOptions["onSkillLibraryIssue"];
  private skillLibraryIssues = new Set<string>();
  private readonly onAgentBootstrapIssue: CoreAgentHostOptions["onAgentBootstrapIssue"];
  private readonly acquireAgentUsage: AcquireAgentUsage;
  private readonly installAgentFn: typeof installAgent;
  private readonly resolveCatalogFn: typeof resolveAgentCatalog;
  private readonly installedAgents = new Map<string, RegisteredAgent>();
  private readonly agentUsageLeases = new Map<string, AgentUsageLease>();
  private readonly connections = new Map<string, McpScopedConnectionAcquisition>();
  private readonly cleanupConnections = new Set<McpScopedConnectionAcquisition>();
  private readonly unresolvedCleanupErrors: unknown[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly shutdownController = new AbortController();
  private sampling:
    | { readonly model: LanguageModelV4; readonly options: SharedV4ProviderOptions | undefined }
    | undefined;
  private resolvedCatalog: readonly AgentCatalogEntry[] | undefined;
  private disposePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: CoreAgentHostOptions) {
    this.config = options.config;
    this.manager = options.clientManager ?? new McpClientManager();
    this.explicitAgents = options.agents;
    this.explicitSkillLibrary = options.skillLibrary;
    this.onSkillLibraryIssue = options.onSkillLibraryIssue;
    this.onAgentBootstrapIssue = options.onAgentBootstrapIssue;
    this.installAgentFn = options.installAgentFn ?? installAgent;
    this.resolveCatalogFn = options.resolveCatalogFn ?? resolveAgentCatalog;
    this.acquireAgentUsage =
      options.acquireAgentUsage ??
      (options.ensureAgentReady
        ? async (agent, env, signal) => {
            await options.ensureAgentReady?.(agent, env, signal);
            return undefined;
          }
        : (agent, env, signal) => this.acquireDefaultAgentUsage(agent, env, signal));
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.closing) throw createEngineClosingError();
    signal?.throwIfAborted();
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  private currentAgents(): readonly RegisteredAgent[] {
    return this.explicitAgents ?? new AgentStore(this.config.agents.dataDir).list();
  }

  private currentCatalog(): readonly AgentCatalogEntry[] {
    if (this.explicitAgents !== undefined) return [];
    return this.resolvedCatalog ?? getAgentCatalog(this.config);
  }

  private resolveSkillLibrary(agents = this.currentAgents()): SkillLibrary | undefined {
    if (this.explicitSkillLibrary === null) return undefined;
    if (this.explicitSkillLibrary !== undefined) return this.explicitSkillLibrary;
    const issues = new Set<string>();
    const library = createSkillLibrary({
      agents,
      extraDirs: this.config.skills.dirs,
      onIssue: (message) => {
        issues.add(message);
        if (!this.skillLibraryIssues.has(message)) this.onSkillLibraryIssue?.(message);
      },
    });
    this.skillLibraryIssues = issues;
    return library;
  }

  private async acquireDefaultAgentUsage(
    agent: RegisteredAgent,
    env: Readonly<Record<string, string>> | undefined,
    signal?: AbortSignal,
  ): Promise<AgentUsageLease | undefined> {
    const lease = await acquireAgentUsageLease(agent, this.config.agents.dataDir, env, {
      holderKind: "chat",
      startIfStopped: true,
      ...(signal ? { signal } : {}),
    });
    if (lease !== undefined) return lease;
    await ensureCoreManagedAgentReady(agent, this.config.agents.dataDir, env, signal);
    return undefined;
  }

  updateSampling(model: LanguageModelV4, options: SharedV4ProviderOptions | undefined): void {
    this.assertOpen();
    if (this.sampling?.model === model && this.sampling.options === options) return;
    this.sampling = { model, options };
    for (const connection of this.connections.values()) connection.setSampling(model, options);
  }

  prepare(input: AgentHostOperation): Promise<AgentHostSnapshot> {
    this.assertOpen(input.signal);
    this.sampling ??= { model: input.model, options: input.providerOptions };
    return this.track(this.runPrepare(input));
  }

  private async runPrepare(input: AgentHostOperation): Promise<AgentHostSnapshot> {
    const timeoutMs = this.config.runtime.agentBootstrap.timeoutMs;
    const deadlineAt = Date.now() + timeoutMs;
    const agents = this.currentAgents();
    const timeoutController = new AbortController();
    const timeoutError = new AgentBootstrapTimeoutError(timeoutMs);
    const signal = AbortSignal.any([
      input.signal,
      this.shutdownController.signal,
      timeoutController.signal,
    ]);
    const expireBudgetIfNeeded = (): void => {
      if (!signal.aborted && Date.now() >= deadlineAt) timeoutController.abort(timeoutError);
    };
    const timeoutHandle = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
    const timeoutAttempt = (
      agent: RegisteredAgent,
      cleanupError?: AgentBootstrapCleanupError,
    ): AgentBootstrapAttempt => ({
      issues: [
        { agentName: agent.skill.name, message: timeoutError.message },
        ...(cleanupError ? [{ agentName: agent.skill.name, message: cleanupError.message }] : []),
      ],
    });
    try {
      if (this.explicitAgents === undefined) {
        try {
          this.resolvedCatalog = await this.resolveCatalogFn(this.config, {
            allowNetwork: false,
            signal,
            ...(this.config.install.registry ? { registry: this.config.install.registry } : {}),
          });
        } catch (error) {
          this.assertOpen(input.signal);
          expireBudgetIfNeeded();
          if (!timeoutController.signal.aborted) throw error;
        }
      }
      this.assertOpen(input.signal);
      expireBudgetIfNeeded();
      const attempts = await mapWithBoundedConcurrency(
        agents,
        AGENT_BOOTSTRAP_MAX_CONCURRENCY,
        async (agent): Promise<AgentBootstrapAttempt> => {
          const issues: AgentBootstrapIssue[] = [];
          try {
            expireBudgetIfNeeded();
            signal.throwIfAborted();
            const source = await this.connectAgentSource(agent, (issue) => issues.push(issue), {
              signal,
              deadlineAt,
            });
            return { source, issues };
          } catch (error) {
            this.assertOpen(input.signal);
            expireBudgetIfNeeded();
            if (timeoutController.signal.aborted) {
              return timeoutAttempt(
                agent,
                error instanceof AgentBootstrapCleanupError ? error : undefined,
              );
            }
            issues.push({
              agentName: agent.skill.name,
              message: error instanceof Error ? error.message : String(error),
            });
            return { issues };
          }
        },
        { signal, onSkipped: (agent) => timeoutAttempt(agent) },
      );
      this.assertOpen(input.signal);
      const sources: AgentToolSource[] = [];
      for (const attempt of attempts) {
        for (const issue of attempt.issues) this.onAgentBootstrapIssue?.(issue);
        if (attempt.source) sources.push(attempt.source);
      }
      const skillLibrary = this.resolveSkillLibrary(agents);
      const catalog = this.currentCatalog().map(({ shortName, description }) => ({
        shortName,
        description,
      }));
      return {
        sources,
        ...(skillLibrary ? { skillLibrary } : {}),
        ...(catalog.length > 0 ? { catalog } : {}),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async connectAgentSource(
    agent: RegisteredAgent,
    reportIssue: (issue: AgentBootstrapIssue) => void,
    options: ConnectAgentSourceOptions,
  ): Promise<AgentToolSource> {
    this.assertOpen(options.signal);
    throwIfDeadlineExpired(options.deadlineAt);
    const transport = resolveTransportWithDevSpawnSpec(agent);
    const env = getAgentEnv(this.config, agent.skill.name);
    let acquiredLease: AgentUsageLease | undefined;
    let acquisition: McpScopedConnectionAcquisition | undefined;
    try {
      acquiredLease = this.agentUsageLeases.has(agent.skill.name)
        ? undefined
        : await this.acquireAgentUsage(agent, env, options.signal);
      this.assertOpen(options.signal);
      throwIfDeadlineExpired(options.deadlineAt);
      const sampling = this.sampling;
      if (!sampling) throw new Error("CoreAgentHost requires a model before connecting");
      acquisition = await this.manager.connectScoped(
        agent.skill.name,
        transport,
        agent.installPath,
        {
          timeoutMs: remainingStepTimeout(AGENT_BOOTSTRAP_CONNECT_TIMEOUT_MS, options.deadlineAt),
          samplingModel: sampling.model,
          ...(sampling.options ? { samplingProviderOptions: sampling.options } : {}),
          ...(env ? { env } : {}),
          signal: options.signal,
        },
      );
      this.assertOpen(options.signal);
      throwIfDeadlineExpired(options.deadlineAt);
      const listed = (
        await acquisition.client.listTools(undefined, {
          timeout: remainingStepTimeout(AGENT_BOOTSTRAP_LIST_TOOLS_TIMEOUT_MS, options.deadlineAt),
          signal: options.signal,
        })
      ).tools;
      this.assertOpen(options.signal);
      throwIfDeadlineExpired(options.deadlineAt);
      const normalized = normalizeListedTools(listed, {
        onAppOutputIssue: (issue) =>
          reportIssue({
            agentName: agent.skill.name,
            message: formatAppOutputDiscoveryIssue(agent.skill.name, issue),
          }),
        onSchemaIssue: (issue) =>
          reportIssue({
            agentName: agent.skill.name,
            message: formatToolSchemaIssue(agent.skill.name, issue),
          }),
      });
      const sourceTools: SourceTool[] = normalized.map((tool, index) => {
        const resource = extractResourceHints(listed[index]);
        const observation = extractObservationRetention(listed[index]);
        if (resource.issue !== undefined) {
          reportIssue({
            agentName: agent.skill.name,
            message: `Tool "${tool.name}" 的 ${ROLL_RESOURCE_HINTS_META_KEY} 无效（${resource.issue}），已回退 Agent 级资源锁`,
          });
        }
        if (observation.issue) {
          reportIssue({
            agentName: agent.skill.name,
            message: `Tool "${tool.name}" 的 ${OBSERVATION_RETENTION_META_KEY} 无效（${observation.issue}），观察历史保持原样`,
          });
        }
        return {
          tool,
          annotations: extractAnnotations(listed[index]),
          ...(resource.hints ? { resourceHints: resource.hints } : {}),
          ...(observation.declaration ? { observationRetention: observation.declaration } : {}),
        };
      });
      const previous = this.connections.get(agent.skill.name);
      if (previous?.client === acquisition.client) {
        await acquisition.rollback();
      } else {
        acquisition.commit();
        this.connections.set(agent.skill.name, acquisition);
        if (previous) {
          this.cleanupConnections.add(previous);
          try {
            await previous.release();
            this.cleanupConnections.delete(previous);
          } catch (error) {
            reportIssue({
              agentName: agent.skill.name,
              message: `旧连接清理失败：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
      const latest = this.sampling;
      if (
        latest &&
        (previous?.client !== acquisition.client ||
          latest.model !== sampling.model ||
          latest.options !== sampling.options)
      ) {
        this.connections.get(agent.skill.name)?.setSampling(latest.model, latest.options);
      }
      if (acquiredLease !== undefined) this.agentUsageLeases.set(agent.skill.name, acquiredLease);
      return {
        agentName: agent.skill.name,
        client: acquisition.client,
        tools: sourceTools,
        ...(agent.source ? { agentSource: agent.source.type } : {}),
        transport: transport.type,
        runtimeOwnership: agent.runtime.ownership,
        ...(transport.type === "stdio" ? { resourceBaseDir: agent.installPath } : {}),
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (acquisition === undefined && error instanceof McpConnectionCleanupError) {
        this.unresolvedCleanupErrors.push(error);
      }
      if (acquisition) {
        const connection = acquisition;
        await connection.rollback().catch((cleanupError: unknown) => {
          this.cleanupConnections.add(connection);
          cleanupErrors.push(cleanupError);
        });
      }
      if (acquiredLease) {
        const lease = acquiredLease;
        await lease.release().catch((cleanupError: unknown) => {
          this.agentUsageLeases.set(agent.skill.name, lease);
          cleanupErrors.push(cleanupError);
        });
      }
      if (cleanupErrors.length > 0) {
        throw new AgentBootstrapCleanupError(agent.skill.name, error, cleanupErrors);
      }
      throw error;
    }
  }

  async refreshSkills(input: AgentHostOperation): Promise<SkillLibrary | undefined> {
    this.assertOpen(input.signal);
    return this.resolveSkillLibrary();
  }

  refresh(agentName: string, input: AgentHostOperation): Promise<AgentHostRefresh> {
    this.assertOpen(input.signal);
    this.sampling ??= { model: input.model, options: input.providerOptions };
    const operation = async (): Promise<AgentHostRefresh> => {
      const agent =
        this.installedAgents.get(agentName) ??
        this.currentAgents().find((entry) => entry.skill.name === agentName);
      if (!agent) throw new Error(`Agent "${agentName}" 未注册`);
      const source = await this.connectAgentSource(
        agent,
        (issue) => this.onAgentBootstrapIssue?.(issue),
        {
          signal: AbortSignal.any([input.signal, this.shutdownController.signal]),
        },
      );
      this.assertOpen(input.signal);
      const skillLibrary = this.resolveSkillLibrary();
      return { source, ...(skillLibrary ? { skillLibrary } : {}) };
    };
    return this.track(operation());
  }

  install(
    shortName: string,
    report: (line: string) => void,
    signal: AbortSignal,
  ): Promise<AgentHostInstallResult> {
    this.assertOpen(signal);
    return this.track(this.runInstall(shortName, report));
  }

  private async runInstall(
    shortName: string,
    report: (line: string) => void,
  ): Promise<AgentHostInstallResult> {
    const entry = this.currentCatalog().find((item) => item.shortName === shortName);
    if (!entry) return { outcome: { ok: false, message: `未知的官方 Agent 短名: ${shortName}` } };
    // Installation has bounded external side effects and no rollback-on-cancel contract.
    // Once started, await the installer and retain its result even during shutdown.
    const result = await this.installAgentFn(
      {
        packageSpec: catalogPackageSpec(entry),
        skipBrowserSetup: true,
        autoStart: false,
        expectedSkillName: entry.skillName,
      },
      {
        agentsConfig: this.config.agents,
        installConfig: this.config.install,
        getStartEnv: (agentName) => getAgentEnv(this.config, agentName),
        report: (event) => report(formatInstallEventLine(event)),
      },
    );
    if (!result.ok) {
      return {
        outcome: {
          ok: false,
          message: result.message,
          ...(result.retryCommand ? { retryCommand: result.retryCommand } : {}),
        },
      };
    }
    const agent = result.agent;
    this.installedAgents.set(agent.skill.name, agent);
    const version =
      agent.source?.type === "installed-package" ? agent.source.installedVersion : undefined;
    const browserSetupSkipped =
      agent.runtime.ownership === "core-managed" && agent.runtime.setup?.playwright !== undefined;
    return {
      outcome: {
        ok: true,
        agentName: agent.skill.name,
        ...(version ? { version } : {}),
        missingEnv: (result.envReport?.missingRequired ?? []).map((item) => item.name),
        ...(browserSetupSkipped ? { retryCommand: `roll agent install ${entry.shortName}` } : {}),
        refreshApplied: false,
      },
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = Promise.resolve().then(async () => {
      await Promise.allSettled(this.pending);
      const exited = getExitedAgentUsageNames(this.agentUsageLeases.values());
      const connections = new Set([...this.connections.values(), ...this.cleanupConnections]);
      const connectionResults = await Promise.allSettled(
        [...connections].map((connection) => {
          const agentName = [...this.connections].find(([, entry]) => entry === connection)?.[0];
          return connection.release(agentName !== undefined && exited.has(agentName));
        }),
      );
      const leaseResults = await Promise.allSettled(
        [...this.agentUsageLeases].map(async ([name, lease]) => {
          await lease.release();
          this.agentUsageLeases.delete(name);
        }),
      );
      const errors = [
        ...this.unresolvedCleanupErrors,
        ...[...connectionResults, ...leaseResults].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
      ];
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "CoreAgentHost resource cleanup failed");
      }
      this.connections.clear();
      this.cleanupConnections.clear();
      this.installedAgents.clear();
    });
    this.shutdownController.abort(createEngineClosingError());
    return this.disposePromise;
  }
}
