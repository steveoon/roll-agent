import type { RuntimeProtocolVersion } from "@roll-agent/protocol";

export const ELECTRON_RUNTIME_PROTOCOL_VERSIONS = [
  "1.3",
  "1.2",
  "1.1",
] as const satisfies readonly RuntimeProtocolVersion[];

export type ElectronRuntimeProtocolVersion = (typeof ELECTRON_RUNTIME_PROTOCOL_VERSIONS)[number];

export function isElectronRuntimeProtocolVersion(
  value: RuntimeProtocolVersion,
): value is ElectronRuntimeProtocolVersion {
  return ELECTRON_RUNTIME_PROTOCOL_VERSIONS.some((version) => version === value);
}
