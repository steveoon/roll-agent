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

/** SKILL.md metadata 中 Roll 扩展字段 */
export interface RollSkillMetadata {
  readonly "roll-transport"?: "stdio" | "streamable-http";
  readonly "roll-command"?: string;
  readonly "roll-endpoint"?: string;
  readonly "roll-health-check"?: string;
}

/** Agent 运行状态 */
export type AgentStatus = "idle" | "starting" | "online" | "error" | "stopped";

/** 已注册的 Agent 完整信息 */
export interface RegisteredAgent {
  readonly skill: AgentSkill;
  readonly transport: AgentTransport;
  readonly installPath: string;
  readonly registeredAt: string;
  readonly status: AgentStatus;
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
