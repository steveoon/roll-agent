import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import matter from "gray-matter";
import type { AgentSkill, AgentTransport, RollSkillMetadata } from "../types/agent.ts";

/** SKILL.md 解析结果 */
export interface DiscoveredAgent {
  readonly skill: AgentSkill;
  readonly transport: AgentTransport;
  readonly skillPath: string;
}

/** SKILL.md 文件名 */
const SKILL_FILE_NAME = "SKILL.md";

/**
 * 解析指定目录下的 SKILL.md，提取 Agent 描述和传输配置。
 *
 * @throws 找不到 SKILL.md 或缺少必需字段时抛出错误
 */
export function discoverAgent(agentDir: string): DiscoveredAgent {
  const absDir = resolve(agentDir);
  const skillPath = resolve(absDir, SKILL_FILE_NAME);

  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md not found in ${absDir}`);
  }

  const raw = readFileSync(skillPath, "utf-8");
  const { data } = matter(raw);

  // 校验必需字段
  const frontmatter = data as Record<string, unknown>;
  const name = frontmatter["name"];
  const description = frontmatter["description"];

  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`SKILL.md missing required field "name" in ${skillPath}`);
  }

  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`SKILL.md missing required field "description" in ${skillPath}`);
  }

  // 提取 metadata
  const rawMetadata = (frontmatter["metadata"] ?? {}) as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawMetadata)) {
    metadata[key] = String(value);
  }

  const skill: AgentSkill = {
    name,
    description,
    ...(typeof frontmatter["license"] === "string" ? { license: frontmatter["license"] } : {}),
    ...(typeof frontmatter["compatibility"] === "string"
      ? { compatibility: frontmatter["compatibility"] }
      : {}),
    metadata,
  };

  // 从 metadata 中解析 Roll 扩展字段
  const rollMeta = metadata as unknown as RollSkillMetadata;
  const transport = resolveTransport(rollMeta);

  return { skill, transport, skillPath };
}

/** 根据 SKILL.md metadata 确定传输模式 */
function resolveTransport(meta: RollSkillMetadata): AgentTransport {
  const transportType = meta["roll-transport"] ?? "stdio";

  if (transportType === "streamable-http") {
    const endpoint = meta["roll-endpoint"];
    if (!endpoint) {
      throw new Error(`SKILL.md declares streamable-http transport but missing "roll-endpoint"`);
    }
    return { type: "streamable-http", endpoint };
  }

  // stdio 模式：使用 roll-command 或默认 node 启动
  const command = meta["roll-command"] ?? "node --experimental-strip-types src/index.ts";
  const parts = command.split(/\s+/);
  const executable = parts[0];
  const args = parts.slice(1);

  if (!executable) {
    throw new Error(`Invalid roll-command in SKILL.md`);
  }

  if (args.length > 0) {
    return { type: "stdio", command: executable, args };
  }
  return { type: "stdio", command: executable };
}
