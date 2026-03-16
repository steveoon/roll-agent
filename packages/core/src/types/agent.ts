/** Agent 传输模式 */
export type AgentTransport =
  | { readonly type: "stdio"; readonly command: string; readonly args?: readonly string[] }
  | { readonly type: "streamable-http"; readonly endpoint: string };

/** SKILL.md frontmatter 解析结果 */
export interface AgentSkill {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Agent 运行状态 */
export const AGENT_STATUSES = ["idle", "starting", "online", "error", "stopped"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Agent 来源类型 */
export const AGENT_SOURCE_TYPES = ["git", "local", "installed", "remote"] as const;
export type AgentSourceType = (typeof AGENT_SOURCE_TYPES)[number];

/** Agent 来源（用于 update 策略判断） */
export interface GitAgentSource {
  readonly type: "git";
  readonly url: string;
}

export interface LocalAgentSource {
  readonly type: "local";
  readonly path: string;
}

export interface InstalledAgentSource {
  readonly type: "installed";
  readonly packageName: string;
  readonly packageSpec: string;
  readonly installDir: string;
}

export interface RemoteAgentSource {
  readonly type: "remote";
  readonly endpoint: string;
}

export type AgentSource =
  | GitAgentSource
  | LocalAgentSource
  | InstalledAgentSource
  | RemoteAgentSource;

/** 已注册的 Agent 完整信息 */
export interface RegisteredAgent {
  readonly skill: AgentSkill;
  readonly transport: AgentTransport;
  readonly installPath: string;
  readonly registeredAt: string;
  readonly status: AgentStatus;
  /** SKILL.md body 内容（含 tool 描述等），用于 LLM 路由 */
  readonly skillBody?: string;
  /** Agent 来源，用于 roll update 判断更新策略。旧数据可能缺失此字段 */
  readonly source?: AgentSource;
}

/** JSON Schema 子集，对应 MCP tool 的 inputSchema */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly [key: string]: unknown;
}

/** MCP Tool Schema */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}
