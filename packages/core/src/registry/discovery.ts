import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import matter from "gray-matter";
import { createDefaultRuntimeForTransport } from "../types/agent.ts";
import type { AgentRuntime, AgentSkill, AgentTransport } from "../types/agent.ts";

/** SKILL.md 解析结果 */
export interface DiscoveredAgent {
  readonly skill: AgentSkill;
  readonly transport: AgentTransport;
  readonly runtime: AgentRuntime;
  readonly skillPath: string;
  /** SKILL.md body 内容（frontmatter 之后的 markdown 部分） */
  readonly skillBody: string;
}

/** SKILL.md 文件名 */
const SKILL_FILE_NAME = "SKILL.md";
const PACKAGE_JSON_FILE_NAME = "package.json";

type JsonRecord = Record<string, unknown>;

interface RollAgentManifest {
  runtime: {
    ownership: string;
    transport: string;
  };
  start?: {
    command?: string;
    args?: readonly string[];
  };
  endpoint?: {
    url?: string;
    path?: string;
    port?: number;
  };
  setup?: {
    playwright?: {
      browsers?: readonly string[];
    };
  };
}

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
  const { data, content: skillBody } = matter(raw);
  const manifest = readRollAgentManifest(absDir);

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

  const license = typeof frontmatter["license"] === "string" ? frontmatter["license"] : undefined;
  const compatibility =
    typeof frontmatter["compatibility"] === "string" ? frontmatter["compatibility"] : undefined;

  const skill: AgentSkill = {
    name,
    description,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    metadata,
  };

  const manifestResolution = manifest ? resolveRuntimeFromManifest(manifest) : undefined;
  if (manifestResolution && hasLegacyRuntimeMetadata(metadata)) {
    const legacyTransport = resolveTransport(metadata);
    if (!sameTransport(legacyTransport, manifestResolution.transport)) {
      throw new Error(
        `Conflicting runtime metadata in ${skillPath}: package.json#rollAgent and SKILL.md metadata disagree`,
      );
    }
  }

  const transport = manifestResolution?.transport ?? resolveTransport(metadata);
  const runtime = manifestResolution?.runtime ?? createDefaultRuntimeForTransport(transport);

  return { skill, transport, runtime, skillPath, skillBody: skillBody.trim() };
}

