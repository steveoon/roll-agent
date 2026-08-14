import { asSchema, type ToolSet } from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import type { SkillSummary } from "@roll-agent/core/skills/library";
import type {
  AgentRuntimeOwnership,
  AgentSourceType,
  AgentTransport,
} from "@roll-agent/core/types/agent";
import type { ToolAnnotations } from "../types/policy.ts";
import type { ToolRoute } from "../tool-bridge/naming.ts";
import { isSensitiveFieldName, redactSecretText } from "../tool-bridge/tool-execution-record.ts";
import type { SessionState } from "../bash/session/types.ts";

export const CAPABILITY_MANIFEST_VERSION = 1 as const;
export const CAPABILITY_TURN_CONTEXT_VERSION = 1 as const;

export const CAPABILITY_TOOL_ROLES = {
  agent: "agent",
  skill: "skill",
  shell: "shell",
  fileRead: "file-read",
  fileEdit: "file-edit",
  fileVerify: "file-verify",
  sessionCommand: "session-command",
  sessionPoll: "session-poll",
  sessionList: "session-list",
  agentInstall: "agent-install",
  transcriptRead: "transcript-read",
  userInput: "user-input",
} as const;

export type CapabilityToolRole = (typeof CAPABILITY_TOOL_ROLES)[keyof typeof CAPABILITY_TOOL_ROLES];

export const CAPABILITY_APPROVAL_MODES = {
  readOnly: "read-only",
  alwaysConfirm: "always-confirm",
  runtimePolicy: "runtime-policy",
} as const;

export type CapabilityApprovalMode =
  (typeof CAPABILITY_APPROVAL_MODES)[keyof typeof CAPABILITY_APPROVAL_MODES];

export const CAPABILITY_TOOL_SOURCE_KINDS = {
  builtIn: "built-in",
  agent: "agent",
} as const;

export type CapabilityToolSource =
  | (typeof CAPABILITY_TOOL_SOURCE_KINDS)[keyof typeof CAPABILITY_TOOL_SOURCE_KINDS]
  | AgentSourceType;

export const CAPABILITY_MANIFEST_LIFECYCLES = {
  manifest: "session-snapshot",
  turnContext: "per-turn",
} as const;

export const CAPABILITY_HOST_MODES = {
  embedded: "embedded",
  interactive: "interactive",
  oneShot: "one-shot",
  server: "server",
} as const;

export type CapabilityHostMode = (typeof CAPABILITY_HOST_MODES)[keyof typeof CAPABILITY_HOST_MODES];

export const CAPABILITY_SESSION_EXEC_LIFECYCLES = {
  resumable: "resumable",
  unavailable: "unavailable",
} as const;

export const CAPABILITY_SESSION_DURABILITIES = {
  processLocal: "process-local",
  unavailable: "unavailable",
} as const;

export type CapabilitySessionExecLifecycle =
  (typeof CAPABILITY_SESSION_EXEC_LIFECYCLES)[keyof typeof CAPABILITY_SESSION_EXEC_LIFECYCLES];

export type CapabilitySessionDurability =
  (typeof CAPABILITY_SESSION_DURABILITIES)[keyof typeof CAPABILITY_SESSION_DURABILITIES];

export interface CapabilityLifecycle {
  readonly manifest: typeof CAPABILITY_MANIFEST_LIFECYCLES.manifest;
  readonly turnContext: typeof CAPABILITY_MANIFEST_LIFECYCLES.turnContext;
  readonly hostMode: CapabilityHostMode;
  readonly sessionExec: CapabilitySessionExecLifecycle;
  readonly sessionDurability: CapabilitySessionDurability;
}

