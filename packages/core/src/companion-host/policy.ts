import {
  RELAY_REQUEST_METHODS_V11,
  type RelayRequestMethodV11,
  type WorkspaceId,
} from "@roll-agent/relay-protocol";
import type { RemoteInteractionResponderPolicy, RemoteRequestPolicy } from "@roll-agent/companion";
import { OFFICIAL_RELAY_PROFILE } from "./constants.ts";

export const P0_REMOTE_REQUEST_METHODS = [
  RELAY_REQUEST_METHODS_V11.threadList,
  RELAY_REQUEST_METHODS_V11.threadCreate,
  RELAY_REQUEST_METHODS_V11.threadOpen,
  RELAY_REQUEST_METHODS_V11.threadSnapshot,
  RELAY_REQUEST_METHODS_V11.threadCapabilities,
  RELAY_REQUEST_METHODS_V11.turnStart,
  RELAY_REQUEST_METHODS_V11.turnCancel,
  RELAY_REQUEST_METHODS_V11.operationGet,
  RELAY_REQUEST_METHODS_V11.interactionCandidate,
] as const satisfies readonly RelayRequestMethodV11[];

const P0_REMOTE_REQUEST_METHOD_SET = new Set<RelayRequestMethodV11>(P0_REMOTE_REQUEST_METHODS);

export interface OfficialRelayResponderContext {
  readonly authenticatedTransport: true;
  readonly relayProfile: typeof OFFICIAL_RELAY_PROFILE.id;
}

export function createOfficialRelayResponderContext(): OfficialRelayResponderContext {
  return {
    authenticatedTransport: true,
    relayProfile: OFFICIAL_RELAY_PROFILE.id,
  };
}

export function createP0RemoteRequestPolicy(workspaceId: WorkspaceId): RemoteRequestPolicy {
  return (input) =>
    !input.signal.aborted &&
    input.workspaceId === workspaceId &&
    P0_REMOTE_REQUEST_METHOD_SET.has(input.method);
}

export function createOfficialRelayResponderPolicy(
  workspaceId: WorkspaceId,
): RemoteInteractionResponderPolicy {
  return (input) =>
    !input.signal.aborted &&
    input.workspaceId === workspaceId &&
    isOfficialRelayResponderContext(input.responderContext);
}

function isOfficialRelayResponderContext(value: unknown): value is OfficialRelayResponderContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "authenticatedTransport" in value &&
    value.authenticatedTransport === true &&
    "relayProfile" in value &&
    value.relayProfile === OFFICIAL_RELAY_PROFILE.id
  );
}
