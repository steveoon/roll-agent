export type JsonObject = Record<string, unknown>;
export type ConfigPathSegment = string | number;
export type ConfigPath = readonly ConfigPathSegment[];

export type ConfigCatalogNodeKind =
  | "object"
  | "record"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "unknown";

export type ConfigFieldWidget =
  | "text"
  | "password"
  | "url"
  | "path"
  | "textarea"
  | "number"
  | "duration"
  | "switch"
  | "select"
  | "string-list"
  | "record"
  | "object";

interface ConfigCatalogNodeBase {
  readonly kind: ConfigCatalogNodeKind;
  readonly path: readonly string[];
  readonly title: string;
  readonly description?: string;
  readonly defaultBehavior?: string;
  readonly example?: string;
  readonly setupCommand?: string;
  readonly effectiveRequired: boolean;
  readonly persistedRequired: boolean;
  readonly defaultValue?: unknown;
  readonly widget: ConfigFieldWidget;
  readonly secret: boolean;
  readonly readOnly: boolean;
}

export interface ConfigNumberConstraints {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum: boolean;
  readonly exclusiveMaximum: boolean;
  readonly integer: boolean;
}

export interface ConfigObjectCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "object";
  readonly fields: Readonly<Record<string, ConfigCatalogNode>>;
}

export interface ConfigRecordKeyOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface ConfigRecordCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "record";
  readonly value: ConfigCatalogNode;
  readonly keyOptions?: readonly ConfigRecordKeyOption[];
}

export interface ConfigArrayCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "array";
  readonly item: ConfigCatalogNode;
}

export interface ConfigEnumCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "enum";
  readonly options: readonly string[];
}

export interface ConfigLeafCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "string" | "boolean" | "unknown";
}

export interface ConfigNumberCatalogNode extends ConfigCatalogNodeBase {
  readonly kind: "number";
  readonly constraints: ConfigNumberConstraints;
}

export type ConfigCatalogNode =
  | ConfigObjectCatalogNode
  | ConfigRecordCatalogNode
  | ConfigArrayCatalogNode
  | ConfigEnumCatalogNode
  | ConfigNumberCatalogNode
  | ConfigLeafCatalogNode;

export interface AgentEnvCatalogField {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly example?: string;
  readonly defaultValue?: string;
  readonly required: boolean;
  readonly type: "string" | "boolean" | "number" | "json" | "url";
  readonly widget: "text" | "password" | "url" | "number" | "switch" | "textarea";
  readonly secret: boolean;
  readonly configurable: boolean;
  readonly sourcePath?: readonly string[];
}

export type AgentOwnership = "on-demand" | "core-managed" | "external-managed";

export interface AgentConfigCatalog {
  readonly name: string;
  readonly description: string;
  readonly ownership: AgentOwnership;
  readonly fields: readonly AgentEnvCatalogField[];
}

export interface RollConfigCatalog {
  readonly schemaVersion: 1;
  readonly root: ConfigObjectCatalogNode;
  readonly agents: readonly AgentConfigCatalog[];
}

export interface ConfigApplicationSnapshot {
  readonly configPath: string;
  readonly existed: boolean;
  readonly revision: string;
  readonly persisted: JsonObject;
  readonly yaml: string;
  readonly configuredSecretPaths: readonly ConfigPath[];
  readonly repairMode?: boolean;
  readonly validationIssues?: readonly ConfigValidationIssue[];
}

export type ConfigActivationKind = "next-command" | "next-chat" | "restart-agent" | "manual";

export interface ConfigActivationEffect {
  readonly kind: ConfigActivationKind;
  readonly paths: readonly ConfigPath[];
  readonly title: string;
  readonly description: string;
  readonly agentName?: string;
  readonly requiresConfirmation: boolean;
}

export interface ConfigDiffLine {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
}

export interface ConfigApplicationPreview {
  readonly snapshot: ConfigApplicationSnapshot;
  readonly changed: boolean;
  readonly changedPaths: readonly ConfigPath[];
  readonly effects: readonly ConfigActivationEffect[];
  readonly diff: readonly ConfigDiffLine[];
  readonly backupPath?: string;
}

export interface ConfigValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface BootstrapInfo {
  readonly csrfToken: string;
  readonly version?: string;
  readonly startedAt?: string;
}

export interface AgentRuntimeStatus {
  readonly name: string;
  readonly description?: string;
  readonly ownership: AgentOwnership;
  readonly status: string;
  readonly healthy?: boolean;
  readonly pid?: number;
  readonly endpoint?: string;
  readonly detail?: string;
  readonly lastError?: string;
  readonly browserRunning?: boolean;
}

export interface AgentStatusResponse {
  readonly agents: readonly AgentRuntimeStatus[];
  readonly checkedAt?: string;
}

export type AgentActivationStatus =
  | "deferred"
  | "restarted"
  | "kept-stopped"
  | "next-invocation"
  | "manual"
  | "runtime-changed"
  | "failed";

export interface AgentActivationResultItem {
  readonly effect: ConfigActivationEffect;
  readonly status: AgentActivationStatus;
  readonly message: string;
  readonly pid?: number;
}

export interface AgentActivationResult {
  readonly success: boolean;
  readonly requiresManualAction: boolean;
  readonly restartedAgentNames: readonly string[];
  readonly items: readonly AgentActivationResultItem[];
}

export interface AgentApplyResult {
  readonly agents: readonly AgentRuntimeStatus[];
  readonly attempted: boolean;
  readonly applied: boolean;
  readonly message?: string;
  readonly result?: AgentActivationResult;
}

export const COMPANION_PHASES = [
  "stopped",
  "starting",
  "running",
  "recovering",
  "stopping",
] as const;

export type CompanionPhase = (typeof COMPANION_PHASES)[number];

export interface CompanionStatus {
  readonly phase: CompanionPhase;
  readonly enabled: boolean;
  readonly enrolled: boolean;
  readonly runtimeOnline: boolean;
  readonly relayProfile: string;
  readonly deviceId?: string;
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly lastError?: string;
}

export interface CompanionDoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CompanionDoctorResult {
  readonly ok: boolean;
  readonly checks: readonly CompanionDoctorCheck[];
}

export interface ScheduleStatusSummary {
  readonly dataDir: string;
  readonly logPath: string;
  readonly daemon: {
    readonly liveness: string;
    readonly pid?: number;
    readonly startedAt?: string;
  };
  readonly service: {
    readonly metadataStatus: string;
    readonly metadataPhase?: string;
    readonly installed: boolean;
    readonly running: boolean;
    readonly installedDataDir?: string;
    readonly binary?: { readonly status: string; readonly reason?: string };
    readonly error?: string;
  };
  readonly unresolvedPlaceholders?: readonly string[];
  readonly schedules: {
    readonly total: number;
    readonly active: number;
    readonly paused: number;
  };
  readonly nextWakeAt?: string;
}

export interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly trigger: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastError?: string;
  readonly maxRun?: string;
  readonly createdAt: string;
  readonly liveRun?: { readonly id: string; readonly status: string };
}

export interface ScheduleRunRow {
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly mode: string;
  readonly status: string;
  readonly scheduledFor: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error?: string;
  readonly outputExcerpt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export type EditorMode = "form" | "yaml";

export type NavigationTarget =
  | { readonly type: "roll"; readonly key: string }
  | { readonly type: "agent"; readonly name: string };

export interface SaveDraft {
  readonly mode: EditorMode;
  readonly expectedRevision: string;
  readonly persisted?: JsonObject;
  readonly yaml?: string;
}

export const SECRET_SENTINEL = "__ROLL_UI_KEEP_EXISTING_SECRET__";
