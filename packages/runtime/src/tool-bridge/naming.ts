import type {
  AgentRuntimeOwnership,
  AgentSourceType,
  AgentTransport,
} from "@roll-agent/core/types/agent";
import type { ToolAnnotations } from "../types/policy.ts";

export interface ToolRouteMetadata {
  readonly agentSource?: AgentSourceType;
  readonly transport?: AgentTransport["type"];
  readonly runtimeOwnership?: AgentRuntimeOwnership;
  readonly annotations?: ToolAnnotations;
}

export interface ToolRoute extends ToolRouteMetadata {
  readonly agentName: string;
  readonly toolName: string;
}

const INVALID_TOOL_ID_CHARS = /[^a-zA-Z0-9_-]/g;

function sanitize(name: string): string {
  return name.replace(INVALID_TOOL_ID_CHARS, "_");
}

export class ToolRegistry {
  private readonly routes = new Map<string, ToolRoute>();

  register(agentName: string, toolName: string, metadata: ToolRouteMetadata = {}): string {
    const base = `${sanitize(agentName)}__${sanitize(toolName)}`;
    let id = base;
    let suffix = 1;
    while (this.routes.has(id)) {
      id = `${base}_${String(suffix)}`;
      suffix += 1;
    }
    this.routes.set(id, {
      agentName,
      toolName,
      ...(metadata.agentSource ? { agentSource: metadata.agentSource } : {}),
      ...(metadata.transport ? { transport: metadata.transport } : {}),
      ...(metadata.runtimeOwnership ? { runtimeOwnership: metadata.runtimeOwnership } : {}),
      ...(metadata.annotations ? { annotations: { ...metadata.annotations } } : {}),
    });
    return id;
  }

  resolve(id: string): ToolRoute | undefined {
    return this.routes.get(id);
  }

  size(): number {
    return this.routes.size;
  }
}
