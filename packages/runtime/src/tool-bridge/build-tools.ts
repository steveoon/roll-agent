import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import {
  inlineAcyclicLocalJsonSchemaReferences,
  type JsonSchemaRefIssue,
} from "@roll-agent/core/tool-runtime/json-schema-refs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { FileChangeDiff } from "@roll-agent/protocol";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { preflightToolCall } from "@roll-agent/core/tool-runtime/preflight";
import type { AgentTool } from "@roll-agent/core/types/agent";
import type { SessionApprovalMemory } from "../approval/approval-memory.ts";
import type { ApprovalDecision } from "../approval/approval-gate.ts";
import type { ToolAnnotations, ToolPolicy } from "../types/policy.ts";
import { ToolRegistry, type ToolRouteMetadata } from "./naming.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  normalizeToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "./normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  TOOL_RESOURCE_HINT_KINDS,
  executeCoordinatedTool,
  type ToolExecutionCoordinator,
  type ToolExecutionPlan,
  type ToolResourceAccess,
  type ToolResourceAccessMode,
  type ToolResourceHint,
} from "./tool-execution-coordinator.ts";

export const ROLL_RESOURCE_HINTS_META_KEY = "roll/resourceHints";

export interface SourceTool {
  readonly tool: AgentTool;
  readonly annotations: ToolAnnotations | undefined;
  readonly resourceHints?: readonly ToolResourceHint[];
}

export interface AgentToolSource {
  readonly agentName: string;
  readonly client: Client;
  readonly tools: readonly SourceTool[];
  readonly agentSource?: ToolRouteMetadata["agentSource"];
  readonly transport?: ToolRouteMetadata["transport"];
  readonly runtimeOwnership?: ToolRouteMetadata["runtimeOwnership"];
  /** Base directory used by a local stdio Agent to resolve relative file resource hints. */
  readonly resourceBaseDir?: string;
}

export interface ApprovalRequest {
  readonly agentName: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly reason: string | undefined;
  readonly explanation?: string;
  readonly sessionGrantLabel?: string;
  readonly diff?: FileChangeDiff;
}

export interface ToolBridgeContext {
  readonly policy?: ToolPolicy;
  readonly requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  readonly coordinator?: ToolExecutionCoordinator;
  readonly approvalMemory?: SessionApprovalMemory;
}

interface ApprovalDisplayOptions {
  readonly explanation?: string;
  /** False when a conservative policy label would overstate the actual user-visible risk. */
  readonly includePolicyReason?: boolean;
  readonly memoryKey?: string;
  readonly sessionGrantLabel?: string;
  readonly diff?: FileChangeDiff;
}

export interface BuiltToolset {
  readonly tools: ToolSet;
  readonly registry: ToolRegistry;
  readonly schemaIssuesByToolId: Readonly<Record<string, readonly JsonSchemaRefIssue[]>>;
}

function mergeSchemaIssues(
  attached: readonly JsonSchemaRefIssue[] | undefined,
  detected: readonly JsonSchemaRefIssue[],
): readonly JsonSchemaRefIssue[] {
  const merged = new Map<string, JsonSchemaRefIssue>();
  for (const issue of [...(attached ?? []), ...detected]) {
    merged.set(`${issue.path}\u0000${issue.ref}`, issue);
  }
  return [...merged.values()];
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function formatPreflightFailure(
  issues: ReadonlyArray<{ readonly path: string; readonly message: string }>,
): string {
  return `参数校验失败: ${issues.map((issue) => issue.message).join("; ")}`;
}

function defaultResourceMode(annotations: ToolAnnotations | undefined): ToolResourceAccessMode {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true
    ? TOOL_RESOURCE_ACCESS_MODES.read
    : TOOL_RESOURCE_ACCESS_MODES.write;
}

function resourceValues(value: unknown): Array<string | number> | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return [value];
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (item): item is string | number => typeof item === "string" || typeof item === "number",
    )
  ) {
    return undefined;
  }
  return value;
}

const MAX_CASE_SENSITIVITY_CACHE_ENTRIES = 256;
const caseInsensitiveDirectoryCache = new Map<string, boolean>();

