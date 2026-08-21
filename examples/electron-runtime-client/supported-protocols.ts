import { getRuntimeProtocolCapabilities, type RuntimeProtocolVersion } from "@roll-agent/protocol";

export type ElectronRuntimeProtocolVersion = Exclude<RuntimeProtocolVersion, "1.0">;

export function isElectronRuntimeProtocolVersion(
  value: RuntimeProtocolVersion,
): value is ElectronRuntimeProtocolVersion {
  return getRuntimeProtocolCapabilities(value).serverRequests;
}
