import { COMPANION_ACTION_PATHS, type CompanionAction } from "./lib/companion-state.ts";
import { SCHEDULE_ACTION_PATHS, type ScheduleAction } from "./lib/schedule-state.ts";
import { isRecord } from "./lib/config-value.ts";
import {
  COMPANION_PHASES,
  type AgentApplyResult,
  type AgentActivationResult,
  type AgentConfigCatalog,
  type AgentEnvCatalogField,
  type AgentOwnership,
  type AgentRuntimeStatus,
  type AgentStatusResponse,
  type BootstrapInfo,
  type CompanionDoctorCheck,
  type CompanionDoctorResult,
  type CompanionPhase,
  type CompanionStatus,
  type ConfigActivationEffect,
  type ConfigApplicationPreview,
  type ConfigApplicationSnapshot,
  type ConfigCatalogNode,
  type ConfigDiffLine,
  type ConfigPath,
  type ConfigValidationIssue,
  type RollConfigCatalog,
  type SaveDraft,
  type ScheduleRow,
  type ScheduleRunRow,
  type ScheduleStatusSummary,
} from "./types.ts";

export interface CompanionLogStreamHandlers {
  readonly onText: (text: string) => void;
  readonly onError: () => void;
}

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
} as const;

export class RollUiApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly issues: readonly ConfigValidationIssue[];

  constructor(
    message: string,
    status: number,
    options: { readonly code?: string; readonly issues?: readonly ConfigValidationIssue[] } = {},
  ) {
    super(message);
    this.name = "RollUiApiError";
    this.status = status;
    this.issues = options.issues ?? [];
    if (options.code !== undefined) this.code = options.code;
  }
}

export class RollUiApi {
  private csrfToken = "";
  private bootstrapRequest: Promise<BootstrapInfo> | undefined;
  private bootstrapFragmentCleanupInstalled = false;

  bootstrap(): Promise<BootstrapInfo> {
    this.bootstrapRequest ??= this.requestBootstrap().catch((error: unknown) => {
      this.bootstrapRequest = undefined;
      throw error;
    });
    return this.bootstrapRequest;
  }

  private async requestBootstrap(): Promise<BootstrapInfo> {
    const token = readBootstrapToken();
    let bootstrapResponse: Awaited<ReturnType<typeof fetchBootstrapResponse>>;
    if (token === undefined) {
      bootstrapResponse = await fetchBootstrapResponse();
    } else {
      try {
        bootstrapResponse = await fetchBootstrapResponse(token);
      } catch (error) {
        if (!shouldRetryBootstrapWithSession(error)) throw error;
        bootstrapResponse = await fetchBootstrapResponse();
      }
    }
    const { response, payload } = bootstrapResponse;
    const candidate = unwrapNamed(payload, "bootstrap");
    if (!isBootstrapInfo(candidate)) {
      throw apiShapeError("启动凭据响应格式无效", response.status);
    }
    this.csrfToken = candidate.csrfToken;
    if (token !== undefined) clearBootstrapToken();
    this.installBootstrapFragmentCleanup();
    return candidate;
  }

  private installBootstrapFragmentCleanup(): void {
    if (this.bootstrapFragmentCleanupInstalled) return;
    window.addEventListener("hashchange", () => {
      if (readBootstrapToken() !== undefined) clearBootstrapToken();
    });
    this.bootstrapFragmentCleanupInstalled = true;
  }

  async getConfig(): Promise<ConfigApplicationSnapshot> {
    const payload = await this.request("/api/config");
    const candidate = unwrapNamed(payload, "snapshot");
    if (!isConfigSnapshot(candidate)) throw apiShapeError("配置响应格式无效");
    return candidate;
  }

  async getCatalog(): Promise<RollConfigCatalog> {
    const payload = await this.request("/api/catalog");
    const candidate = unwrapNamed(payload, "catalog");
    if (!isRollConfigCatalog(candidate)) throw apiShapeError("配置目录响应格式无效");
    return candidate;
  }

  async previewConfig(draft: SaveDraft): Promise<ConfigApplicationPreview> {
    const payload = await this.request("/api/config/preview", {
      method: "POST",
      body: JSON.stringify(toMutationBody(draft)),
    });
    const candidate = unwrapNamed(payload, "preview");
    if (!isConfigPreview(candidate)) throw apiShapeError("预览响应格式无效");
    return candidate;
  }

