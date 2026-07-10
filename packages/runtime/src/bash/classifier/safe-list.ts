const UNIVERSAL_SAFE_COMMANDS = [
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
] as const;

const LINUX_ONLY_SAFE_COMMANDS = ["numfmt", "tac"] as const;

const UNIVERSAL_SET: ReadonlySet<string> = new Set(UNIVERSAL_SAFE_COMMANDS);
const LINUX_SET: ReadonlySet<string> = new Set(LINUX_ONLY_SAFE_COMMANDS);

export function isSafeExecutable(key: string, platform: NodeJS.Platform): boolean {
  if (UNIVERSAL_SET.has(key)) {
    return true;
  }
  return platform === "linux" && LINUX_SET.has(key);
}
