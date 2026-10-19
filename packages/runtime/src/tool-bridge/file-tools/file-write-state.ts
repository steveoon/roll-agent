import { z } from "zod/v4";
import { fileChangeDiffSchema } from "@roll-agent/protocol";
import type { ToolBridgeContext } from "../build-tools.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import { captureFilePathAdmission, type FilePathAdmission } from "./file-io.ts";
import { FILE_TOOLS_AGENT_NAME } from "./settings.ts";

const fileWriteApprovalSchema = z
  .object({
    /** null = the approved target did not exist. */
    baselineDigest: z.string().nullable(),
    /** Bounded display snapshot; never used to authorize the write. */
    diff: fileChangeDiffSchema,
  })
  .readonly();

export type FileWriteApproval = z.infer<typeof fileWriteApprovalSchema>;

export interface FileWriteExecutionState extends FilePathAdmission {
  approval: FileWriteApproval | undefined;
}

export function captureFileWriteState(workdir: string, inputPath: string): FileWriteExecutionState {
  return { ...captureFilePathAdmission(workdir, inputPath), approval: undefined };
}

export function isFileWriteExecutionState(value: unknown): value is FileWriteExecutionState {
  return (
    typeof value === "object" &&
    value !== null &&
    "admittedExternal" in value &&
    typeof value.admittedExternal === "boolean" &&
    "admittedTarget" in value &&
    (value.admittedTarget === undefined || typeof value.admittedTarget === "string") &&
    "approval" in value &&
    (value.approval === undefined || fileWriteApprovalSchema.safeParse(value.approval).success)
  );
}

export function requireFileWriteApproval(value: unknown): FileWriteApproval {
  if (!isFileWriteExecutionState(value) || value.approval === undefined) {
    throw new Error("文件审批状态缺失，请重新提交");
  }
  return value.approval;
}

export function fileWriteVersionGuard(
  path: string,
  expected: string | null | undefined,
  actual: string | null,
): NormalizedToolResult | undefined {
  return expected !== undefined && expected !== actual
    ? failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${path} 已被修改，文件版本与审批时预览的不一致，已阻止写入。请重新 roll__read_file 获取最新内容并重新提交；同一文件多处修改请合并到一次 edit_file 的 edits 中。`,
      )
    : undefined;
}

/** Denied tools must not read file content while preparing an approval preview. */
export function fileWritePolicyGuard(
  ctx: ToolBridgeContext,
  toolName: string,
  input: Record<string, unknown>,
): NormalizedToolResult | undefined {
  const decision = ctx.policy?.check({
    agentName: FILE_TOOLS_AGENT_NAME,
    toolName,
    input,
    annotations: {},
  });
  return decision?.action === "deny"
    ? failedToolResult(
        TOOL_OUTCOME_KINDS.policyDenied,
        `策略拒绝执行${decision.reason ? `: ${decision.reason}` : ""}`,
        decision.reason ? { reason: decision.reason } : {},
      )
    : undefined;
}
