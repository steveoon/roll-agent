import type { AuditVerdict } from "./types.ts";

/**
 * Git is intentionally never auto-approved.
 *
 * Even read-looking subcommands can execute helpers configured through the
 * repository, user config, attributes, or inherited environment. The shell
 * policy must therefore ask for confirmation instead of treating argv alone
 * as proof that a Git invocation is side-effect free.
 */
export function auditGit(_argv: readonly string[], _workdir: string): AuditVerdict {
  return "reject";
}
