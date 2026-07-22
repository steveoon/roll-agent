export const CLEAN_EXEC_ENV = {
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
  LANG: "C.UTF-8",
} as const;

const AUTO_APPROVED_POSIX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL_STARTUP_ENV_KEYS: ReadonlySet<string> = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "GREP_OPTIONS",
  "IFS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "PROMPT_COMMAND",
  "PS4",
  "RIPGREP_CONFIG_PATH",
  "SHELLOPTS",
  "ZDOTDIR",
]);

export function withCleanEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...CLEAN_EXEC_ENV };
}

/** Environment used only after a command has earned known-safe auto approval. */
export function withAutoApprovedShellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = withCleanEnv(base);
  for (const key of Object.keys(result)) {
    if (
      SHELL_STARTUP_ENV_KEYS.has(key) ||
      key.startsWith("BASH_FUNC_") ||
      key.startsWith("DYLD_")
    ) {
      delete result[key];
    }
  }
  result.PATH = AUTO_APPROVED_POSIX_PATH;
  result.SHELL = "/bin/sh";
  return result;
}
