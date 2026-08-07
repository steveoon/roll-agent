export const COMPANION_CONFIG_VERSION = 1 as const;

const UNDECIDED_OFFICIAL_RELAY_HOST: string | null = null;

export const OFFICIAL_RELAY_PROFILE = {
  id: "roll-cloud-v1",
  host: UNDECIDED_OFFICIAL_RELAY_HOST,
} as const;

export const OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE =
  "The official Roll Relay endpoint is not decided yet; Companion remote access is unavailable";

export function isOfficialRelayEndpointDecided(): boolean {
  return OFFICIAL_RELAY_PROFILE.host !== null;
}

export function requireOfficialRelayEnrollmentUrl(): string {
  return `https://${requireOfficialRelayHost()}/v1/device-enrollments/redeem`;
}

export function requireOfficialRelayCompanionUrl(): string {
  return `wss://${requireOfficialRelayHost()}/v1/companion`;
}

function requireOfficialRelayHost(): string {
  const host = OFFICIAL_RELAY_PROFILE.host;
  if (host === null) {
    throw new Error(OFFICIAL_RELAY_ENDPOINT_UNDECIDED_MESSAGE);
  }
  return host;
}

export const COMPANION_SERVICE_LABEL = "dev.roll-agent.companion" as const;
export const WINDOWS_COMPANION_TASK_NAME = "Roll Agent Companion" as const;

export const COMPANION_CONTROL_PROTOCOL_VERSION = 1 as const;
export const COMPANION_CONTROL_MAX_FRAME_BYTES = 64 * 1024;

export const COMPANION_RUNTIME_RESTART_MIN_MS = 500;
export const COMPANION_RUNTIME_RESTART_MAX_MS = 30_000;
