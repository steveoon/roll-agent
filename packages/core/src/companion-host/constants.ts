export const COMPANION_CONFIG_VERSION = 1 as const;

const OFFICIAL_RELAY_HOST: string | null = "sponge-mcp.duliday.com";

export const RELAY_HOST_OVERRIDE_ENV = "ROLL_COMPANION_RELAY_HOST";

export const OFFICIAL_RELAY_PROFILE = {
  id: "roll-cloud-v1",
  host: OFFICIAL_RELAY_HOST,
} as const;

export const OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE =
  "The official Roll Relay endpoint is not decided yet; Companion remote access is unavailable";

export function isOfficialRelayEndpointDecided(): boolean {
  return OFFICIAL_RELAY_PROFILE.host !== null;
}

export interface RelayEndpoint {
  readonly host: string;
  readonly source: "official" | "override";
  readonly secure: boolean;
  readonly enrollmentUrl: string;
  readonly companionUrl: string;
}

export function resolveRelayEndpoint(env: NodeJS.ProcessEnv = process.env): RelayEndpoint {
  const override = env[RELAY_HOST_OVERRIDE_ENV]?.trim();
  if (override !== undefined && override !== "") {
    return buildRelayEndpoint(normalizeRelayHost(override), "override");
  }
  const host = OFFICIAL_RELAY_PROFILE.host;
  if (host === null) {
    throw new Error(OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE);
  }
  return buildRelayEndpoint(host, "official");
}

const RELAY_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/u;

export function normalizeRelayHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!RELAY_HOST_PATTERN.test(host)) {
    throw new Error(
      `Invalid ${RELAY_HOST_OVERRIDE_ENV} value; expected host[:port] without scheme, path, or credentials`,
    );
  }
  const port = extractRelayPort(host);
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new Error(
      `Invalid ${RELAY_HOST_OVERRIDE_ENV} port; expected a value between 1 and 65535`,
    );
  }
  return host;
}

function extractRelayPort(host: string): number | undefined {
  const match = /:(\d{1,5})$/u.exec(host);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function buildRelayEndpoint(host: string, source: RelayEndpoint["source"]): RelayEndpoint {
  const secure = !isLoopbackRelayHost(host);
  const httpScheme = secure ? "https" : "http";
  const wsScheme = secure ? "wss" : "ws";
  return {
    host,
    source,
    secure,
    enrollmentUrl: `${httpScheme}://${host}/v1/device-enrollments/redeem`,
    companionUrl: `${wsScheme}://${host}/v1/companion`,
  };
}

const LOOPBACK_IPV4_PATTERN = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function isLoopbackRelayHost(host: string): boolean {
  const hostname = host.replace(/:\d{1,5}$/u, "");
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }
  const quad = LOOPBACK_IPV4_PATTERN.exec(hostname);
  if (quad === null) {
    return false;
  }
  return quad.slice(1).every((octet) => Number(octet) <= 255);
}

export const COMPANION_SERVICE_LABEL = "dev.roll-agent.companion" as const;
export const WINDOWS_COMPANION_TASK_NAME = "Roll Agent Companion" as const;

export const COMPANION_CONTROL_PROTOCOL_VERSION = 1 as const;
export const COMPANION_CONTROL_MAX_FRAME_BYTES = 64 * 1024;

export const COMPANION_RUNTIME_RESTART_MIN_MS = 500;
export const COMPANION_RUNTIME_RESTART_MAX_MS = 30_000;
