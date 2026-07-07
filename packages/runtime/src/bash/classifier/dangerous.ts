import { executableLookupKey } from "./lookup-key.ts";

const RM_DANGEROUS_FLAGS: ReadonlySet<string> = new Set(["-f", "-rf"]);

export function isDangerous(argv: readonly string[], platform: NodeJS.Platform): boolean {
  const argv0 = argv[0];
  if (argv0 === undefined) {
    return false;
  }
  const key = executableLookupKey(argv0, platform);
  if (key === "rm") {
    const flag = argv[1];
    return flag !== undefined && RM_DANGEROUS_FLAGS.has(flag);
  }
  if (key === "sudo") {
    return isDangerous(argv.slice(1), platform);
  }
  return false;
}
