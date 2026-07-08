import { parsePackageName } from "./source.ts";
import type { RollConfig } from "../config/schema.ts";

export interface AgentCatalogEntry {
  readonly shortName: string;
  readonly packageName: string;
  readonly skillName: string;
  readonly description: string;
  readonly requiredEnv: readonly string[];
  readonly minCoreVersion?: string;
}

export const OFFICIAL_AGENT_CATALOG = [
  {
    shortName: "browser-use",
    packageName: "@roll-agent/browser-use-agent",
    skillName: "browser-use-agent",
    description:
      "浏览器操控 Agent。控制浏览器操作招聘平台：读取消息、发送签名回复、筛选候选人，并提供通用 AX snapshot 与元素点击/输入能力。",
    requiredEnv: [
      "REPLY_AUTHORITY_URL",
      "REPLY_AUTHORITY_BEARER_TOKEN",
      "REPLY_AUTHORITY_KEYS_URL",
      "RECRUITMENT_EVENTS_DEFAULT_AGENT_ID",
      "RECRUITMENT_EVENTS_API_TOKEN",
    ],
  },
  {
    shortName: "smart-reply",
    packageName: "@roll-agent/smart-reply-agent",
    skillName: "smart-reply-agent",
    description: "招聘智能回复 Agent。根据候选人消息和上下文，向 Reply Authority Service 请求已签名回复。",
    requiredEnv: ["REPLY_AUTHORITY_URL", "REPLY_AUTHORITY_BEARER_TOKEN"],
  },
  {
    shortName: "reply-policy-tuner",
    packageName: "@roll-agent/reply-policy-tuner-agent",
    skillName: "reply-policy-tuner-agent",
    description:
      "策略 RSI 编排 Agent（Reply Policy Tuner）。评估、编排与更新招聘回复策略，update 带 evaluate 门禁，与 browser-use 协同使用。",
    requiredEnv: ["REPLY_AUTHORITY_URL", "REPLY_AUTHORITY_BEARER_TOKEN"],
  },
  {
    shortName: "octopus",
    packageName: "@roll-agent/octopus-agent",
    skillName: "octopus-agent",
    description:
      "丸子 Agent（Octopus）。把自然语言问题转换为只读 SQL，并通过 Sponge MCP Server 校验和执行。",
    requiredEnv: ["SPONGE_MCP_BASE_URL", "SPONGE_MCP_ACCESS_TOKEN"],
  },
] as const satisfies readonly AgentCatalogEntry[];

export type OfficialAgentShortName = (typeof OFFICIAL_AGENT_CATALOG)[number]["shortName"];

export function getAgentCatalog(_config?: RollConfig): readonly AgentCatalogEntry[] {
  return OFFICIAL_AGENT_CATALOG;
}

export interface CatalogEntryMatch {
  readonly entry: AgentCatalogEntry;
  readonly versionSpec?: string;
}

export function findCatalogEntry(
  catalog: readonly AgentCatalogEntry[],
  input: string,
): CatalogEntryMatch | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const name = parsePackageName(trimmed);
  const rawVersionSpec = trimmed.length > name.length ? trimmed.slice(name.length + 1) : undefined;
  const versionSpec = rawVersionSpec && rawVersionSpec.length > 0 ? rawVersionSpec : undefined;

  const entry = catalog.find((item) => item.shortName === name || item.packageName === name);
  if (!entry) {
    return undefined;
  }

  return { entry, ...(versionSpec ? { versionSpec } : {}) };
}

export function catalogPackageSpec(entry: AgentCatalogEntry, versionSpec?: string): string {
  return versionSpec ? `${entry.packageName}@${versionSpec}` : entry.packageName;
}
