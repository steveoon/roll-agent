export interface ToolRoute {
  readonly agentName: string;
  readonly toolName: string;
}

const INVALID_TOOL_ID_CHARS = /[^a-zA-Z0-9_-]/g;

function sanitize(name: string): string {
  return name.replace(INVALID_TOOL_ID_CHARS, "_");
}

export class ToolRegistry {
  private readonly routes = new Map<string, ToolRoute>();

  register(agentName: string, toolName: string): string {
    const base = `${sanitize(agentName)}__${sanitize(toolName)}`;
    let id = base;
    let suffix = 1;
    while (this.routes.has(id)) {
      id = `${base}_${String(suffix)}`;
      suffix += 1;
    }
    this.routes.set(id, { agentName, toolName });
    return id;
  }

  resolve(id: string): ToolRoute | undefined {
    return this.routes.get(id);
  }

  size(): number {
    return this.routes.size;
  }
}
