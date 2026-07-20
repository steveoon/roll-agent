import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

function isContainedPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function isWithinWorkdirRoot(root: string, target: string): boolean {
  if (!isContainedPath(root, target)) {
    return false;
  }
  try {
    return isContainedPath(realpathSync(root), realpathSync(target));
  } catch {
    // An unresolved workdir can be replaced by an escaping symlink between
    // admission and execution, so it cannot earn known-safe auto approval.
    return false;
  }
}
