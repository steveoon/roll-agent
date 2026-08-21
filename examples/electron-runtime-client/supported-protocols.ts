import {
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  getRuntimeProtocolCapabilities,
  type RuntimeProtocolVersion,
} from "@roll-agent/protocol";

export type ElectronRuntimeProtocolVersion = Exclude<RuntimeProtocolVersion, "1.0">;

export function isElectronRuntimeProtocolVersion(
  value: RuntimeProtocolVersion,
): value is ElectronRuntimeProtocolVersion {
  return getRuntimeProtocolCapabilities(value).serverRequests;
}

export const ELECTRON_RUNTIME_PROTOCOL_VERSIONS: readonly ElectronRuntimeProtocolVersion[] =
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.filter(isElectronRuntimeProtocolVersion);
