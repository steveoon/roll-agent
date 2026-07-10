import { isAbsolute, relative } from "node:path";

export function isWithinWorkdirRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
