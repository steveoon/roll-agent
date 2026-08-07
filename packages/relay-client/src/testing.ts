import {
  createRelayClientWithRuntime,
  type CreateRelayClientOptions,
  type RelayClient,
} from "./client.ts";
import {
  browserRelayRuntimeDependencies,
  type RelayClientRuntimeDependencies,
  type RelayScheduler,
  type RelaySocketCloseEvent,
  type RelaySocketHandlers,
  type RelayTimerHandle,
  type RelayWebSocketFactory,
  type RelayWebSocketLike,
} from "./transport.ts";

export interface RelayClientTestingOptions {
  readonly createWebSocket: RelayWebSocketFactory;
  readonly createUuid?: () => string;
  readonly scheduler?: RelayScheduler;
  readonly reconnectDelayMs?: (attempt: number) => number;
}

export function createRelayClientForTesting(
  options: CreateRelayClientOptions,
  testing: RelayClientTestingOptions,
): RelayClient {
  const runtime: RelayClientRuntimeDependencies = {
    createWebSocket: testing.createWebSocket,
    createUuid: testing.createUuid ?? browserRelayRuntimeDependencies.createUuid,
    scheduler: testing.scheduler ?? browserRelayRuntimeDependencies.scheduler,
    reconnectDelayMs: testing.reconnectDelayMs ?? browserRelayRuntimeDependencies.reconnectDelayMs,
  };
  return createRelayClientWithRuntime(options, runtime);
}

export type {
  RelayScheduler,
  RelaySocketCloseEvent,
  RelaySocketHandlers,
  RelayTimerHandle,
  RelayWebSocketFactory,
  RelayWebSocketLike,
};
