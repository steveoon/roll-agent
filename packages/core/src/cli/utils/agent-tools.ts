import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isJsonSchemaObject, isPlainObject } from "../../tool-runtime/schema.ts";
import {
  inlineAcyclicLocalJsonSchemaReferences,
  JSON_SCHEMA_REF_ISSUE_REASONS,
  type JsonSchemaRefIssue,
  type JsonSchemaRefIssueReason,
} from "../../tool-runtime/json-schema-refs.ts";
import type { AgentTool } from "../../types/agent.ts";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

interface ToolSuggestionCandidate {
  readonly name: string;
  readonly distance: number;
  readonly tokenOverlap: number;
  readonly score: number;
}

const TOOL_NAME_TOKEN_SPLIT_PATTERN = /[-_\s]+/;
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/g;

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(NON_ALPHANUMERIC_PATTERN, "");
}

function tokenizeToolName(name: string): string[] {
  return name
    .toLowerCase()
    .split(TOOL_NAME_TOKEN_SPLIT_PATTERN)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
  const nextRow = new Array<number>(right.length + 1).fill(0);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    nextRow[0] = leftIndex + 1;

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      const deleteCost = (previousRow[rightIndex + 1] ?? Number.POSITIVE_INFINITY) + 1;
      const insertCost = (nextRow[rightIndex] ?? Number.POSITIVE_INFINITY) + 1;
      const replaceCost = (previousRow[rightIndex] ?? Number.POSITIVE_INFINITY) + substitutionCost;
      nextRow[rightIndex + 1] = Math.min(deleteCost, insertCost, replaceCost);
    }

    previousRow.splice(0, previousRow.length, ...nextRow);
  }

  return previousRow[right.length] ?? Math.max(left.length, right.length);
}

function countTokenOverlap(leftTokens: readonly string[], rightTokens: readonly string[]): number {
  const remainingRightTokens = [...rightTokens];
  let overlap = 0;

  for (const token of leftTokens) {
    const matchedIndex = remainingRightTokens.indexOf(token);
    if (matchedIndex === -1) {
      continue;
    }

    overlap += 1;
    remainingRightTokens.splice(matchedIndex, 1);
  }

  return overlap;
}

function buildSuggestionCandidate(
  requestedToolName: string,
  candidateName: string,
): ToolSuggestionCandidate {
  const normalizedRequested = normalizeToolName(requestedToolName);
  const normalizedCandidate = normalizeToolName(candidateName);
  const requestedTokens = tokenizeToolName(requestedToolName);
  const candidateTokens = tokenizeToolName(candidateName);
  const distance = levenshteinDistance(normalizedRequested, normalizedCandidate);
  const tokenOverlap = countTokenOverlap(requestedTokens, candidateTokens);
  const hasPrefixMatch =
    normalizedCandidate.startsWith(normalizedRequested) ||
    normalizedRequested.startsWith(normalizedCandidate);
  const hasSubstringMatch =
    normalizedCandidate.includes(normalizedRequested) ||
    normalizedRequested.includes(normalizedCandidate);

  const score =
    distance - tokenOverlap * 3 - (hasPrefixMatch ? 2 : 0) - (hasSubstringMatch ? 1 : 0);

  return {
    name: candidateName,
    distance,
    tokenOverlap,
    score,
  };
}

function isSuggestionCandidate(
  candidate: ToolSuggestionCandidate,
  requestedToolName: string,
): boolean {
  const normalizedRequested = normalizeToolName(requestedToolName);
  const maxDistance = Math.max(2, Math.floor(normalizedRequested.length * 0.45));

  return candidate.tokenOverlap > 0 || candidate.distance <= maxDistance;
}

function compareSuggestionCandidates(
  left: ToolSuggestionCandidate,
  right: ToolSuggestionCandidate,
): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }

  if (left.distance !== right.distance) {
    return left.distance - right.distance;
  }

  if (left.tokenOverlap !== right.tokenOverlap) {
    return right.tokenOverlap - left.tokenOverlap;
  }

  return left.name.localeCompare(right.name);
}

