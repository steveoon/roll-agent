import type { FileChangeDiff, FileChangeKind } from "@roll-agent/protocol";
import { successfulToolResult, type NormalizedToolResult } from "../normalize-result.ts";
import { formatPathForApproval } from "./file-io.ts";
import {
  buildFileChangeDiff,
  buildFileChangePreview,
  type FileChangePreview,
} from "./text-diff.ts";

export interface DescribeFileChangeInput {
  readonly workdir: string;
  readonly inputPath: string;
  readonly change: FileChangeKind;
  readonly before: string;
  readonly after: string;
}

export function describeFileChangePreview(input: DescribeFileChangeInput): FileChangePreview {
  return buildFileChangePreview({
    ...input,
    path: formatPathForApproval(input.workdir, input.inputPath),
  });
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
  const plain = successfulToolResult(text);
  if (diff === undefined) {
    return plain;
  }
  return successfulToolResult({ text, diff }, { model: plain.model });
}
