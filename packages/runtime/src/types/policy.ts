export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

export type PolicyAction = "allow" | "confirm" | "deny";

export interface PolicyDecision {
  readonly action: PolicyAction;
  readonly reason?: string;
}

export interface ToolPolicyContext {
  readonly agentName: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly annotations?: ToolAnnotations;
}

export interface ToolPolicy {
  check(context: ToolPolicyContext): PolicyDecision;
}
