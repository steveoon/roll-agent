export const CLEAN_EXEC_ENV = {
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
  LANG: "C.UTF-8",
} as const;

export function withCleanEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...CLEAN_EXEC_ENV };
}
