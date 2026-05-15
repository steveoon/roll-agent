import { StructuredToolError } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import type { BrowserSecurityConfig } from "@roll-agent/browser";
import { z } from "zod";
import {
  approveToolAction,
  createToolActionApprovalRequest,
  isToolActionApprovalValid,
  type ToolActionApproval,
  type ToolActionApprovalSubject,
} from "./tool-action-approval.ts";

export const BROWSER_USE_TOOL_POLICIES = ["log", "deny", "confirm"] as const;
export const BrowserUseToolPolicySchema = z.enum(BROWSER_USE_TOOL_POLICIES);
export type BrowserUseToolPolicy = z.infer<typeof BrowserUseToolPolicySchema>;

export const BROWSER_USE_TOOL_POLICY_SUPPORTED_TOOLS = ["zhipin_send_prepared_reply"] as const;

export const BROWSER_USE_POLICY_WARNING_CODES = [
  "unknown_tool_policy",
  "double_confirmation",
  "browser_action_policy_not_recommended",
] as const;
export const BrowserUsePolicyWarningSchema = z.object({
  code: z.enum(BROWSER_USE_POLICY_WARNING_CODES),
  message: z.string(),
});
export type BrowserUsePolicyWarning = z.infer<typeof BrowserUsePolicyWarningSchema>;

const BrowserUseToolPolicyEntrySchema = z.object({
  policy: BrowserUseToolPolicySchema,
});

export const BrowserUsePolicyConfigSchema = z.object({
  approvalTtlMs: z.number().int().positive().max(3_600_000).default(300_000),
  tools: z.record(BrowserUseToolPolicyEntrySchema).default({}),
});
export type BrowserUsePolicyConfig = z.infer<typeof BrowserUsePolicyConfigSchema>;

const DEFAULT_BROWSER_USE_POLICY = BrowserUsePolicyConfigSchema.parse({});
const SUPPORTED_TOOL_POLICY_TOOL_SET = new Set<string>(BROWSER_USE_TOOL_POLICY_SUPPORTED_TOOLS);

let currentPolicy = DEFAULT_BROWSER_USE_POLICY;

function parseBrowserUsePolicyJson(value: string | undefined): unknown {
  if (value === undefined) {
    return {};
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `BROWSER_USE_POLICY_JSON must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function loadBrowserUsePolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrowserUsePolicyConfig {
  try {
    return BrowserUsePolicyConfigSchema.parse(
      parseBrowserUsePolicyJson(env["BROWSER_USE_POLICY_JSON"]),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("BROWSER_USE_POLICY_JSON must be valid JSON")
    ) {
      throw error;
    }
    throw new Error(
      `BROWSER_USE_POLICY_JSON is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function setBrowserUsePolicy(policy: BrowserUsePolicyConfig): void {
  currentPolicy = BrowserUsePolicyConfigSchema.parse(policy);
}

export function getBrowserUsePolicy(): BrowserUsePolicyConfig {
  return currentPolicy;
}

export function resetBrowserUsePolicyForTests(): void {
  currentPolicy = DEFAULT_BROWSER_USE_POLICY;
}

export function collectBrowserUsePolicyWarnings(input: {
  readonly browserSecurity: BrowserSecurityConfig;
  readonly toolPolicy?: BrowserUsePolicyConfig;
}): BrowserUsePolicyWarning[] {
  const policy = input.toolPolicy ?? currentPolicy;
  const warnings: BrowserUsePolicyWarning[] = [];

  for (const toolName of Object.keys(policy.tools)) {
    if (!SUPPORTED_TOOL_POLICY_TOOL_SET.has(toolName)) {
      warnings.push({
        code: "unknown_tool_policy",
        message: `BROWSER_USE_POLICY_JSON 配置了未接入 tool-level policy 的工具: ${toolName}`,
      });
    }
  }

  if (
    input.browserSecurity.actionPolicy === "confirm" &&
    Object.values(policy.tools).some((entry) => entry.policy === "confirm")
  ) {
    warnings.push({
      code: "double_confirmation",
      message:
        "BROWSER_SECURITY_JSON.actionPolicy=confirm 与 tool policy confirm 同时启用，可能导致双重确认。",
    });
  }

  if (
    input.browserSecurity.actionPolicy === "confirm" ||
    input.browserSecurity.actionPolicy === "deny"
  ) {
    warnings.push({
      code: "browser_action_policy_not_recommended",
      message:
        "BROWSER_SECURITY_JSON.actionPolicy=confirm/deny 是高级调试模式，Boss 日常编排建议使用 actionPolicy=log。",
    });
  }

  return warnings;
}

export function assertBrowserUseToolAllowed(
  ctx: AgentContext,
  input: {
    readonly subject: ToolActionApprovalSubject;
    readonly approval?: ToolActionApproval;
    readonly deferApprovalConsumption?: boolean;
  },
): { readonly consumeApproval: () => void } {
  const entry = currentPolicy.tools[input.subject.tool];
  const policy = entry?.policy ?? "log";

  if (policy === "log") {
    ctx.logger.info(`Browser-use tool allowed by tool policy: ${input.subject.tool}`);
    return { consumeApproval: () => {} };
  }

  if (policy === "deny") {
    const message = "Tool execution denied by browser-use tool policy.";
    ctx.logger.warn(
      `${message} ${JSON.stringify(toToolPolicyDetails(input.subject, "tool_policy_deny"))}`,
    );
    throw new StructuredToolError({
      code: "action_denied",
      message,
      details: toToolPolicyDetails(input.subject, "tool_policy_deny"),
    });
  }

  if (
    input.approval !== undefined &&
    (input.deferApprovalConsumption === true
      ? isToolActionApprovalValid({ approval: input.approval, subject: input.subject })
      : approveToolAction({ approval: input.approval, subject: input.subject }))
  ) {
    ctx.logger.info(`Browser-use tool approved by toolActionApproval: ${input.subject.tool}`);
    return {
      consumeApproval: () => {
        if (input.deferApprovalConsumption === true && input.approval !== undefined) {
          approveToolAction({ approval: input.approval, subject: input.subject });
        }
      },
    };
  }

  const message = "Tool execution requires confirmation by browser-use tool policy.";
  const details = {
    ...toToolPolicyDetails(input.subject, "tool_policy_confirm"),
    approvalRequest: createToolActionApprovalRequest(input.subject, currentPolicy.approvalTtlMs),
  };
  ctx.logger.warn(
    `${message} ${JSON.stringify(toToolPolicyDetails(input.subject, "tool_policy_confirm"))}`,
  );
  throw new StructuredToolError({
    code: "needs_confirmation",
    message,
    details,
  });
}

function toToolPolicyDetails(
  subject: ToolActionApprovalSubject,
  reason: "tool_policy_confirm" | "tool_policy_deny",
): Record<string, unknown> {
  return {
    reason,
    tool: subject.tool,
    target: subject.target,
    ...(subject.summary !== undefined ? { summary: subject.summary } : {}),
  };
}
