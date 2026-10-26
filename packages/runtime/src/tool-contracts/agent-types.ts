import type { AppOutputContract } from "@roll-agent/protocol/app-output";
import type { JsonSchemaRefIssue } from "./json-schema-refs.ts";

/** Agent 来源类型 */
export const AGENT_SOURCE_TYPES = [
  "git",
  "local-path",
  "installed-package",
  "remote-manifest",
] as const;
export type AgentSourceType = (typeof AGENT_SOURCE_TYPES)[number];

/** Agent 运行时 ownership */
export const AGENT_RUNTIME_OWNERSHIPS = ["on-demand", "core-managed", "external-managed"] as const;
export type AgentRuntimeOwnership = (typeof AGENT_RUNTIME_OWNERSHIPS)[number];

/** JSON Schema 子集，对应 MCP tool 的 inputSchema */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, object>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly additionalProperties?: boolean | undefined;
  readonly [key: string]: unknown;
}

/** MCP Tool Schema */
export interface AgentTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: JsonSchemaObject;
  readonly schemaIssues?: readonly JsonSchemaRefIssue[];
  readonly appOutput?: AppOutputContract;
  readonly appOutputIssue?: "invalid_contract";
  /** Validated MCP request deadline advertised by this tool. */
  readonly executionTimeoutMs?: number;
}

export const AGENT_TRANSPORT_KINDS = { stdio: "stdio", streamableHttp: "streamable-http" } as const;
export type AgentTransportKind = (typeof AGENT_TRANSPORT_KINDS)[keyof typeof AGENT_TRANSPORT_KINDS];
