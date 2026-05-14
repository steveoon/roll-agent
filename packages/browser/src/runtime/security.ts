import type {
  BrowserActionApproval,
  BrowserActionPolicy,
  BrowserSecurityConfig,
} from "../types/index.ts";

export type BrowserSecurityFailureCode = "action_denied" | "needs_confirmation";

export type BrowserSecurityErrorPayload = {
  readonly code: BrowserSecurityFailureCode;
  readonly message: string;
  readonly details: BrowserActionPreflightDetails;
};

export type BrowserActionPreflightInput = {
  readonly security: BrowserSecurityConfig;
  readonly action: string;
  readonly target: string;
  readonly url?: string;
};

export type BrowserActionPreflightDetails = {
  readonly action: string;
  readonly target: string;
  readonly reason: string;
  readonly policy?: BrowserActionPolicy;
  readonly url?: string;
  readonly domainAllowlist?: readonly string[];
};

export type BrowserActionPreflightResult =
  | {
      readonly ok: true;
      readonly log: boolean;
      readonly message: string;
      readonly details: BrowserActionPreflightDetails;
    }
  | {
      readonly ok: false;
      readonly code: BrowserSecurityFailureCode;
      readonly message: string;
      readonly details: BrowserActionPreflightDetails;
    };

export type TextTruncationResult = {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly returnedBytes: number;
};

export type BrowserActionLogHandler = (
  message: string,
  details: BrowserActionPreflightDetails,
) => void;

export type BrowserActionApprovalValidationInput = {
  readonly approval: BrowserActionApproval;
  readonly details: BrowserActionPreflightDetails;
};

export type BrowserActionApprovalValidator = (
  input: BrowserActionApprovalValidationInput,
) => boolean;

export type BrowserActionPolicyOptions = {
  readonly security?: BrowserSecurityConfig;
  readonly onActionLog?: BrowserActionLogHandler;
  readonly approval?: BrowserActionApproval;
  readonly approveAction?: BrowserActionApprovalValidator;
};

export class BrowserActionPolicyError extends Error {
  readonly payload: BrowserSecurityErrorPayload;

  constructor(payload: BrowserSecurityErrorPayload) {
    super(payload.message);
    this.name = "BrowserActionPolicyError";
    this.payload = payload;
  }
}

export function isBrowserActionPolicyError(value: unknown): value is BrowserActionPolicyError {
  return value instanceof BrowserActionPolicyError;
}

export function isUrlAllowedByDomainAllowlist(
  url: string,
  domainAllowlist: readonly string[],
): boolean {
  if (domainAllowlist.length === 0) {
    return true;
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (hostname.length === 0) {
    return false;
  }

  return domainAllowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function preflightBrowserAction(
  input: BrowserActionPreflightInput,
): BrowserActionPreflightResult {
  const url = input.url;
  if (url !== undefined && !isUrlAllowedByDomainAllowlist(url, input.security.domainAllowlist)) {
    return {
      ok: false,
      code: "action_denied",
      message: "Browser navigation target is outside domainAllowlist.",
      details: {
        action: input.action,
        target: input.target,
        reason: "domain_not_allowed",
        url,
        domainAllowlist: input.security.domainAllowlist,
      },
    };
  }

  switch (input.security.actionPolicy) {
    case "log":
      return {
        ok: true,
        log: true,
        message: `Browser action allowed by actionPolicy=log: ${input.action} ${input.target}`,
        details: {
          action: input.action,
          target: input.target,
          reason: "action_policy_log",
          policy: input.security.actionPolicy,
          ...(url !== undefined ? { url } : {}),
        },
      };
    case "deny":
      return {
        ok: false,
        code: "action_denied",
        message: "Browser action denied by actionPolicy.",
        details: {
          action: input.action,
          target: input.target,
          reason: "action_policy_deny",
          policy: input.security.actionPolicy,
          ...(url !== undefined ? { url } : {}),
        },
      };
    case "confirm":
      return {
        ok: false,
        code: "needs_confirmation",
        message: "Browser action requires confirmation by actionPolicy.",
        details: {
          action: input.action,
          target: input.target,
          reason: "action_policy_confirm",
          policy: input.security.actionPolicy,
          ...(url !== undefined ? { url } : {}),
        },
      };
  }
}

export function assertBrowserActionPreflight(
  input: Omit<BrowserActionPreflightInput, "security"> & BrowserActionPolicyOptions,
): void {
  const security = input.security;
  if (security === undefined) {
    return;
  }

  const decision = preflightBrowserAction({
    security,
    action: input.action,
    target: input.target,
    ...(input.url !== undefined ? { url: input.url } : {}),
  });

  if (decision.ok) {
    if (decision.log) {
      input.onActionLog?.(decision.message, decision.details);
    }
    return;
  }

  if (
    decision.code === "needs_confirmation" &&
    input.approval !== undefined &&
    input.approveAction?.({ approval: input.approval, details: decision.details }) === true
  ) {
    input.onActionLog?.(
      `Browser action approved by browserActionApproval: ${input.action} ${input.target}`,
      {
        ...decision.details,
        reason: "action_policy_confirm_approved",
      },
    );
    return;
  }

  throw new BrowserActionPolicyError({
    code: decision.code,
    message: decision.message,
    details: decision.details,
  });
}

export function truncateTextToUtf8Bytes(text: string, maxBytes: number): TextTruncationResult {
  const encoder = new TextEncoder();
  const originalBytes = encoder.encode(text);

  if (originalBytes.length <= maxBytes) {
    return {
      text,
      truncated: false,
      originalBytes: originalBytes.length,
      returnedBytes: originalBytes.length,
    };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    try {
      const truncatedText = decoder.decode(originalBytes.slice(0, end));
      return {
        text: truncatedText,
        truncated: true,
        originalBytes: originalBytes.length,
        returnedBytes: encoder.encode(truncatedText).length,
      };
    } catch {
      end -= 1;
    }
  }

  return {
    text: "",
    truncated: true,
    originalBytes: originalBytes.length,
    returnedBytes: 0,
  };
}
