import { z } from "zod";
import { preflightToolCall } from "@roll-agent/core/tool-runtime/preflight";
import type { AgentTool } from "@roll-agent/core/types/agent";
import type { ApprovalDecision } from "../approval/approval-gate.ts";
import type { ToolAnnotations } from "../types/policy.ts";
import type { ToolBridgeContext } from "./build-tools.ts";
import {
  createToolResult,
  failedToolResult,
  normalizeToolResult,
  TOOL_OUTCOME_KINDS,
  type NormalizedToolResult,
} from "./normalize-result.ts";

const credentialSchema = z.object({ id: z.string().min(1).max(256) }).strict();
const challengeSchema = z.object({
  code: z.literal("needs_confirmation"),
  details: z.object({
    executionState: z.literal("not_executed"),
    approvalRequest: z.object({
      id: z.string().min(1).max(256),
      tool: z.string().min(1).max(256),
      expiresAt: z.string().datetime(),
      summary: z.string().max(2000).optional(),
      retryInput: z.union([
        z.object({ scriptApproval: credentialSchema }).strict(),
        z.object({ toolActionApproval: credentialSchema }).strict(),
      ]),
    }),
  }),
});

function readChallenge(result: unknown, toolName: string) {
  const envelope = z
    .object({
      isError: z.literal(true),
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string().max(65536) }))
        .length(1),
    })
    .safeParse(result);
  if (!envelope.success) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(envelope.data.content[0]!.text);
  } catch {
    return undefined;
  }
  const parsed = challengeSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const request = parsed.data.details.approvalRequest;
  const credential =
    "scriptApproval" in request.retryInput
      ? request.retryInput.scriptApproval
      : request.retryInput.toolActionApproval;
  if (
    request.tool !== toolName ||
    credential.id !== request.id ||
    Date.parse(request.expiresAt) <= Date.now()
  ) {
    return undefined;
  }
  return request;
}

function cancelled(): NormalizedToolResult {
  return createToolResult(
    { kind: TOOL_OUTCOME_KINDS.cancelled, executionState: "not_executed" },
    "已取消审批；工具未执行操作",
  );
}

async function awaitDecision(
  decision: Promise<ApprovalDecision>,
  signal: AbortSignal | undefined,
): Promise<ApprovalDecision | undefined> {
  if (signal === undefined) return decision;
  if (signal.aborted) return undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<undefined>((resolve) => {
    abort = () => resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([decision, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Only a producer's explicit pre-effect challenge can continue, once, after real user approval. */
export async function executeWithToolApproval(options: {
  input: Record<string, unknown>;
  agentName: string;
  agentTool: AgentTool;
  annotations: ToolAnnotations | undefined;
  ctx: ToolBridgeContext;
  signal: AbortSignal | undefined;
  call: (input: Record<string, unknown>) => Promise<unknown>;
}): Promise<NormalizedToolResult> {
  if (options.signal?.aborted) return cancelled();
  const original = structuredClone(options.input);
  const first = await options.call(structuredClone(original));
  const request = readChallenge(first, options.agentTool.name);
  if (request === undefined) return normalizeToolResult(first);
  if (options.signal?.aborted) return cancelled();
  const retry = { ...structuredClone(original), ...request.retryInput };
  // Returned credentials cannot alter business arguments or add fields outside the tool contract.
  if (!preflightToolCall(options.agentTool, retry).ok) return normalizeToolResult(first);
  const preview = structuredClone(original);
  delete preview["scriptApproval"];
  delete preview["toolActionApproval"];
  const approval = await awaitDecision(
    options.ctx.requestApproval({
      agentName: options.agentName,
      toolName: options.agentTool.name,
      input: preview,
      reason: "tool_requested_confirmation",
      explanation:
        request.summary ?? "工具尚未执行操作；仅批准本次完整参数，不自动重放已执行步骤。",
    }),
    options.signal,
  );
  if (options.signal?.aborted || approval === undefined) return cancelled();
  if (!approval.approved) {
    return failedToolResult(TOOL_OUTCOME_KINDS.userRejected, "用户拒绝本次操作；工具未执行操作");
  }
  if (Date.parse(request.expiresAt) <= Date.now()) return normalizeToolResult(first);
  const policy = options.ctx.policy?.check({
    agentName: options.agentName,
    toolName: options.agentTool.name,
    input: structuredClone(retry),
    ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
  });
  if (policy?.action === "deny") {
    return failedToolResult(TOOL_OUTCOME_KINDS.policyDenied, "审批期间策略已改变，未执行操作");
  }
  if (options.signal?.aborted) return cancelled();
  // No loop: a fresh challenge, partial failure or transport error cannot trigger another call.
  return normalizeToolResult(await options.call(retry));
}
