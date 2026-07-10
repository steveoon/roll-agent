export interface ShellResolutionDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fileExists: (path: string) => boolean;
}

const FALLBACK_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"] as const;
const ULTIMATE_FALLBACK_SHELL = "/bin/sh";

export function resolveUserShell(deps: ShellResolutionDeps): string {
  const configured = deps.env["SHELL"];
  if (configured !== undefined && configured.length > 0 && deps.fileExists(configured)) {
    return configured;
  }
  for (const candidate of FALLBACK_SHELLS) {
    if (deps.fileExists(candidate)) {
      return candidate;
    }
  }
  return ULTIMATE_FALLBACK_SHELL;
}
