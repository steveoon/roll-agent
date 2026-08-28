import { RollNodeClient, type RuntimeClientExit } from "@roll-agent/client-node";
import {
  CompanionInteractionBroker,
  CompanionRelayBridgeV11,
  CompanionWorkspace,
  OutboundCompanionRelayV11,
  createRuntimeServerRequestHandlers,
  createWebSocketRelayTransportV11,
  type RelayTransportV11,
  type WebSocketLikeV11,
} from "@roll-agent/companion";
import type { CompanionConfig } from "./schema.ts";
import type { BundledRollInvocation } from "./invocation.ts";
import { requireOfficialRelayCompanionUrl } from "./constants.ts";
import {
  createOfficialRelayResponderContext,
  createOfficialRelayResponderPolicy,
  createP0RemoteRequestPolicy,
} from "./policy.ts";

const RELAY_OPEN_TIMEOUT_MS = 15_000;

/**
 * Runtime Protocol versions the Companion Host is known to bridge.
 *
 * 1.3 is the floor because the Relay bridge requires a Runtime that routes Interactions through the
 * server-request channel. The list is explicit rather than derived from the Client's advertised set
 * so a newer Runtime cannot be bridged before this Host has been reviewed against it.
 */
export const COMPANION_RUNTIME_PROTOCOL_VERSIONS = ["1.3", "1.4"] as const;

export type OpenableCompanionWebSocket = WebSocketLikeV11 & {
  readonly addEventListener: {
    (type: "open", listener: () => void): void;
    (type: "error", listener: () => void): void;
  };
  readonly removeEventListener: {
    (type: "open", listener: () => void): void;
    (type: "error", listener: () => void): void;
  };
};

export type CompanionWebSocketFactory = (url: string) => OpenableCompanionWebSocket;

export interface ManagedCompanionSession {
  readonly runtimeExit: Promise<RuntimeClientExit>;
  stop(): Promise<void>;
}

export interface CompanionSessionFactory {
  create(config: CompanionConfig, credential: string): Promise<ManagedCompanionSession>;
}

export class DefaultCompanionSessionFactory implements CompanionSessionFactory {
  private readonly invocation: BundledRollInvocation;
  private readonly createWebSocket: CompanionWebSocketFactory;

  constructor(options: {
    readonly invocation: BundledRollInvocation;
    readonly createWebSocket?: CompanionWebSocketFactory;
  }) {
    this.invocation = options.invocation;
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
  }

  async create(config: CompanionConfig, credential: string): Promise<ManagedCompanionSession> {
    const interactionBroker = new CompanionInteractionBroker();
    const client = await RollNodeClient.start({
      cwd: config.cwd,
      command: this.invocation.command,
      args: this.invocation.runtimeArgs,
      clientName: "roll-companion",
      serverRequestHandlers: createRuntimeServerRequestHandlers(interactionBroker),
    });
    try {
      const negotiated = client.getInitializationResult().protocolVersion;
      if (!isBridgeableRuntimeProtocolVersion(negotiated)) {
        throw new Error(
          `Bundled Companion Runtime must negotiate Runtime Protocol ${COMPANION_RUNTIME_PROTOCOL_VERSIONS.join(" or ")}, not ${negotiated}`,
        );
      }
      const workspace = new CompanionWorkspace({
        client,
        workspaceId: config.workspaceId,
        interactionBroker,
        // Runtime policy is the sole approval fact source. A Runtime `deny` never creates an
        // Interaction; `confirm` is completed by the authenticated remote responder.
        localApprovalPolicy: () => "allow",
      });
      const workspaces = new Map([[config.workspaceId, workspace]]);
      const bridge = new CompanionRelayBridgeV11({
        deviceId: config.deviceId,
        pairingToken: credential,
        workspaces,
      });
      const requestPolicy = createP0RemoteRequestPolicy(config.workspaceId);
      const responderPolicy = createOfficialRelayResponderPolicy(config.workspaceId);
      const responderContext = createOfficialRelayResponderContext();
      const outbound = new OutboundCompanionRelayV11({
        bridge,
        connectTransport: async () => ({
          transport: await openRelayTransport(
            requireOfficialRelayCompanionUrl(),
            this.createWebSocket,
          ),
          requestPolicy,
          responderPolicy,
          responderContext,
        }),
      });
      const runtimeExit = new Promise<RuntimeClientExit>((resolve) => {
        client.onExit(resolve);
      });
      let stopped = false;
      outbound.start();
      return {
        runtimeExit,
        async stop() {
          if (stopped) {
            return;
          }
          stopped = true;
          await stopRelayBeforeRuntime(outbound, client);
        },
      };
    } catch (error: unknown) {
      await client.shutdown().catch(() => undefined);
      throw error;
    }
  }
}

export function isBridgeableRuntimeProtocolVersion(
  version: string,
): version is (typeof COMPANION_RUNTIME_PROTOCOL_VERSIONS)[number] {
  return COMPANION_RUNTIME_PROTOCOL_VERSIONS.some((candidate) => candidate === version);
}

export async function stopRelayBeforeRuntime(
  relay: { readonly stop: () => void },
  runtime: { readonly shutdown: () => Promise<unknown> },
): Promise<void> {
  // The public Relay path is detached before the trusted local stdio Runtime is closed.
  relay.stop();
  await runtime.shutdown();
}

async function openRelayTransport(
  url: string,
  createWebSocket: CompanionWebSocketFactory,
): Promise<RelayTransportV11> {
  const socket = createWebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Timed out connecting to the official Relay")),
      RELAY_OPEN_TIMEOUT_MS,
    );
    const opened = () => finish();
    const failed = () => finish(new Error("Unable to connect to the official Relay"));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      if (error === undefined) {
        resolve();
      } else {
        socket.close();
        reject(error);
      }
    };
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
  });
  return createWebSocketRelayTransportV11(socket);
}

function defaultWebSocketFactory(url: string): OpenableCompanionWebSocket {
  if (globalThis.WebSocket === undefined) {
    throw new Error("This bundled Node runtime does not provide WebSocket support");
  }
  return new globalThis.WebSocket(url);
}
