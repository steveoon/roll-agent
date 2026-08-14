import type { ToolBridgeContext } from "../build-tools.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import { FILE_TOOLS_AGENT_NAME } from "./settings.ts";

const EXTERNAL_PATH_APPROVAL_REASON = "读取工作目录以外的文件";

export async function gateExternalPath(
  ctx: ToolBridgeContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<NormalizedToolResult | undefined> {
  const memoryKey = `${toolName}:external`;
  if (ctx.approvalMemory?.isGranted(memoryKey)) {
    return undefined;
  }
  const approval = await ctx.requestApproval({
    agentName: FILE_TOOLS_AGENT_NAME,
    toolName,
    input,
    reason: EXTERNAL_PATH_APPROVAL_REASON,
  });
  if (!approval.approved) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.userRejected,
      `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`,
      approval.reason ? { reason: approval.reason } : {},
    );
  }
  if (approval.scope === "session") {
    ctx.approvalMemory?.grant(memoryKey);
  }
  return undefined;
}