function alternateAsciiCase(name: string, existingNames: ReadonlySet<string>): string | undefined {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    const replacement =
      code >= 65 && code <= 90
        ? String.fromCharCode(code + 32)
        : code >= 97 && code <= 122
          ? String.fromCharCode(code - 32)
          : undefined;
    if (replacement === undefined) {
      continue;
    }
    const candidate = `${name.slice(0, index)}${replacement}${name.slice(index + 1)}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function probeEntryCaseInsensitivity(
  directory: string,
  name: string,
  existingNames: ReadonlySet<string>,
): boolean | undefined {
  const alias = alternateAsciiCase(name, existingNames);
  if (alias === undefined) {
    return undefined;
  }
  try {
    const exact = lstatSync(resolve(directory, name));
    const alternate = lstatSync(resolve(directory, alias));
    return exact.dev === alternate.dev && exact.ino === alternate.ino;
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
  }
}

function rememberDirectoryCaseSensitivity(directory: string, caseInsensitive: boolean): boolean {
  if (caseInsensitiveDirectoryCache.size >= MAX_CASE_SENSITIVITY_CACHE_ENTRIES) {
    const oldest = caseInsensitiveDirectoryCache.keys().next().value;
    if (oldest !== undefined) {
      caseInsensitiveDirectoryCache.delete(oldest);
    }
  }
  caseInsensitiveDirectoryCache.set(directory, caseInsensitive);
  return caseInsensitive;
}

function hasCaseInsensitiveLookups(directory: string): boolean {
  const cached = caseInsensitiveDirectoryCache.get(directory);
  if (cached !== undefined) {
    return cached;
  }

  let device: number;
  try {
    device = lstatSync(directory).dev;
  } catch {
    return rememberDirectoryCaseSensitivity(directory, true);
  }

  let candidateDirectory = directory;
  while (true) {
    const candidateCached = caseInsensitiveDirectoryCache.get(candidateDirectory);
    if (candidateCached !== undefined) {
      return rememberDirectoryCaseSensitivity(directory, candidateCached);
    }
    try {
      const names = readdirSync(candidateDirectory);
      const existingNames = new Set(names);
      for (const name of names) {
        const result = probeEntryCaseInsensitivity(candidateDirectory, name, existingNames);
        if (result !== undefined) {
          rememberDirectoryCaseSensitivity(candidateDirectory, result);
          return rememberDirectoryCaseSensitivity(directory, result);
        }
      }
    } catch {
      // Continue toward the root while staying on the same filesystem device.
    }

    const parent = dirname(candidateDirectory);
    if (parent === candidateDirectory) {
      break;
    }
    try {
      if (lstatSync(parent).dev !== device) {
        break;
      }
    } catch {
      break;
    }
    candidateDirectory = parent;
  }
  // An empty or non-letter-only filesystem gives us no observable casing probe.
  // Treat that unknown state as case-insensitive so equivalent write paths cannot race.
  return rememberDirectoryCaseSensitivity(directory, true);
}

interface CanonicalFileResource {
  readonly path: string;
  readonly unresolvedAliasKey?: string;
}

function unicodeCaseFold(value: string): string {
  // Some folds expand over more than one pass (for example ẞ -> ß -> ss).
  let folded = value.normalize("NFC");
  for (let pass = 0; pass < 8; pass += 1) {
    const next = folded.toUpperCase().toLowerCase().normalize("NFC");
    if (next === folded) {
      return folded;
    }
    folded = next;
  }
  return folded;
}

function unresolvedFileAliasKey(
  canonicalAncestor: string,
  canonicalSuffix: readonly string[],
): string | undefined {
  try {
    const identity = statSync(canonicalAncestor, { bigint: true });
    const foldedSuffix = canonicalSuffix.map((segment) => unicodeCaseFold(segment));
    // Scope the guard to one folded future path, rather than serializing the whole directory.
    return `file-unresolved-alias:${identity.dev.toString()}:${identity.ino.toString()}:${JSON.stringify(foldedSuffix)}`;
  } catch {
    return undefined;
  }
}

function canonicalFileResourcePath(
  path: string,
  visitedSymlinks: ReadonlySet<string> = new Set<string>(),
): CanonicalFileResource {
  let ancestor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = realpathSync.native(ancestor);
      const canonicalSuffix = suffix.reverse().map((segment) => segment.normalize("NFC"));
      if (canonicalSuffix.length === 0) {
        return { path: canonicalAncestor };
      }
      const caseInsensitive = hasCaseInsensitiveLookups(canonicalAncestor);
      const canonicalPath = resolve(
        canonicalAncestor,
        ...(caseInsensitive
          ? canonicalSuffix.map((segment) => segment.toLowerCase())
          : canonicalSuffix),
      );
      const unresolvedAliasKey = caseInsensitive
        ? unresolvedFileAliasKey(canonicalAncestor, canonicalSuffix)
        : undefined;
      return {
        path: canonicalPath,
        ...(unresolvedAliasKey === undefined ? {} : { unresolvedAliasKey }),
      };
    } catch {
      try {
        if (lstatSync(ancestor).isSymbolicLink() && !visitedSymlinks.has(ancestor)) {
          const nextVisitedSymlinks = new Set(visitedSymlinks);
          nextVisitedSymlinks.add(ancestor);
          const target = readlinkSync(ancestor);
          return canonicalFileResourcePath(
            resolve(dirname(ancestor), target, ...[...suffix].reverse()),
            nextVisitedSymlinks,
          );
        }
      } catch {
        // Keep walking to the nearest existing ancestor when this path is not a symlink.
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        return { path };
      }
      suffix.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

function existingFileIdentityKey(path: string): string | undefined {
  try {
    const identity = statSync(path, { bigint: true });
    return `file-inode:${identity.dev.toString()}:${identity.ino.toString()}`;
  } catch {
    return undefined;
  }
}

function hintedResourceKey(
  hint: ToolResourceHint,
  value: string | number,
  resourceBaseDir: string | undefined,
): readonly string[] | undefined {
  const normalized = String(value).trim();
  if (normalized.length === 0) {
    return undefined;
  }
  switch (hint.kind) {
    case TOOL_RESOURCE_HINT_KINDS.file: {
      if (!isAbsolute(normalized) && resourceBaseDir === undefined) {
        return undefined;
      }
      const resource = canonicalFileResourcePath(resolve(resourceBaseDir ?? "/", normalized));
      const identityKey = existingFileIdentityKey(resource.path);
      return [
        `file:${resource.path}`,
        ...(resource.unresolvedAliasKey === undefined ? [] : [resource.unresolvedAliasKey]),
        ...(identityKey === undefined ? [] : [identityKey]),
      ];
    }
    case TOOL_RESOURCE_HINT_KINDS.browserSession:
      return [`browser-session:${normalized}`];
    case TOOL_RESOURCE_HINT_KINDS.conversation:
      return [`conversation:${normalized}`];
    case TOOL_RESOURCE_HINT_KINDS.custom: {
      const namespace = hint.namespace?.trim();
      return namespace ? [`${namespace}:${normalized}`] : undefined;
    }
  }
}

function resolveAgentToolResources(
  agentName: string,
  resourceBaseDir: string | undefined,
  input: unknown,
  annotations: ToolAnnotations | undefined,
  hints: readonly ToolResourceHint[] | undefined,
): ToolResourceAccess[] {
  const mode = defaultResourceMode(annotations);
  const record = asRecord(input);
  const fallback = [{ key: `agent:${agentName}`, mode }];
  const hinted: ToolResourceAccess[] = [];
  for (const hint of hints ?? []) {
    if (!Object.hasOwn(record, hint.field)) {
      continue;
    }
    const values = resourceValues(record[hint.field]);
    if (values === undefined) {
      return fallback;
    }
    for (const value of values) {
      const keys = hintedResourceKey(hint, value, resourceBaseDir);
      if (keys === undefined || keys.length === 0) {
        return fallback;
      }
      hinted.push(...keys.map((key) => ({ key, mode: hint.mode ?? mode })));
    }
  }
  if (hinted.length === 0) {
    return fallback;
  }
  return [{ key: `agent:${agentName}`, mode: TOOL_RESOURCE_ACCESS_MODES.read }, ...hinted];
}

export async function gateToolCall(
  ctx: ToolBridgeContext,
  agentName: string,
  toolName: string,
  input: Record<string, unknown>,
  annotations: ToolAnnotations | undefined,
  display?: ApprovalDisplayOptions,
): Promise<NormalizedToolResult | undefined> {
  if (!ctx.policy) {
    return undefined;
  }
  const decision = ctx.policy.check({
    agentName,
    toolName,
    input,
    ...(annotations ? { annotations } : {}),
  });
  if (decision.action === "deny") {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.policyDenied,
      `策略拒绝执行${decision.reason ? `: ${decision.reason}` : ""}`,
      decision.reason ? { reason: decision.reason } : {},
    );
  }
  if (decision.action === "confirm") {
    const memoryKey = display?.memoryKey;
    if (memoryKey !== undefined && ctx.approvalMemory?.isGranted(memoryKey)) {
      return undefined;
    }
    const approval = await ctx.requestApproval({
      agentName,
      toolName,
      input,
      reason: display?.includePolicyReason === false ? undefined : decision.reason,
      ...(display?.explanation !== undefined ? { explanation: display.explanation } : {}),
      ...(display?.diff !== undefined ? { diff: display.diff } : {}),
      ...(memoryKey !== undefined && display?.sessionGrantLabel !== undefined
        ? { sessionGrantLabel: display.sessionGrantLabel }
        : {}),
    });
    if (!approval.approved) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.userRejected,
        `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`,
        approval.reason ? { reason: approval.reason } : {},
      );
    }
    if (memoryKey !== undefined && approval.scope === "session") {
      ctx.approvalMemory?.grant(memoryKey);
    }
  }
  return undefined;
}

export function buildAgentToolset(
  sources: readonly AgentToolSource[],
  ctx: ToolBridgeContext,
  registry: ToolRegistry = new ToolRegistry(),
): BuiltToolset {
  const tools: ToolSet = {};
  const schemaIssuesByToolId: Record<string, readonly JsonSchemaRefIssue[]> = {};

  for (const source of sources) {
    const { client, agentName, agentSource, transport, runtimeOwnership, resourceBaseDir } = source;
    for (const { tool: listedTool, annotations, resourceHints } of source.tools) {
      const inlined = inlineAcyclicLocalJsonSchemaReferences(listedTool.inputSchema);
      const schemaIssues = mergeSchemaIssues(listedTool.schemaIssues, inlined.unresolved);
      const agentTool: AgentTool = {
        ...listedTool,
        inputSchema: inlined.schema,
        ...(schemaIssues.length > 0 ? { schemaIssues } : {}),
      };
      const id = registry.register(agentName, agentTool.name, {
        ...(agentSource ? { agentSource } : {}),
        ...(transport ? { transport } : {}),
        ...(runtimeOwnership ? { runtimeOwnership } : {}),
        ...(annotations ? { annotations } : {}),
      });
      if (schemaIssues.length > 0) {
        schemaIssuesByToolId[id] = schemaIssues;
      }
      const plan: ToolExecutionPlan = {
        prepare: async (input) => {
          const args = asRecord(input);
          const preflight = preflightToolCall(agentTool, args);
          if (!preflight.ok) {
            return failedToolResult(
              TOOL_OUTCOME_KINDS.invalidInput,
              formatPreflightFailure(preflight.issues),
              { raw: preflight.issues },
            );
          }
          return gateToolCall(ctx, agentName, agentTool.name, args, annotations);
        },
        resources: (input) =>
          resolveAgentToolResources(agentName, resourceBaseDir, input, annotations, resourceHints),
      };
      ctx.coordinator?.register(id, plan);
      tools[id] = tool({
        description: agentTool.description ?? `${agentTool.name} (via ${agentName})`,
        inputSchema: jsonSchema(agentTool.inputSchema as unknown as JSONSchema7),
        toModelOutput: ({ output }) => toolResultToModelOutput(output),
        execute: async (
          input: unknown,
          options: ToolExecutionOptions<unknown>,
        ): Promise<NormalizedToolResult> => {
          const args = asRecord(input);
          return executeCoordinatedTool(
            ctx.coordinator,
            plan,
            id,
            options.toolCallId,
            args,
            options.abortSignal,
            async () => {
              const requestOptions = options.abortSignal
                ? { signal: options.abortSignal }
                : undefined;
              const result = await client.callTool(
                { name: agentTool.name, arguments: args },
                undefined,
                requestOptions,
              );
              return normalizeToolResult(result);
            },
          );
        },
      });
    }
  }

  return { tools, registry, schemaIssuesByToolId };
}