/** 根据 SKILL.md metadata 确定传输模式 */
function resolveTransport(meta: Readonly<Record<string, string>>): AgentTransport {
  const rawTransport = meta["roll-transport"];
  const transportType = rawTransport === "streamable-http" ? "streamable-http" : "stdio";

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

function readRollAgentManifest(agentDir: string): RollAgentManifest | undefined {
  const packageJsonPath = resolve(agentDir, PACKAGE_JSON_FILE_NAME);
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch {
    throw new Error(`Invalid package.json in ${agentDir}`);
  }

  if (!isJsonRecord(parsed) || !isJsonRecord(parsed["rollAgent"])) {
    return undefined;
  }

  const rollAgent = parsed["rollAgent"];
  const runtime = isJsonRecord(rollAgent["runtime"]) ? rollAgent["runtime"] : undefined;
  if (!runtime) {
    throw new Error(`package.json#rollAgent.runtime is required in ${packageJsonPath}`);
  }

  const manifest: RollAgentManifest = {
    runtime: {
      ownership: readString(runtime["ownership"]) ?? "",
      transport: readString(runtime["transport"]) ?? "",
    },
  };

  if (isJsonRecord(rollAgent["start"])) {
    const command = readString(rollAgent["start"]["command"]);
    const args = normalizeStringArray(rollAgent["start"]["args"]);
    if (command || args) {
      manifest.start = {
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
      };
    }
  }

  if (isJsonRecord(rollAgent["endpoint"])) {
    const url = readString(rollAgent["endpoint"]["url"]);
    const path = readString(rollAgent["endpoint"]["path"]);
    const port =
      typeof rollAgent["endpoint"]["port"] === "number" ? rollAgent["endpoint"]["port"] : undefined;
    if (url || path || port !== undefined) {
      manifest.endpoint = {
        ...(url ? { url } : {}),
        ...(path ? { path } : {}),
        ...(port !== undefined ? { port } : {}),
      };
    }
  }

  if (isJsonRecord(rollAgent["setup"]) && isJsonRecord(rollAgent["setup"]["playwright"])) {
    const browsers = normalizeStringArray(rollAgent["setup"]["playwright"]["browsers"]);
    if (browsers && browsers.length > 0) {
      manifest.setup = {
        playwright: {
          browsers,
        },
      };
    }
  }

  return manifest;
}

function resolveRuntimeFromManifest(manifest: RollAgentManifest): {
  readonly transport: AgentTransport;
  readonly runtime: AgentRuntime;
} {
  const { ownership, transport } = manifest.runtime;

  if (ownership === "on-demand" && transport === "stdio") {
    const command = manifest.start?.command;
    if (!command) {
      throw new Error(`package.json#rollAgent.start.command is required for stdio runtime`);
    }

    const args = manifest.start?.args;
    return {
      transport: args ? { type: "stdio", command, args } : { type: "stdio", command },
      runtime: { ownership: "on-demand" },
    };
  }

  if (ownership === "core-managed" && transport === "streamable-http") {
    const command = manifest.start?.command;
    const endpoint = resolveManifestHttpEndpoint(manifest);
    const path = manifest.endpoint?.path;
    const port = manifest.endpoint?.port;
    if (!command || !path || port === undefined) {
      throw new Error(
        `package.json#rollAgent for core-managed streamable-http requires start.command, endpoint.path and endpoint.port`,
      );
    }

    const args = manifest.start?.args;
    const setupBrowsers = manifest.setup?.playwright?.browsers;
    return {
      transport: {
        type: "streamable-http",
        endpoint,
      },
      runtime: {
        ownership: "core-managed",
        start: args ? { command, args } : { command },
        endpoint: { path, port },
        ...(setupBrowsers && setupBrowsers.length > 0
          ? { setup: { playwright: { browsers: setupBrowsers } } }
          : {}),
      },
    };
  }

  if (ownership === "external-managed" && transport === "streamable-http") {
    return {
      transport: {
        type: "streamable-http",
        endpoint: resolveManifestHttpEndpoint(manifest),
      },
      runtime: { ownership: "external-managed" },
    };
  }

  throw new Error(
    `Unsupported package.json#rollAgent runtime combination: ${ownership}/${transport}`,
  );
}

function resolveManifestHttpEndpoint(manifest: RollAgentManifest): string {
  const url = manifest.endpoint?.url;
  if (url) {
    return url;
  }

  const path = manifest.endpoint?.path;
  const port = manifest.endpoint?.port;
  if (!path || port === undefined) {
    throw new Error(
      `package.json#rollAgent.streamable-http requires endpoint.url or endpoint.path + endpoint.port`,
    );
  }

  return buildLocalHttpEndpoint(path, port);
}

function buildLocalHttpEndpoint(path: string, port: number): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `http://127.0.0.1:${String(port)}${normalizedPath}`;
}

function hasLegacyRuntimeMetadata(meta: Readonly<Record<string, string>>): boolean {
  return (
    typeof meta["roll-transport"] === "string" ||
    typeof meta["roll-endpoint"] === "string" ||
    typeof meta["roll-command"] === "string"
  );
}

function sameTransport(left: AgentTransport, right: AgentTransport): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "streamable-http" && right.type === "streamable-http") {
    return left.endpoint === right.endpoint;
  }

  if (left.type !== "stdio" || right.type !== "stdio") {
    return false;
  }

  const leftArgs = left.args ?? [];
  const rightArgs = right.args ?? [];
  return left.command === right.command && leftArgs.join("\u0000") === rightArgs.join("\u0000");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const next = value.filter((entry): entry is string => typeof entry === "string");
  return next.length > 0 ? next : undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
