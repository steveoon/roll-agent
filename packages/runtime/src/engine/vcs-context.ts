import { execFile } from "node:child_process";
import type { CapabilityVcsSnapshot } from "./capability-manifest.ts";

const DEFAULT_VCS_TIMEOUT_MS = 500;
const MAX_VCS_OUTPUT_BYTES = 256 * 1024;

function branchFromHeader(header: string): string | undefined {
  const value = header.replace(/^##\s*/u, "").trim();
  const unborn = /^(?:No commits yet on|Initial commit on)\s+(.+?)(?:\s+\[|$)/u.exec(value)?.[1];
  if (unborn !== undefined) {
    return unborn;
  }
  if (value.startsWith("HEAD ") || value === "HEAD" || value.startsWith("(no branch)")) {
    return undefined;
  }
  return value.split("...", 1)[0]?.split(/\s+\[/u, 1)[0]?.trim() || undefined;
}

export function parseGitStatusSnapshot(output: string): CapabilityVcsSnapshot | undefined {
  const lines = output
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
  const header = lines[0];
  if (header === undefined) {
    return undefined;
  }
  const hasBranchHeader = header.startsWith("##");
  const relation = hasBranchHeader ? header : "";
  const branch = hasBranchHeader ? branchFromHeader(header) : undefined;
  const aheadText = /\bahead\s+(\d+)/u.exec(relation)?.[1];
  const behindText = /\bbehind\s+(\d+)/u.exec(relation)?.[1];
  return {
    ...(branch !== undefined ? { branch } : {}),
    dirty: hasBranchHeader ? lines.length > 1 : lines.length > 0,
    ...(aheadText !== undefined ? { ahead: Number(aheadText) } : {}),
    ...(behindText !== undefined ? { behind: Number(behindText) } : {}),
  };
}

export async function inspectGitVcsContext(
  cwd: string,
  timeoutMs = DEFAULT_VCS_TIMEOUT_MS,
): Promise<CapabilityVcsSnapshot | undefined> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["-C", cwd, "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
        {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: MAX_VCS_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, value) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(value);
        },
      );
    });
    return parseGitStatusSnapshot(stdout);
  } catch {
    return undefined;
  }
}
