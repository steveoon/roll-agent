export interface RelaySocketCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export interface RelaySocketHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (data: unknown) => void;
  readonly onClose: (event: RelaySocketCloseEvent) => void;
  readonly onError: () => void;
}

export interface RelayWebSocketLike {
  readonly readyState: number;
  setHandlers(handlers: RelaySocketHandlers): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RelayWebSocketFactory = (url: string) => RelayWebSocketLike;
export type RelayTimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface RelayScheduler {
  now(): number;
  setTimer(callback: () => void, delayMs: number): RelayTimerHandle;
  clearTimer(handle: RelayTimerHandle): void;
}

export interface RelayClientRuntimeDependencies {
  readonly createWebSocket: RelayWebSocketFactory;
  readonly createUuid: () => string;
  readonly scheduler: RelayScheduler;
  readonly reconnectDelayMs: (attempt: number) => number;
}

class BrowserRelayWebSocket implements RelayWebSocketLike {
  readonly #socket: WebSocket;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  setHandlers(handlers: RelaySocketHandlers): void {
    this.#socket.onopen = () => {
      handlers.onOpen();
    };
    this.#socket.onmessage = (event) => {
      handlers.onMessage(event.data);
    };
    this.#socket.onclose = (event) => {
      handlers.onClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    };
    this.#socket.onerror = () => {
      handlers.onError();
    };
  }

  send(data: string): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }
}

export const browserRelayRuntimeDependencies: RelayClientRuntimeDependencies = {
  createWebSocket: (url) => new BrowserRelayWebSocket(url),
  createUuid: () => globalThis.crypto.randomUUID(),
  scheduler: {
    now: () => Date.now(),
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      globalThis.clearTimeout(handle);
    },
  },
  reconnectDelayMs: (attempt) => Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7)),
};
