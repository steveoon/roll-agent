export const COMPANION_CONFIG_VERSION = 1 as const;

const UNDECIDED_OFFICIAL_RELAY_HOST: string | null = null;

export const OFFICIAL_RELAY_PROFILE = {
  id: "roll-cloud-v1",
  host: UNDECIDED_OFFICIAL_RELAY_HOST,
} as const;

export const OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE =
  "The official Roll Relay endpoint is not decided yet; Companion remote access is unavailable";

/**
 * Development override for the Relay host, as `host` or `host:port`.
 *
 * This exists so a Relay implementation can be validated end to end before the official host is
 * registered. A signed installer must never depend on it: the official endpoint is the compiled-in
 * {@link OFFICIAL_RELAY_PROFILE} host, and `roll companion doctor` reports whenever an override is
 * in effect.
 *
 * Transport security is not overridable. Only a loopback host may be reached over `http`/`ws`;
 * every other host keeps `https`/`wss`, so this variable cannot silently downgrade a remote
 * Companion connection to plaintext.
 */
export const COMPANION_RELAY_HOST_OVERRIDE_ENV = "ROLL_COMPANION_RELAY_HOST" as const;

export interface CompanionRelayEndpoint {
  readonly host: string;
  readonly enrollmentUrl: string;
  readonly companionUrl: string;
  /** True when the host is loopback, which is the only case that permits plaintext transport. */
  readonly loopback: boolean;
  /** True when the host came from {@link COMPANION_RELAY_HOST_OVERRIDE_ENV}. */
  readonly overridden: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "[::1]"]);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname);
}

/**
 * Accepts `host` or `host:port` only.
 *
 * A scheme, path, query or credential in the value is rejected rather than silently dropped: the
 * URL builders below concatenate the host, so a malformed value would otherwise produce a URL that
 * points somewhere unintended.
 */
function normalizeRelayHost(value: string, source: string): string {
  const candidate = value.trim().toLowerCase();
  if (candidate.length === 0) {
    throw new Error(`${source} must not be empty`);
  }

  let url: URL;
  try {
    url = new URL(`https://${candidate}`);
  } catch {
    throw new Error(`${source} must be a host or host:port value`);
  }

  if (url.host !== candidate || url.username !== "" || url.password !== "") {
    throw new Error(`${source} must be a bare host or host:port value`);
  }

  return url.host;
}

function createRelayEndpoint(host: string, overridden: boolean): CompanionRelayEndpoint {
  const hostname = new URL(`https://${host}`).hostname;
  const loopback = isLoopbackHostname(hostname);
  const httpScheme = loopback ? "http" : "https";
  const wsScheme = loopback ? "ws" : "wss";

  return {
    host,
    enrollmentUrl: `${httpScheme}://${host}/v1/device-enrollments/redeem`,
    companionUrl: `${wsScheme}://${host}/v1/companion`,
    loopback,
    overridden,
  };
}

export function resolveCompanionRelayEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): CompanionRelayEndpoint | null {
  const override = env[COMPANION_RELAY_HOST_OVERRIDE_ENV];
  if (override !== undefined && override.trim().length > 0) {
    return createRelayEndpoint(
      normalizeRelayHost(override, COMPANION_RELAY_HOST_OVERRIDE_ENV),
      true,
    );
  }

  const host = OFFICIAL_RELAY_PROFILE.host;
  if (host === null) {
    return null;
  }

  return createRelayEndpoint(normalizeRelayHost(host, "OFFICIAL_RELAY_PROFILE.host"), false);
}

export function isOfficialRelayEndpointDecided(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCompanionRelayEndpoint(env) !== null;
}

export function requireCompanionRelayEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): CompanionRelayEndpoint {
  const endpoint = resolveCompanionRelayEndpoint(env);
  if (endpoint === null) {
    throw new Error(OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE);
  }
  return endpoint;
}

export function requireOfficialRelayEnrollmentUrl(env: NodeJS.ProcessEnv = process.env): string {
  return requireCompanionRelayEndpoint(env).enrollmentUrl;
}

export function requireOfficialRelayCompanionUrl(env: NodeJS.ProcessEnv = process.env): string {
  return requireCompanionRelayEndpoint(env).companionUrl;
}

export const COMPANION_SERVICE_LABEL = "dev.roll-agent.companion" as const;
export const WINDOWS_COMPANION_TASK_NAME = "Roll Agent Companion" as const;

export const COMPANION_CONTROL_PROTOCOL_VERSION = 1 as const;
export const COMPANION_CONTROL_MAX_FRAME_BYTES = 64 * 1024;

export const COMPANION_RUNTIME_RESTART_MIN_MS = 500;
export const COMPANION_RUNTIME_RESTART_MAX_MS = 30_000;
