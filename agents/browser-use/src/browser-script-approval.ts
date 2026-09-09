import { createHash } from "node:crypto";
import { StructuredToolError } from "@roll-agent/sdk";
import type { BrowserExecuteInput, BrowserSecurityConfig } from "@roll-agent/browser";
import { isUrlAllowedByDomainAllowlist } from "@roll-agent/browser";
import { canonicalJson } from "./workflows/parameters.ts";
import { approveToolAction, createToolActionApprovalRequest } from "./tool-action-approval.ts";

export function browserExecutionDigest(
  input: BrowserExecuteInput,
  binding: { browserInstance: string; documentId: string; workflowKey?: string; toolName?: string },
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        source: input.source,
        args: input.args,
        pageId: input.pageId,
        capabilities: [...new Set(input.capabilities)].sort(),
        allowedOrigins: [...new Set(input.allowedOrigins)].sort(),
        preconditions: input.preconditions,
        postconditions: input.postconditions,
        timeoutMs: input.timeoutMs,
        maxCalls: input.maxCalls,
        browserInstance: binding.browserInstance,
        documentId: binding.documentId,
        workflowKey: binding.workflowKey ?? null,
        toolName: binding.toolName ?? "browser_execute",
      }),
    )
    .digest("hex");
}

export function assertScriptDomains(
  input: BrowserExecuteInput,
  security: BrowserSecurityConfig,
): void {
  if (
    input.allowedOrigins.some(
      (origin) => !isUrlAllowedByDomainAllowlist(origin, security.domainAllowlist),
    )
  ) {
    throw new StructuredToolError({
      code: "action_denied",
      message: "A declared script origin is outside domainAllowlist",
    });
  }
}

/** Whole-program approval is consumed once before any website side effect. */
export function authorizeBrowserScript(
  input: BrowserExecuteInput,
  binding: { browserInstance: string; documentId: string; workflowKey?: string; toolName?: string },
  security: BrowserSecurityConfig,
): { approved: boolean; executionDigest: string } {
  assertScriptDomains(input, security);
  const executionDigest = browserExecutionDigest(input, binding);
  const hasSideEffects = input.capabilities.some(
    (capability) => capability === "interact" || capability === "navigate",
  );
  if (!hasSideEffects || security.actionPolicy === "log") {
    return { approved: false, executionDigest };
  }
  if (security.actionPolicy === "deny") {
    throw new StructuredToolError({
      code: "action_denied",
      message: "Browser script interactions are denied by actionPolicy",
    });
  }
  const subject = {
    tool: binding.toolName ?? "browser_execute",
    target: `${binding.browserInstance}:${input.pageId}`,
    digest: executionDigest,
    summary: `Execute script ${executionDigest.slice(0, 12)} with ${input.capabilities.join(", ")} on ${input.allowedOrigins.join(", ")}`,
  };
  if (input.scriptApproval && approveToolAction({ approval: input.scriptApproval, subject })) {
    return { approved: true, executionDigest };
  }
  const approval = createToolActionApprovalRequest(subject, 300_000);
  throw new StructuredToolError({
    code: "needs_confirmation",
    message: "Confirm this exact browser script, arguments, page and capabilities before execution",
    details: {
      executionState: "not_executed",
      approvalRequest: {
        ...approval,
        retryInput: { scriptApproval: approval.retryInput.toolActionApproval },
      },
      executionDigest,
      pageId: input.pageId,
      browserInstance: binding.browserInstance,
      capabilities: input.capabilities,
      allowedOrigins: input.allowedOrigins,
    },
  });
}
