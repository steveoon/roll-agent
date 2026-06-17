import type { PolicyDecision, ToolPolicy, ToolPolicyContext } from "../types/policy.ts";

const WRITE_VERBS = [
  "send",
  "write",
  "delete",
  "remove",
  "update",
  "create",
  "post",
  "submit",
  "reply",
  "pay",
  "insert",
  "drop",
  "set",
  "put",
  "patch",
  "add",
  "edit",
  "open",
  "select",
  "filter",
  "exchange",
  "cancel",
  "approve",
  "click",
  "navigate",
  "fill",
  "type",
  "press",
  "upload",
  "scroll",
] as const;

const READ_VERBS = [
  "get",
  "list",
  "read",
  "search",
  "fetch",
  "query",
  "find",
  "show",
  "describe",
  "inspect",
  "status",
  "check",
  "count",
  "view",
  "load",
  "scan",
  "resolve",
  "validate",
  "format",
  "preview",
  "diagnostic",
  "snapshot",
] as const;

const WRITE_VERB_SET = new Set<string>(WRITE_VERBS);
const READ_VERB_SET = new Set<string>(READ_VERBS);

function toolNameTokens(toolName: string): string[] {
  return toolName
    .toLowerCase()
    .split(/[_\-\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function hasToken(tokens: readonly string[], tokenSet: ReadonlySet<string>): boolean {
  return tokens.some((token) => tokenSet.has(token));
}

export class DefaultToolPolicy implements ToolPolicy {
  check(context: ToolPolicyContext): PolicyDecision {
    const { annotations } = context;
    const tokens = toolNameTokens(context.toolName);

    if (annotations?.destructiveHint === true) {
      return { action: "confirm", reason: "破坏性操作" };
    }

    if (hasToken(tokens, WRITE_VERB_SET)) {
      return { action: "confirm", reason: "写/发送类操作" };
    }

    if (annotations?.readOnlyHint === true || hasToken(tokens, READ_VERB_SET)) {
      return { action: "allow" };
    }

    return { action: "confirm", reason: "未知操作，默认需确认" };
  }
}