export interface ToolSchemaIssue extends JsonSchemaRefIssue {
  readonly toolName: string;
}

export interface NormalizeListedToolsOptions {
  readonly onSchemaIssue?: (issue: ToolSchemaIssue) => void;
}

const SCHEMA_ISSUE_REASON_LABELS: Record<JsonSchemaRefIssueReason, string> = {
  [JSON_SCHEMA_REF_ISSUE_REASONS.recursive]: "递归引用",
  [JSON_SCHEMA_REF_ISSUE_REASONS.external]: "外部引用",
  [JSON_SCHEMA_REF_ISSUE_REASONS.unresolvable]: "目标不存在",
  [JSON_SCHEMA_REF_ISSUE_REASONS.limit]: "超出展开上限",
};

export function formatToolSchemaIssue(agentName: string, issue: ToolSchemaIssue): string {
  return `Agent "${agentName}" 的工具 "${issue.toolName}" 参数 schema 引用 "${issue.ref}"（位置 ${issue.path || "/"}）无法内联：${SCHEMA_ISSUE_REASON_LABELS[issue.reason]}，模型可能无法调用该工具`;
}

interface NormalizedInputSchema {
  readonly inputSchema: AgentTool["inputSchema"];
  readonly unresolved: readonly JsonSchemaRefIssue[];
}

function normalizeInputSchema(schema: unknown): NormalizedInputSchema {
  if (isPlainObject(schema) && isJsonSchemaObject(schema)) {
    const inlined = inlineAcyclicLocalJsonSchemaReferences(schema);
    return { inputSchema: inlined.schema, unresolved: inlined.unresolved };
  }

  return { inputSchema: { type: "object" }, unresolved: [] };
}

export function normalizeListedTools(
  tools: readonly ListedTool[],
  options: NormalizeListedToolsOptions = {},
): AgentTool[] {
  return tools.map((tool) => {
    const { inputSchema, unresolved } = normalizeInputSchema(tool.inputSchema);
    for (const issue of unresolved) {
      options.onSchemaIssue?.({ toolName: tool.name, ...issue });
    }
    return {
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema,
      ...(unresolved.length > 0 ? { schemaIssues: unresolved } : {}),
    };
  });
}

export function getToolNameSuggestions(
  requestedToolName: string,
  tools: ReadonlyArray<Pick<AgentTool, "name">>,
  maxSuggestions = 3,
): string[] {
  return tools
    .map((tool) => buildSuggestionCandidate(requestedToolName, tool.name))
    .filter((candidate) => isSuggestionCandidate(candidate, requestedToolName))
    .sort(compareSuggestionCandidates)
    .slice(0, maxSuggestions)
    .map((candidate) => candidate.name);
}

export function formatMissingToolMessage(
  agentName: string,
  requestedToolName: string,
  tools: ReadonlyArray<Pick<AgentTool, "name">>,
): string {
  const suggestions = getToolNameSuggestions(requestedToolName, tools);
  const availableToolNames = tools.map((tool) => `\`${tool.name}\``);
  const messageLines = [`Tool "${requestedToolName}" 不存在于 Agent "${agentName}" 中。`];

  if (suggestions.length === 1) {
    const [suggestedTool] = suggestions;
    if (suggestedTool !== undefined) {
      messageLines.push(`Did you mean: \`${suggestedTool}\`?`);
    }
  } else if (suggestions.length > 1) {
    messageLines.push(
      `Did you mean one of: ${suggestions.map((name) => `\`${name}\``).join(", ")}?`,
    );
  }

  if (availableToolNames.length > 0) {
    messageLines.push(`可用 tools: ${availableToolNames.join(", ")}`);
  }

  messageLines.push(`使用 \`roll agent tools ${agentName}\` 查看完整 tool 列表与 inputSchema。`);

  return messageLines.join("\n");
}
