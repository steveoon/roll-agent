/**
 * Static secret classification shared by config serialization and the UI catalog.
 * Dynamic Agent env fields are layered on top by ConfigApplicationService.
 */
export function isRollConfigSecretPath(path: readonly (string | number)[]): boolean {
  return (
    (path.length === 4 && path[0] === "llm" && path[1] === "providers" && path[3] === "apiKey") ||
    (path.length === 4 && path[0] === "browser" && path[1] === "instances" && path[3] === "cdpUrl")
  );
}

/**
 * Classify unknown/future configuration names conservatively without substring matching.
 *
 * Only terminal words are considered so operational fields such as `tokenBudget`,
 * `maxOutputTokens`, `secretRotation`, and `passwordPolicy` remain ordinary values.
 */
export function hasSecretTerminalName(path: readonly (string | number)[]): boolean {
  const terminal = path.at(-1);
  if (typeof terminal !== "string") return false;

  const words = splitConfigName(terminal);
  const last = words.at(-1);
  const previous = words.at(-2);
  if (last === "token" || last === "secret" || last === "password" || last === "webhook") {
    return true;
  }
  if (last === "key" && (previous === "api" || previous === "private")) {
    return true;
  }
  return last === "url" && previous === "webhook";
}

/**
 * Detect credentials embedded in an URL value. The check is intentionally value-aware:
 * an ordinary endpoint stays visible, while user-info and credential query/fragment
 * parameters cause the whole value to be protected by the keep-existing sentinel.
 */
export function isCredentialBearingUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;

  // Preserve fail-closed behavior for malformed URLs that still clearly contain user-info.
  if (/^[a-z][a-z\d+.-]*:\/\/[^/?#\s]+@/iu.test(value)) return true;

  try {
    const parsed = new URL(value);
    if (parsed.username.length > 0 || parsed.password.length > 0) return true;
    if (hasCredentialParameter(parsed.searchParams)) return true;
    return hasCredentialParameter(new URLSearchParams(stripFragmentPrefix(parsed.hash)));
  } catch {
    if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) return false;
    return (
      hasCredentialParameter(readRawParameters(value, "?")) ||
      hasCredentialParameter(readRawParameters(value, "#"))
    );
  }
}

/** Combine exact declarations, the terminal-name fallback, and URL-value inspection. */
export function isSecretConfigValue(
  path: readonly (string | number)[],
  value: unknown,
  isExactSecretPath: (path: readonly (string | number)[]) => boolean = isRollConfigSecretPath,
): boolean {
  return (
    isExactSecretPath(path) ||
    (!isAgentEnvValuePath(path) && hasSecretTerminalName(path)) ||
    isCredentialBearingUrl(value)
  );
}

function isAgentEnvValuePath(path: readonly (string | number)[]): boolean {
  return path.length >= 4 && path[0] === "agents" && path[1] === "env";
}

function splitConfigName(name: string): readonly string[] {
  return name
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z\d]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function hasCredentialParameter(parameters: URLSearchParams): boolean {
  for (const name of parameters.keys()) {
    const words = splitConfigName(name);
    const last = words.at(-1);
    const previous = words.at(-2);
    if (
      last === "token" ||
      last === "secret" ||
      last === "password" ||
      last === "credential" ||
      last === "signature" ||
      last === "sig" ||
      last === "auth" ||
      last === "apikey" ||
      last === "privatekey" ||
      (last === "key" && (previous === "api" || previous === "private"))
    ) {
      return true;
    }
  }
  return false;
}

function stripFragmentPrefix(fragment: string): string {
  return fragment.startsWith("#") ? fragment.slice(1) : fragment;
}

function readRawParameters(value: string, marker: "?" | "#"): URLSearchParams {
  const start = value.indexOf(marker);
  if (start === -1) return new URLSearchParams();
  const raw = value.slice(start + 1).split(marker === "?" ? "#" : "?", 1)[0] ?? "";
  return new URLSearchParams(raw);
}
