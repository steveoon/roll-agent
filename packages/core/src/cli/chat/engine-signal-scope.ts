export const CHAT_ENGINE_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type ChatEngineShutdownSignal = (typeof CHAT_ENGINE_SHUTDOWN_SIGNALS)[number];

interface ChatEngineSignalSource {
  on(
    signal: ChatEngineShutdownSignal,
    listener: (signal: ChatEngineShutdownSignal) => void,
  ): unknown;
  off(
    signal: ChatEngineShutdownSignal,
    listener: (signal: ChatEngineShutdownSignal) => void,
  ): unknown;
}

interface DisposableConversationEngine {
  dispose(): Promise<void>;
}

export interface ChatEngineSignalScope {
  readonly receivedSignal: ChatEngineShutdownSignal | undefined;
  readonly signal: AbortSignal;
  setEngine(engine: DisposableConversationEngine): void;
  dispose(): void;
}

export interface ChatEngineSignalScopeOptions {
  readonly signalSource?: ChatEngineSignalSource;
  readonly onSignal?: (signal: ChatEngineShutdownSignal) => void;
  readonly onDisposeError?: (error: unknown) => void;
}

/**
 * Bridges process shutdown signals into ConversationEngine lifecycle cancellation.
 *
 * The listeners are installed before an Engine exists so a signal racing Engine
 * construction is remembered and applied synchronously as soon as setEngine()
 * binds the instance. The first signal removes both listeners, allowing a second
 * signal to retain the host process' default force-exit behavior.
 */
export function createChatEngineSignalScope(
  options: ChatEngineSignalScopeOptions = {},
): ChatEngineSignalScope {
  const signalSource = options.signalSource ?? process;
  let engine: DisposableConversationEngine | undefined;
  let receivedSignal: ChatEngineShutdownSignal | undefined;
  let engineDisposePromise: Promise<void> | undefined;
  let listenersInstalled = true;
  const shutdownController = new AbortController();

  const removeListeners = (): void => {
    if (!listenersInstalled) return;
    listenersInstalled = false;
    for (const signal of CHAT_ENGINE_SHUTDOWN_SIGNALS) {
      signalSource.off(signal, onSignal);
    }
  };

  const requestEngineDispose = (): void => {
    if (engine === undefined || engineDisposePromise !== undefined) return;
    try {
      engineDisposePromise = engine.dispose();
      engineDisposePromise.catch((error: unknown) => {
        options.onDisposeError?.(error);
      });
    } catch (error) {
      options.onDisposeError?.(error);
    }
  };

  const onSignal = (signal: ChatEngineShutdownSignal): void => {
    if (receivedSignal !== undefined) return;
    receivedSignal = signal;
    shutdownController.abort(new Error(`Received ${signal}`));
    queueMicrotask(removeListeners);
    try {
      options.onSignal?.(signal);
    } finally {
      requestEngineDispose();
    }
  };

  for (const signal of CHAT_ENGINE_SHUTDOWN_SIGNALS) {
    signalSource.on(signal, onSignal);
  }

  return {
    get receivedSignal() {
      return receivedSignal;
    },
    signal: shutdownController.signal,
    setEngine(nextEngine) {
      if (engine !== undefined && engine !== nextEngine) {
        throw new Error("Chat signal scope already has a ConversationEngine");
      }
      engine = nextEngine;
      if (receivedSignal !== undefined) {
        requestEngineDispose();
      }
    },
    dispose() {
      removeListeners();
    },
  };
}
