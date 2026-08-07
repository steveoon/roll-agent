import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function canonicalizeCompanionWorkspace(input: string): Promise<string> {
  if (!isAbsolute(input)) {
    throw new Error("Companion workspace must be an absolute path");
  }
  const canonical = await realpath(input);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new Error("Companion workspace must be an existing directory");
  }
  return canonical;
}
