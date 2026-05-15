import { StructuredToolError } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import {
  isBrowserActionPolicyError,
  preflightBrowserAction,
  type BrowserActionApproval,
  type BrowserActionPolicyOptions,
  type BrowserRuntime,
  type BrowserSecurityConfig,
} from "@roll-agent/browser";
import {
  approveBrowserAction,
  createBrowserActionApprovalRequest,
} from "./browser-action-approval.ts";

export type BrowserActionGuardResult = {
  readonly approvedByConfirmation: boolean;
};

type BrowserActionPolicyOptionsInput = {
  readonly approval?: BrowserActionApproval | undefined;
  readonly approvedByConfirmation?: boolean;
  readonly logActions?: boolean;
};

function resolveSecurityForBrowserActionPolicyOptions(
  runtime: BrowserRuntime,
  input: BrowserActionPolicyOptionsInput,
): BrowserSecurityConfig {
  const security = runtime.getConfig().security;
  if (input.approvedByConfirmation === true && security.actionPolicy === "confirm") {
    return {
      ...security,
      actionPolicy: "log",
    };
  }
  return security;
}

export function createBrowserActionPolicyOptions(
  ctx: AgentContext,
  runtime: BrowserRuntime,
  input: BrowserActionPolicyOptionsInput = {},
): BrowserActionPolicyOptions {
  const security = resolveSecurityForBrowserActionPolicyOptions(runtime, input);
  return {
    security,
    approveAction: approveBrowserAction,
    ...(input.approval !== undefined ? { approval: input.approval } : {}),
    ...(input.logActions === false
      ? {}
      : {
          onActionLog: (message) => {
            ctx.logger.info(message);
          },
        }),
  };
}

export function assertBrowserActionAllowed(
  ctx: AgentContext,
  runtime: BrowserRuntime,
  input: {
    readonly action: string;
    readonly target: string;
    readonly url?: string;
    readonly approval?: BrowserActionApproval;
  },
): BrowserActionGuardResult {
  const decision = preflightBrowserAction({
    security: runtime.getConfig().security,
    action: input.action,
    target: input.target,
    ...(input.url !== undefined ? { url: input.url } : {}),
  });

  if (decision.ok) {
    if (decision.log) {
      ctx.logger.info(decision.message);
    }
    return { approvedByConfirmation: false };
  }

  if (
    decision.code === "needs_confirmation" &&
    input.approval !== undefined &&
    approveBrowserAction({ approval: input.approval, details: decision.details })
  ) {
    ctx.logger.info(
      `Browser action approved by browserActionApproval: ${input.action} ${input.target}`,
    );
    return { approvedByConfirmation: true };
  }

  ctx.logger.warn(`${decision.message} ${JSON.stringify(decision.details)}`);
  throw new StructuredToolError({
    code: decision.code,
    message: decision.message,
    details: {
      ...decision.details,
      ...(decision.code === "needs_confirmation"
        ? { approvalRequest: createBrowserActionApprovalRequest(decision.details) }
        : {}),
    },
  });
}

export function toStructuredBrowserActionError(error: unknown): StructuredToolError | undefined {
  if (!isBrowserActionPolicyError(error)) {
    return undefined;
  }

  return new StructuredToolError({
    code: error.payload.code,
    message: error.payload.message,
    details: {
      ...error.payload.details,
      ...(error.payload.code === "needs_confirmation"
        ? { approvalRequest: createBrowserActionApprovalRequest(error.payload.details) }
        : {}),
    },
  });
}
