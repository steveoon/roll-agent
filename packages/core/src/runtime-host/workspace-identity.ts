import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Keep worktrees distinct while treating subdirectories and symlink aliases as one workspace. */
export function resolveChatWorkspace(cwd: string = process.cwd()): string {
  const canonical = realpathSync(resolve(cwd));
  if (!statSync(canonical).isDirectory()) {
    throw new Error("Chat workspace must be an existing directory");
  }
  let directory = canonical;
  while (true) {
    const marker = statSync(join(directory, ".git"), { throwIfNoEntry: false });
    if (marker?.isFile() || marker?.isDirectory()) return directory;
    const parent = dirname(directory);
    if (parent === directory) return canonical;
    directory = parent;
  }
}
