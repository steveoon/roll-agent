import type { PolicyDecision, ToolPolicy, ToolPolicyContext } from "../types/policy.ts";

export const UNATTENDED_CONFIRMATION_DENIED_REASON = "无人值守运行不支持交互确认";

export interface UnattendedDeniedConfirmation {
  readonly agentName: string;
  readonly toolName: string;
  readonly reason: string | undefined;
}

export class UnattendedToolPolicy implements ToolPolicy {
  private readonly inner: ToolPolicy;
  private readonly denied: UnattendedDeniedConfirmation[] = [];

  constructor(inner: ToolPolicy) {
    this.inner = inner;
  }

  check(context: ToolPolicyContext): PolicyDecision {
    const decision = this.inner.check(context);
    if (decision.action !== "confirm") {
      return decision;
    }
    this.denied.push({
      agentName: context.agentName,
      toolName: context.toolName,
      reason: decision.reason,
    });
    return { action: "deny", reason: UNATTENDED_CONFIRMATION_DENIED_REASON };
  }

  get deniedConfirmations(): readonly UnattendedDeniedConfirmation[] {
    return [...this.denied];
  }
}