  async saveConfig(draft: SaveDraft): Promise<ConfigApplicationPreview> {
    const payload = await this.request("/api/config/save", {
      method: "POST",
      body: JSON.stringify(toMutationBody(draft)),
    });
    const candidate = unwrapNamed(payload, "result");
    if (!isConfigPreview(candidate)) throw apiShapeError("保存响应格式无效");
    return candidate;
  }

  async getAgentStatus(): Promise<AgentStatusResponse> {
    const payload = await this.request("/api/agents/status");
    const candidate = unwrapData(payload);
    if (Array.isArray(candidate)) {
      const agents = candidate.filter(isAgentRuntimeStatus);
      if (agents.length !== candidate.length) throw apiShapeError("Agent 状态响应格式无效");
      return { agents };
    }
    if (!isRecord(candidate) || !Array.isArray(candidate.agents)) {
      throw apiShapeError("Agent 状态响应格式无效");
    }
    const agents = candidate.agents.filter(isAgentRuntimeStatus);
    if (agents.length !== candidate.agents.length) throw apiShapeError("Agent 状态响应格式无效");
    return {
      agents,
      ...(typeof candidate.checkedAt === "string" ? { checkedAt: candidate.checkedAt } : {}),
    };
  }

  async applyEffects(effects: readonly ConfigActivationEffect[]): Promise<AgentApplyResult> {
    const payload = await this.request("/api/agents/apply", {
      method: "POST",
      body: JSON.stringify({ effects }),
    });
    const candidate = unwrapData(payload);
    if (!isRecord(candidate)) throw apiShapeError("应用响应格式无效");
    const rawAgents = Array.isArray(candidate.agents) ? candidate.agents : [];
    const agents = rawAgents.filter(isAgentRuntimeStatus);
    if (agents.length !== rawAgents.length) throw apiShapeError("应用响应格式无效");
    const result = candidate.result;
    if (result !== undefined && !isAgentActivationResult(result)) {
      throw apiShapeError("应用结果响应格式无效");
    }
    return {
      agents,
      attempted: candidate.attempted === true,
      applied: candidate.applied === true,
      ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
      ...(result !== undefined ? { result } : {}),
    };
  }

  async getCompanionStatus(): Promise<CompanionStatus> {
    const candidate = unwrapData(await this.request("/api/companion/status"));
    if (!isCompanionStatus(candidate)) throw apiShapeError("Companion 状态响应格式无效");
    return candidate;
  }

  async getCompanionDoctor(): Promise<CompanionDoctorResult> {
    const candidate = unwrapData(await this.request("/api/companion/doctor"));
    if (!isCompanionDoctorResult(candidate)) throw apiShapeError("Companion 体检响应格式无效");
    return candidate;
  }

  async getCompanionLogs(): Promise<string> {
    const candidate = unwrapData(await this.request("/api/companion/logs"));
    if (!isRecord(candidate) || typeof candidate.text !== "string") {
      throw apiShapeError("Companion 日志响应格式无效");
    }
    return candidate.text;
  }