export interface CapabilityVcsSnapshot {
  readonly branch?: string;
  readonly dirty: boolean;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface CapabilitySessionSnapshot {
  readonly sessionId: number;
  readonly state: SessionState;
}

export interface CapabilityDynamicTurnSnapshot {
  readonly ruleIds: readonly string[];
  readonly sessions: readonly CapabilitySessionSnapshot[];
  readonly vcs?: CapabilityVcsSnapshot;
}

export interface CapabilityExternalDynamicContext {
  readonly ruleIds?: readonly string[];
  readonly vcs?: CapabilityVcsSnapshot;
}

export interface EffectiveToolCapability {
  readonly id: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly source: CapabilityToolSource;
  readonly transport?: AgentTransport["type"];
  readonly runtimeOwnership?: AgentRuntimeOwnership;
  readonly annotations?: ToolAnnotations;
  readonly role: CapabilityToolRole;
  readonly approval: CapabilityApprovalMode;
  readonly description?: string;
  readonly inputSchema: JSONValue;
}

export interface EffectiveCapabilityManifest {
  readonly version: typeof CAPABILITY_MANIFEST_VERSION;
  readonly audience: "roll-chat";
  readonly profile: string;
  readonly lifecycle: CapabilityLifecycle;
  readonly tools: readonly EffectiveToolCapability[];
  readonly skills: readonly SkillSummary[];
  readonly agentCount: number;
  readonly agentOnboardingCatalog: readonly CapabilityAgentOnboardingCatalogEntry[];
  readonly stableContext: {
    readonly rules: readonly string[];
    readonly shellHints: readonly string[];
  };
  readonly dynamicContext: {
    readonly cwd: string;
    readonly platform: NodeJS.Platform;
  };
}

export interface EffectiveCapabilityTurnContext {
  readonly version: typeof CAPABILITY_TURN_CONTEXT_VERSION;
  readonly audience: EffectiveCapabilityManifest["audience"];
  readonly profile: string;
  readonly lifecycle: CapabilityLifecycle;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly date: string;
  readonly dynamic: CapabilityDynamicTurnSnapshot;
  readonly effectiveToolIds: readonly string[];
  readonly explicitSkillNames: readonly string[];
  readonly sessionListToolId?: string;
  readonly transcriptReadToolId?: string;
}

export interface BuildCapabilityTurnContextInput {
  readonly now?: Date;
  readonly explicitSkillNames?: readonly string[];
  readonly ruleIds?: readonly string[];
  readonly sessions?: readonly CapabilitySessionSnapshot[];
  readonly vcs?: CapabilityVcsSnapshot;
}

export interface CapabilityAgentOnboardingCatalogEntry {
  readonly shortName: string;
  readonly description: string;
}

export interface BuildCapabilityManifestInput {
  readonly tools: ToolSet;
  readonly toolRoles: Readonly<Record<string, CapabilityToolRole>>;
  readonly resolveRoute: (id: string) => ToolRoute | undefined;
  readonly skills: readonly SkillSummary[];
  readonly agentCount: number;
  readonly agentOnboardingCatalog?: readonly CapabilityAgentOnboardingCatalogEntry[];
  readonly profile: string;
  readonly hostMode?: CapabilityHostMode;
  readonly cwd: string;
  readonly platform?: NodeJS.Platform;
  readonly shellHints?: readonly string[];
}

export interface SafeCapabilitySnapshot {
  readonly manifest: EffectiveCapabilityManifest;
  readonly turnContext?: EffectiveCapabilityTurnContext;
}

const STABLE_RULE_IDS = ["tool-grounding/v1", "task-persistence/v1", "output-channel/v1"] as const;

const CAPABILITY_SNAPSHOT_LIMITS = {
  stringChars: 512,
  arrayItems: 128,
  objectEntries: 128,
  depth: 16,
  objectKeyChars: 128,
} as const;

const OMITTED_SCHEMA_VALUE_KEYS = new Set(["default", "example", "examples"]);
const SAFE_SENSITIVE_SCHEMA_STRING_KEYS = new Set(["type", "format", "$ref", "$schema"]);
const DATA_URL_PATTERN = /data:(?:image|audio|video)\/[^\s,]{1,80}(?:;base64)?,[^\s"'<>)]*/giu;
const SENSITIVE_VALUE_MARKER = "[sensitive value redacted]";
const MEDIA_VALUE_MARKER = "[media value omitted]";
const BINARY_VALUE_MARKER = "[binary-like value omitted]";

function clipSnapshotString(
  value: string,
  maxChars: number = CAPABILITY_SNAPSHOT_LIMITS.stringChars,
): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function isBinaryLikeString(value: string): boolean {
  return value.length >= 256 && /^[a-z0-9+/_=-]+$/iu.test(value);
}

function sanitizeSnapshotString(value: string): string {
  if (isBinaryLikeString(value)) {
    return BINARY_VALUE_MARKER;
  }
  return clipSnapshotString(
    redactSecretText(value, SENSITIVE_VALUE_MARKER).replace(DATA_URL_PATTERN, MEDIA_VALUE_MARKER),
  );
}

function uniqueSnapshotObjectKey(out: Readonly<Record<string, JSONValue>>, key: string): string {
  if (!Object.hasOwn(out, key)) {
    return key;
  }
  let suffix = 1;
  while (true) {
    const marker = `~${String(suffix)}`;
    const candidate = `${key.slice(
      0,
      CAPABILITY_SNAPSHOT_LIMITS.objectKeyChars - marker.length,
    )}${marker}`;
    if (!Object.hasOwn(out, candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

function sanitizeSnapshotJsonValue(
  value: JSONValue,
  context: { readonly depth: number; readonly key: string; readonly sensitive: boolean },
): JSONValue {
  if (context.depth >= CAPABILITY_SNAPSHOT_LIMITS.depth) {
    return "[nested value omitted]";
  }
  if (typeof value === "string") {
    return context.sensitive && !SAFE_SENSITIVE_SCHEMA_STRING_KEYS.has(context.key.toLowerCase())
      ? SENSITIVE_VALUE_MARKER
      : sanitizeSnapshotString(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, CAPABILITY_SNAPSHOT_LIMITS.arrayItems).map((item) =>
      sanitizeSnapshotJsonValue(item, {
        ...context,
        depth: context.depth + 1,
      }),
    );
    if (value.length > CAPABILITY_SNAPSHOT_LIMITS.arrayItems) {
      items.push(`[${String(value.length - CAPABILITY_SNAPSHOT_LIMITS.arrayItems)} items omitted]`);
    }
    return items;
  }

  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, JSONValue] =>
        entry[1] !== undefined && !OMITTED_SCHEMA_VALUE_KEYS.has(entry[0].toLowerCase()),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const out: Record<string, JSONValue> = {};
  for (const [rawKey, item] of entries.slice(0, CAPABILITY_SNAPSHOT_LIMITS.objectEntries)) {
    const clippedKey = clipSnapshotString(
      sanitizeSnapshotString(rawKey),
      CAPABILITY_SNAPSHOT_LIMITS.objectKeyChars,
    );
    const key = uniqueSnapshotObjectKey(out, clippedKey);
    out[key] = sanitizeSnapshotJsonValue(item, {
      depth: context.depth + 1,
      key: rawKey,
      sensitive: context.sensitive || isSensitiveFieldName(rawKey),
    });
  }
  if (entries.length > CAPABILITY_SNAPSHOT_LIMITS.objectEntries) {
    out[uniqueSnapshotObjectKey(out, "__roll_snapshot_omitted__")] =
      entries.length - CAPABILITY_SNAPSHOT_LIMITS.objectEntries;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown, depth = 0): JSONValue {
  if (depth > 32) {
    return "[nested value omitted]";
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, JSONValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        out[key] = toJsonValue(item, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return value === undefined ? null : String(value);
}

const CAPABILITY_APPROVAL_BY_ROLE: Readonly<
  Partial<Record<CapabilityToolRole, CapabilityApprovalMode>>
> = {
  [CAPABILITY_TOOL_ROLES.skill]: CAPABILITY_APPROVAL_MODES.readOnly,
  [CAPABILITY_TOOL_ROLES.fileRead]: CAPABILITY_APPROVAL_MODES.readOnly,
  [CAPABILITY_TOOL_ROLES.sessionList]: CAPABILITY_APPROVAL_MODES.readOnly,
  [CAPABILITY_TOOL_ROLES.transcriptRead]: CAPABILITY_APPROVAL_MODES.readOnly,
  [CAPABILITY_TOOL_ROLES.agentInstall]: CAPABILITY_APPROVAL_MODES.alwaysConfirm,
  [CAPABILITY_TOOL_ROLES.userInput]: CAPABILITY_APPROVAL_MODES.readOnly,
};

function approvalForRole(role: CapabilityToolRole): CapabilityApprovalMode {
  return CAPABILITY_APPROVAL_BY_ROLE[role] ?? CAPABILITY_APPROVAL_MODES.runtimePolicy;
}

function sourceForTool(route: ToolRoute, role: CapabilityToolRole): CapabilityToolSource {
  if (role !== CAPABILITY_TOOL_ROLES.agent) {
    return CAPABILITY_TOOL_SOURCE_KINDS.builtIn;
  }
  return route.agentSource ?? CAPABILITY_TOOL_SOURCE_KINDS.agent;
}

function lifecycleForTools(
  tools: readonly EffectiveToolCapability[],
  hostMode: CapabilityHostMode,
): CapabilityLifecycle {
  const roles = new Set(tools.map((tool) => tool.role));
  const hasResumableSessionExec = [
    CAPABILITY_TOOL_ROLES.sessionCommand,
    CAPABILITY_TOOL_ROLES.sessionPoll,
    CAPABILITY_TOOL_ROLES.sessionList,
  ].every((role) => roles.has(role));
  return {
    manifest: CAPABILITY_MANIFEST_LIFECYCLES.manifest,
    turnContext: CAPABILITY_MANIFEST_LIFECYCLES.turnContext,
    hostMode,
    sessionExec: hasResumableSessionExec
      ? CAPABILITY_SESSION_EXEC_LIFECYCLES.resumable
      : CAPABILITY_SESSION_EXEC_LIFECYCLES.unavailable,
    sessionDurability: hasResumableSessionExec
      ? CAPABILITY_SESSION_DURABILITIES.processLocal
      : CAPABILITY_SESSION_DURABILITIES.unavailable,
  };
}

export function buildEffectiveCapabilityManifest(
  input: BuildCapabilityManifestInput,
): EffectiveCapabilityManifest {
  const tools = Object.keys(input.tools)
    .sort((left, right) => left.localeCompare(right))
    .map((id): EffectiveToolCapability => {
      const tool = input.tools[id];
      const route = input.resolveRoute(id);
      if (!tool || !route) {
        throw new Error(`无法为已注册工具 ${id} 构建 capability manifest`);
      }
      const role = input.toolRoles[id];
      if (!role) {
        throw new Error(`已注册工具 ${id} 缺少 capability role`);
      }
      const description = "description" in tool ? tool.description : undefined;
      return {
        id,
        agentName: route.agentName,
        toolName: route.toolName,
        source: sourceForTool(route, role),
        ...(route.transport ? { transport: route.transport } : {}),
        ...(route.runtimeOwnership ? { runtimeOwnership: route.runtimeOwnership } : {}),
        ...(route.annotations ? { annotations: { ...route.annotations } } : {}),
        role,
        approval: approvalForRole(role),
        ...(typeof description === "string" && description.length > 0 ? { description } : {}),
        inputSchema: toJsonValue(asSchema(tool.inputSchema).jsonSchema),
      };
    });

  return {
    version: CAPABILITY_MANIFEST_VERSION,
    audience: "roll-chat",
    profile: input.profile,
    lifecycle: lifecycleForTools(tools, input.hostMode ?? CAPABILITY_HOST_MODES.embedded),
    tools,
    skills: input.skills.map((skill) => ({ ...skill })),
    agentCount: input.agentCount,
    agentOnboardingCatalog: (input.agentOnboardingCatalog ?? []).map((entry) => ({ ...entry })),
    stableContext: {
      rules: STABLE_RULE_IDS,
      shellHints: [...(input.shellHints ?? [])],
    },
    dynamicContext: {
      cwd: input.cwd,
      platform: input.platform ?? process.platform,
    },
  };
}

export function findCapabilityToolId(
  manifest: EffectiveCapabilityManifest,
  role: CapabilityToolRole,
): string | undefined {
  return manifest.tools.find((tool) => tool.role === role)?.id;
}

export function listCapabilityToolIds(
  manifest: EffectiveCapabilityManifest,
  role: CapabilityToolRole,
): readonly string[] {
  return manifest.tools.filter((tool) => tool.role === role).map((tool) => tool.id);
}

function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildEffectiveCapabilityTurnContext(
  manifest: EffectiveCapabilityManifest,
  input: BuildCapabilityTurnContextInput = {},
): EffectiveCapabilityTurnContext {
  const sessionListToolId = findCapabilityToolId(manifest, CAPABILITY_TOOL_ROLES.sessionList);
  const transcriptReadToolId = findCapabilityToolId(manifest, CAPABILITY_TOOL_ROLES.transcriptRead);
  return {
    version: CAPABILITY_TURN_CONTEXT_VERSION,
    audience: manifest.audience,
    profile: manifest.profile,
    lifecycle: { ...manifest.lifecycle },
    cwd: manifest.dynamicContext.cwd,
    platform: manifest.dynamicContext.platform,
    date: formatLocalDate(input.now ?? new Date()),
    dynamic: {
      ruleIds: [...(input.ruleIds ?? manifest.stableContext.rules)],
      sessions: (input.sessions ?? []).map((session) => ({ ...session })),
      ...(input.vcs ? { vcs: { ...input.vcs } } : {}),
    },
    effectiveToolIds: manifest.tools.map((tool) => tool.id),
    explicitSkillNames: [...(input.explicitSkillNames ?? [])],
    ...(sessionListToolId ? { sessionListToolId } : {}),
    ...(transcriptReadToolId ? { transcriptReadToolId } : {}),
  };
}

function sanitizeSnapshotStrings(values: readonly string[]): readonly string[] {
  return values
    .slice(0, CAPABILITY_SNAPSHOT_LIMITS.arrayItems)
    .map((value) => sanitizeSnapshotString(value));
}

function sanitizeToolCapability(tool: EffectiveToolCapability): EffectiveToolCapability {
  return {
    id: sanitizeSnapshotString(tool.id),
    agentName: sanitizeSnapshotString(tool.agentName),
    toolName: sanitizeSnapshotString(tool.toolName),
    source: tool.source,
    ...(tool.transport ? { transport: tool.transport } : {}),
    ...(tool.runtimeOwnership ? { runtimeOwnership: tool.runtimeOwnership } : {}),
    ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
    role: tool.role,
    approval: tool.approval,
    ...(tool.description ? { description: sanitizeSnapshotString(tool.description) } : {}),
    inputSchema: sanitizeSnapshotJsonValue(tool.inputSchema, {
      depth: 0,
      key: "inputSchema",
      sensitive: false,
    }),
  };
}

function sanitizeCapabilityManifest(
  manifest: EffectiveCapabilityManifest,
): EffectiveCapabilityManifest {
  return {
    version: manifest.version,
    audience: manifest.audience,
    profile: sanitizeSnapshotString(manifest.profile),
    lifecycle: { ...manifest.lifecycle },
    tools: manifest.tools
      .slice(0, CAPABILITY_SNAPSHOT_LIMITS.arrayItems)
      .map(sanitizeToolCapability),
    skills: manifest.skills.slice(0, CAPABILITY_SNAPSHOT_LIMITS.arrayItems).map((skill) => ({
      name: sanitizeSnapshotString(skill.name),
      description: sanitizeSnapshotString(skill.description),
      source: skill.source,
    })),
    agentCount: manifest.agentCount,
    agentOnboardingCatalog: manifest.agentOnboardingCatalog
      .slice(0, CAPABILITY_SNAPSHOT_LIMITS.arrayItems)
      .map((entry) => ({
        shortName: sanitizeSnapshotString(entry.shortName),
        description: sanitizeSnapshotString(entry.description),
      })),
    stableContext: {
      rules: sanitizeSnapshotStrings(manifest.stableContext.rules),
      shellHints: sanitizeSnapshotStrings(manifest.stableContext.shellHints),
    },
    dynamicContext: {
      cwd: sanitizeSnapshotString(manifest.dynamicContext.cwd),
      platform: manifest.dynamicContext.platform,
    },
  };
}

function sanitizeCapabilityTurnContext(
  context: EffectiveCapabilityTurnContext,
): EffectiveCapabilityTurnContext {
  return {
    version: context.version,
    audience: context.audience,
    profile: sanitizeSnapshotString(context.profile),
    lifecycle: { ...context.lifecycle },
    cwd: sanitizeSnapshotString(context.cwd),
    platform: context.platform,
    date: sanitizeSnapshotString(context.date),
    dynamic: {
      ruleIds: sanitizeSnapshotStrings(context.dynamic.ruleIds),
      sessions: context.dynamic.sessions
        .slice(0, CAPABILITY_SNAPSHOT_LIMITS.arrayItems)
        .map((session) => ({ ...session })),
      ...(context.dynamic.vcs
        ? {
            vcs: {
              ...context.dynamic.vcs,
              ...(context.dynamic.vcs.branch
                ? { branch: sanitizeSnapshotString(context.dynamic.vcs.branch) }
                : {}),
            },
          }
        : {}),
    },
    effectiveToolIds: sanitizeSnapshotStrings(context.effectiveToolIds),
    explicitSkillNames: sanitizeSnapshotStrings(context.explicitSkillNames),
    ...(context.sessionListToolId
      ? { sessionListToolId: sanitizeSnapshotString(context.sessionListToolId) }
      : {}),
    ...(context.transcriptReadToolId
      ? { transcriptReadToolId: sanitizeSnapshotString(context.transcriptReadToolId) }
      : {}),
  };
}

/**
 * Returns a deliberately lossy projection for JSON-RPC/debug surfaces.
 * Internal prompt compilation keeps the full manifest; only this copy is bounded and redacted.
 */
export function createSafeCapabilitySnapshot(
  manifest: EffectiveCapabilityManifest,
  turnContext: EffectiveCapabilityTurnContext | undefined,
): SafeCapabilitySnapshot {
  return {
    manifest: sanitizeCapabilityManifest(manifest),
    ...(turnContext ? { turnContext: sanitizeCapabilityTurnContext(turnContext) } : {}),
  };
}
