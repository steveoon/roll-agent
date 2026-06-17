import type { PolicyDecision, ToolPolicy, ToolPolicyContext } from "../types/policy.ts";
import { DefaultToolPolicy } from "./default-policy.ts";

export const TOOL_APPROVAL_DEFAULTS = ["guarded", "auto", "deny"] as const;
export type ToolApprovalDefault = (typeof TOOL_APPROVAL_DEFAULTS)[number];

export const TOOL_APPROVAL_OVERRIDE_ACTIONS = ["auto", "confirm", "deny"] as const;
export type ToolApprovalOverrideAction = (typeof TOOL_APPROVAL_OVERRIDE_ACTIONS)[number];

export interface ConfigurableToolPolicyOptions {
  readonly defaultMode?: ToolApprovalDefault;
  readonly overrides?: Readonly<Record<string, ToolApprovalOverrideAction>>;
  readonly fallback?: ToolPolicy;
}

function toolKey(context: ToolPolicyContext): string {
  return `${context.agentName}.${context.toolName}`;
}

function overrideDecision(action: ToolApprovalOverrideAction): PolicyDecision {
  if (action === "auto") {
    return { action: "allow" };
  }
  if (action === "confirm") {
    return { action: "confirm", reason: "配置要求确认" };
  }
  return { action: "deny", reason: "配置拒绝执行" };
}

export class ConfigurableToolPolicy implements ToolPolicy {
  private readonly defaultMode: ToolApprovalDefault;
  private readonly overrides: Readonly<Record<string, ToolApprovalOverrideAction>>;
  private readonly fallback: ToolPolicy;

  constructor(options: ConfigurableToolPolicyOptions = {}) {
    this.defaultMode = options.defaultMode ?? "guarded";
    this.overrides = options.overrides ?? {};
    this.fallback = options.fallback ?? new DefaultToolPolicy();
  }

  check(context: ToolPolicyContext): PolicyDecision {
    const override = this.overrides[toolKey(context)];
    if (override !== undefined) {
      return overrideDecision(override);
    }

    if (this.defaultMode === "auto") {
      return context.annotations?.destructiveHint === true
        ? { action: "confirm", reason: "破坏性操作" }
        : { action: "allow" };
    }

    if (this.defaultMode === "deny") {
      return { action: "deny", reason: "默认策略拒绝执行" };
    }

    return this.fallback.check(context);
  }
}