  async runCompanionAction(action: CompanionAction, body?: unknown): Promise<void> {
    await this.request(COMPANION_ACTION_PATHS[action], {
      method: "POST",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async getScheduleStatus(): Promise<ScheduleStatusSummary> {
    const candidate = unwrapData(await this.request("/api/schedule/status"));
    if (!isScheduleStatusSummary(candidate)) throw apiShapeError("定时任务状态响应格式无效");
    return candidate;
  }

  async listSchedules(): Promise<readonly ScheduleRow[]> {
    const candidate = unwrapData(await this.request("/api/schedule/schedules"));
    if (!Array.isArray(candidate) || !candidate.every(isScheduleRow)) {
      throw apiShapeError("定时任务列表响应格式无效");
    }
    return candidate;
  }

  async listScheduleRuns(
    query: { readonly scheduleId?: string; readonly limit?: number } = {},
  ): Promise<readonly ScheduleRunRow[]> {
    const params = new URLSearchParams();
    if (query.scheduleId !== undefined) params.set("scheduleId", query.scheduleId);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const candidate = unwrapData(await this.request(`/api/schedule/runs${suffix}`));
    if (!Array.isArray(candidate) || !candidate.every(isScheduleRunRow)) {
      throw apiShapeError("定时任务运行记录响应格式无效");
    }
    return candidate;
  }

  async runScheduleAction(
    action: ScheduleAction,
    body?: unknown,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const candidate = unwrapData(
      await this.request(SCHEDULE_ACTION_PATHS[action], {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return isRecord(candidate) ? candidate : undefined;
  }

  openCompanionLogStream(handlers: CompanionLogStreamHandlers): () => void {
    const source = new EventSource(resolveApiEndpoint("/api/companion/logs/stream"));
    source.addEventListener("log", (event) => {
      if (event instanceof MessageEvent && typeof event.data === "string") {
        handlers.onText(event.data);
      }
    });
    source.addEventListener("stream-error", () => handlers.onError());
    source.addEventListener("error", () => handlers.onError());
    return () => source.close();
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (method !== "GET" && method !== "HEAD") {
      headers.set("Content-Type", "application/json");
      headers.set("X-CSRF-Token", this.csrfToken);
    }
    const response = await fetch(resolveApiEndpoint(path), {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    return readResponse(response);
  }
}

async function fetchBootstrapResponse(token?: string): Promise<{
  readonly response: Response;
  readonly payload: unknown;
}> {
  const response = await fetch(resolveApiEndpoint("/api/bootstrap"), {
    method: token === undefined ? "GET" : "POST",
    headers:
      token === undefined ? JSON_HEADERS : { ...JSON_HEADERS, "X-Roll-Bootstrap-Token": token },
    ...(token === undefined ? {} : { body: JSON.stringify({ token }) }),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = await readResponse(response);
  return { response, payload };
}

function shouldRetryBootstrapWithSession(error: unknown): boolean {
  return error instanceof RollUiApiError && error.status === 401;
}

function resolveApiEndpoint(path: string): string {
  if (!path.startsWith("/api/")) throw new Error(`无效的 Roll UI API 路径：${path}`);
  return new URL(`.${path}`, window.location.href).toString();
}

function toMutationBody(draft: SaveDraft): Record<string, unknown> {
  return {
    mode: draft.mode === "form" ? "structured" : "yaml",
    expectedRevision: draft.expectedRevision,
    ...(draft.mode === "yaml" ? { yaml: draft.yaml ?? "" } : { persisted: draft.persisted ?? {} }),
  };
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) throw new RollUiApiError(text, response.status);
      throw apiShapeError("服务返回了无法解析的 JSON", response.status);
    }
  }
  if (!response.ok) throw decodeApiError(payload, response.status);
  return payload;
}

function decodeApiError(payload: unknown, status: number): RollUiApiError {
  const candidate = unwrapData(payload);
  if (!isRecord(candidate)) return new RollUiApiError(`请求失败（HTTP ${String(status)}）`, status);
  const error = isRecord(candidate.error) ? candidate.error : candidate;
  const details = isRecord(error.details) ? error.details : error;
  const issues = Array.isArray(details.issues) ? details.issues.filter(isValidationIssue) : [];
  return new RollUiApiError(
    typeof error.message === "string" ? error.message : `请求失败（HTTP ${String(status)}）`,
    status,
    {
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      issues,
    },
  );
}

function apiShapeError(message: string, status = 500): RollUiApiError {
  return new RollUiApiError(message, status, { code: "invalid_response" });
}

function unwrapData(payload: unknown): unknown {
  return isRecord(payload) && "data" in payload ? payload.data : payload;
}

function unwrapNamed(payload: unknown, name: string): unknown {
  const data = unwrapData(payload);
  return isRecord(data) && name in data ? data[name] : data;
}

function readBootstrapToken(): string | undefined {
  const raw = window.location.hash.slice(1);
  if (raw.length === 0) return undefined;
  const params = new URLSearchParams(raw);
  const named = params.get("token") ?? params.get("bootstrap") ?? params.get("bootstrapToken");
  if (named !== null && named.length > 0) return named;
  return raw.includes("=") ? undefined : decodeURIComponent(raw);
}

function clearBootstrapToken(): void {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function isBootstrapInfo(value: unknown): value is BootstrapInfo {
  return (
    isRecord(value) &&
    typeof value.csrfToken === "string" &&
    optionalString(value.version) &&
    optionalString(value.startedAt)
  );
}

function isConfigSnapshot(value: unknown): value is ConfigApplicationSnapshot {
  return (
    isRecord(value) &&
    typeof value.configPath === "string" &&
    typeof value.existed === "boolean" &&
    typeof value.revision === "string" &&
    isRecord(value.persisted) &&
    typeof value.yaml === "string" &&
    Array.isArray(value.configuredSecretPaths) &&
    value.configuredSecretPaths.every(isConfigPath) &&
    (value.repairMode === undefined || typeof value.repairMode === "boolean") &&
    (value.validationIssues === undefined ||
      (Array.isArray(value.validationIssues) && value.validationIssues.every(isValidationIssue)))
  );
}

function isConfigPreview(value: unknown): value is ConfigApplicationPreview {
  return (
    isRecord(value) &&
    isConfigSnapshot(value.snapshot) &&
    typeof value.changed === "boolean" &&
    Array.isArray(value.changedPaths) &&
    value.changedPaths.every(isConfigPath) &&
    Array.isArray(value.effects) &&
    value.effects.every(isActivationEffect) &&
    Array.isArray(value.diff) &&
    value.diff.every(isDiffLine) &&
    optionalString(value.backupPath)
  );
}

function isActivationEffect(value: unknown): value is ConfigActivationEffect {
  return (
    isRecord(value) &&
    ["next-command", "next-chat", "restart-agent", "manual"].includes(String(value.kind)) &&
    Array.isArray(value.paths) &&
    value.paths.every(isConfigPath) &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof value.requiresConfirmation === "boolean" &&
    optionalString(value.agentName)
  );
}

function isAgentActivationResult(value: unknown): value is AgentActivationResult {
  return (
    isRecord(value) &&
    typeof value.success === "boolean" &&
    typeof value.requiresManualAction === "boolean" &&
    Array.isArray(value.restartedAgentNames) &&
    value.restartedAgentNames.every((name) => typeof name === "string") &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        isRecord(item) &&
        isActivationEffect(item.effect) &&
        [
          "deferred",
          "restarted",
          "kept-stopped",
          "next-invocation",
          "manual",
          "runtime-changed",
          "failed",
        ].includes(String(item.status)) &&
        typeof item.message === "string" &&
        (item.pid === undefined || typeof item.pid === "number"),
    )
  );
}

function isDiffLine(value: unknown): value is ConfigDiffLine {
  return (
    isRecord(value) &&
    ["context", "add", "remove"].includes(String(value.kind)) &&
    typeof value.text === "string"
  );
}

function isConfigPath(value: unknown): value is ConfigPath {
  return (
    Array.isArray(value) &&
    value.every((part) => typeof part === "string" || typeof part === "number")
  );
}

function isValidationIssue(value: unknown): value is ConfigValidationIssue {
  return isRecord(value) && typeof value.path === "string" && typeof value.message === "string";
}

function isRollConfigCatalog(value: unknown): value is RollConfigCatalog {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isConfigCatalogNode(value.root) &&
    value.root.kind === "object" &&
    Array.isArray(value.agents) &&
    value.agents.every(isAgentConfigCatalog)
  );
}

function isConfigCatalogNode(value: unknown): value is ConfigCatalogNode {
  if (!isCatalogNodeBase(value)) return false;
  switch (value.kind) {
    case "object":
      return isRecord(value.fields) && Object.values(value.fields).every(isConfigCatalogNode);
    case "record":
      return isConfigCatalogNode(value.value);
    case "array":
      return isConfigCatalogNode(value.item);
    case "enum":
      return (
        Array.isArray(value.options) && value.options.every((option) => typeof option === "string")
      );
    case "string":
    case "boolean":
    case "unknown":
      return true;
    case "number":
      return isNumberConstraints(value.constraints);
  }
}

function isNumberConstraints(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.minimum === undefined || typeof value.minimum === "number") &&
    (value.maximum === undefined || typeof value.maximum === "number") &&
    typeof value.exclusiveMinimum === "boolean" &&
    typeof value.exclusiveMaximum === "boolean" &&
    typeof value.integer === "boolean"
  );
}

function isCatalogNodeBase(value: unknown): value is ConfigCatalogNode {
  return (
    isRecord(value) &&
    ["object", "record", "array", "string", "number", "boolean", "enum", "unknown"].includes(
      String(value.kind),
    ) &&
    Array.isArray(value.path) &&
    value.path.every((part) => typeof part === "string") &&
    typeof value.title === "string" &&
    typeof value.effectiveRequired === "boolean" &&
    typeof value.persistedRequired === "boolean" &&
    typeof value.widget === "string" &&
    typeof value.secret === "boolean" &&
    typeof value.readOnly === "boolean" &&
    optionalString(value.description) &&
    optionalString(value.defaultBehavior) &&
    optionalString(value.example) &&
    optionalString(value.setupCommand)
  );
}

function isAgentConfigCatalog(value: unknown): value is AgentConfigCatalog {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isAgentOwnership(value.ownership) &&
    Array.isArray(value.fields) &&
    value.fields.every(isAgentEnvCatalogField)
  );
}

function isAgentEnvCatalogField(value: unknown): value is AgentEnvCatalogField {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.title === "string" &&
    typeof value.required === "boolean" &&
    ["string", "boolean", "number", "json", "url"].includes(String(value.type)) &&
    ["text", "password", "url", "number", "switch", "textarea"].includes(String(value.widget)) &&
    typeof value.secret === "boolean" &&
    typeof value.configurable === "boolean" &&
    optionalString(value.description) &&
    optionalString(value.example) &&
    optionalString(value.defaultValue) &&
    (value.sourcePath === undefined ||
      (Array.isArray(value.sourcePath) &&
        value.sourcePath.every((part) => typeof part === "string")))
  );
}

function isAgentRuntimeStatus(value: unknown): value is AgentRuntimeStatus {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isAgentOwnership(value.ownership) &&
    typeof value.status === "string" &&
    optionalString(value.description) &&
    optionalBoolean(value.healthy) &&
    optionalNumber(value.pid) &&
    optionalString(value.endpoint) &&
    optionalString(value.detail) &&
    optionalString(value.lastError) &&
    optionalBoolean(value.browserRunning)
  );
}

function isCompanionStatus(value: unknown): value is CompanionStatus {
  return (
    isRecord(value) &&
    isCompanionPhase(value.phase) &&
    typeof value.enabled === "boolean" &&
    typeof value.enrolled === "boolean" &&
    typeof value.runtimeOnline === "boolean" &&
    typeof value.relayProfile === "string" &&
    optionalString(value.deviceId) &&
    optionalString(value.workspaceId) &&
    optionalString(value.cwd) &&
    optionalString(value.lastError)
  );
}

function isScheduleStatusSummary(value: unknown): value is ScheduleStatusSummary {
  return (
    isRecord(value) &&
    typeof value.dataDir === "string" &&
    typeof value.logPath === "string" &&
    isRecord(value.daemon) &&
    typeof value.daemon.liveness === "string" &&
    isRecord(value.service) &&
    typeof value.service.metadataStatus === "string" &&
    typeof value.service.installed === "boolean" &&
    typeof value.service.running === "boolean" &&
    optionalString(value.service.installedDataDir) &&
    isRecord(value.schedules) &&
    typeof value.schedules.total === "number" &&
    typeof value.schedules.active === "number" &&
    typeof value.schedules.paused === "number" &&
    (value.unresolvedPlaceholders === undefined ||
      (Array.isArray(value.unresolvedPlaceholders) &&
        value.unresolvedPlaceholders.every((item) => typeof item === "string"))) &&
    optionalString(value.nextWakeAt)
  );
}

function isScheduleRow(value: unknown): value is ScheduleRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    typeof value.trigger === "string" &&
    typeof value.cwd === "string" &&
    typeof value.prompt === "string" &&
    typeof value.createdAt === "string" &&
    optionalString(value.nextRunAt) &&
    optionalString(value.lastRunAt) &&
    optionalString(value.lastError) &&
    optionalString(value.maxRun) &&
    (value.liveRun === undefined ||
      (isRecord(value.liveRun) &&
        typeof value.liveRun.id === "string" &&
        typeof value.liveRun.status === "string"))
  );
}

function isScheduleRunRow(value: unknown): value is ScheduleRunRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.scheduleId === "string" &&
    typeof value.scheduleName === "string" &&
    typeof value.mode === "string" &&
    typeof value.status === "string" &&
    typeof value.scheduledFor === "string" &&
    typeof value.attempt === "number" &&
    typeof value.maxAttempts === "number" &&
    optionalString(value.error) &&
    optionalString(value.outputExcerpt) &&
    optionalString(value.startedAt) &&
    optionalString(value.finishedAt)
  );
}

function isCompanionPhase(value: unknown): value is CompanionPhase {
  return COMPANION_PHASES.some((phase) => phase === value);
}

function isCompanionDoctorResult(value: unknown): value is CompanionDoctorResult {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.checks) &&
    value.checks.every(isCompanionDoctorCheck)
  );
}

function isCompanionDoctorCheck(value: unknown): value is CompanionDoctorCheck {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.ok === "boolean" &&
    typeof value.detail === "string"
  );
}

function isAgentOwnership(value: unknown): value is AgentOwnership {
  return value === "on-demand" || value === "core-managed" || value === "external-managed";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}
