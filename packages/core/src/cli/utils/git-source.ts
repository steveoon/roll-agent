import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isGitUrl(input: string): boolean {
  return (
    input.startsWith("https://") ||
    input.startsWith("http://") ||
    input.startsWith("git@") ||
    input.endsWith(".git")
  );
}

export function repoNameFromUrl(url: string): string {
  const last = url.split("/").pop() ?? url;
  return last.replace(/\.git$/, "");
}

export const CLONE_OR_PULL_ACTIONS = ["cloned", "pulled"] as const;
export type CloneOrPullAction = (typeof CLONE_OR_PULL_ACTIONS)[number];

export async function cloneOrPullRepo(
  url: string,
  cloneTarget: string,
): Promise<{ readonly action: CloneOrPullAction }> {
  if (existsSync(cloneTarget)) {
    await execFileAsync("git", ["pull"], { cwd: cloneTarget });
    return { action: "pulled" };
  }

  const parentDir = dirname(cloneTarget);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
  await execFileAsync("git", ["clone", url, cloneTarget]);
  return { action: "cloned" };
}
