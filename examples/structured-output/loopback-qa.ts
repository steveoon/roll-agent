import {
  createRelayClientForTesting,
  type RelayWebSocketLike,
} from "@roll-agent/relay-client/testing";
import type { CreateRelayClientOptions } from "@roll-agent/relay-client";

/** Isolated GUI acceptance only. Production entry uses the normal WSS transport. */
export function createLoopbackQaClient(options: CreateRelayClientOptions) {
  if (location.hostname !== "127.0.0.1") throw new Error("Loopback QA requires 127.0.0.1");
  return createRelayClientForTesting(options, {
    createWebSocket: (input): RelayWebSocketLike => {
      const url = new URL(input);
      if (url.protocol !== "wss:" || url.hostname !== "127.0.0.1") {
        throw new Error("QA adapter only accepts exact loopback Relay descriptors");
      }
      url.protocol = "ws:";
      const socket = new WebSocket(url);
      return {
        get readyState() {
          return socket.readyState;
        },
        setHandlers(handlers) {
          socket.onopen = () => handlers.onOpen();
          socket.onmessage = (event) => handlers.onMessage(event.data);
          socket.onerror = () => handlers.onError();
          socket.onclose = (event) =>
            handlers.onClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
        },
        send: (value) => socket.send(value),
        close: (code, reason) => socket.close(code, reason),
      };
    },
  });
}
