import type { FileChangeDiff, FileChangeKind } from "@roll-agent/protocol";
import { successfulToolResult, type NormalizedToolResult } from "../normalize-result.ts";
import { formatPathForApproval } from "./file-io.ts";
import { buildFileChangeDiff } from "./text-diff.ts";

export interface DescribeFileChangeInput {
  readonly workdir: string;
  readonly inputPath: string;
  readonly change: FileChangeKind;
  readonly before: string;
  readonly after: string;
}

export function describeFileChange(input: DescribeFileChangeInput): FileChangeDiff | undefined {
  try {
    return buildFileChangeDiff({
      path: formatPathForApproval(input.workdir, input.inputPath),
      change: input.change,
      before: input.before,
      after: input.after,
    });
  } catch {
    return undefined;
  }
}

export function fileChangeToolResult(
  text: string,
  diff: FileChangeDiff | undefined,
): NormalizedToolResult {
  if (diff === undefined) {
    return successfulToolResult(text);
  }
  return successfulToolResult({ text, diff }, { model: { type: "text", value: text } });
}
