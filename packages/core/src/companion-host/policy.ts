import type { CompanionConfigStore } from "./config-store.ts";
import {
  RELAY_REQUEST_METHODS_V14,
  type RelayRequestMethodV14,
  type WorkspaceId,
} from "@roll-agent/relay-protocol";
import type { RemoteInteractionResponderPolicy, RemoteRequestPolicy } from "@roll-agent/companion";
import { OFFICIAL_RELAY_PROFILE } from "./constants.ts";

export const P0_REMOTE_REQUEST_METHODS = [
  RELAY_REQUEST_METHODS_V14.threadList,
  RELAY_REQUEST_METHODS_V14.threadCreate,
  RELAY_REQUEST_METHODS_V14.threadOpen,
  RELAY_REQUEST_METHODS_V14.threadSnapshot,
  RELAY_REQUEST_METHODS_V14.threadCapabilities,
  RELAY_REQUEST_METHODS_V14.threadEffortGet,
  RELAY_REQUEST_METHODS_V14.threadEffortSet,
  RELAY_REQUEST_METHODS_V14.turnStart,
  RELAY_REQUEST_METHODS_V14.turnCancel,
  RELAY_REQUEST_METHODS_V14.operationGet,
  RELAY_REQUEST_METHODS_V14.operationResultGet,
  RELAY_REQUEST_METHODS_V14.interactionCandidate,
] as const satisfies readonly RelayRequestMethodV14[];

const P0_REMOTE_REQUEST_METHOD_SET = new Set<RelayRequestMethodV14>(P0_REMOTE_REQUEST_METHODS);

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

/** Read disk for every result/capabilities query; grants are never session snapshots. */
export function createRemoteAppOutputPolicy(
  store: Pick<CompanionConfigStore, "load">,
  workspaceId: WorkspaceId,
) {
  return async (agentName: string, toolName: string): Promise<boolean> => {
    const current = await store.load().catch(() => null);
    return (
      current?.enabled === true &&
      current.workspaceId === workspaceId &&
      (current.remoteAppOutputs ?? []).some(
        (grant) => grant.agentName === agentName && grant.toolName === toolName,
      )
    );
  };
}
