import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_RELOAD_READY_TIMEOUT_MS = 15_000;
const DEFAULT_RELOAD_READY_POLL_MS = 250;
const RELOAD_MARK_GLOBAL = "__rollReloadMark";

export type NativeReloadController = {
  evaluateJson<T = unknown>(expression: string): Promise<T>;
  reload(options?: {
    readonly url?: string;
    readonly ignoreCache?: boolean;
    readonly timeoutMs?: number;
  }): Promise<void>;
};

export type ReloadNativePageOptions = {
  readonly url: string;
  readonly ignoreCache?: boolean;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly createToken?: () => string;
  readonly onReloadSent?: () => void;
};

type DocumentSwapState = {
  readonly mark: string | null;
  readonly readyState: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDocumentSwapState(value: unknown): value is DocumentSwapState {
  if (!isRecord(value)) {
    return false;
  }
  const mark = value["mark"];
  return (mark === null || typeof mark === "string") && typeof value["readyState"] === "string";
}

function defaultCreateToken(): string {
  return `roll-reload-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}

async function readDocumentSwapState(
  controller: NativeReloadController,
): Promise<DocumentSwapState> {
  const value = await controller.evaluateJson<unknown>(
    `(() => ({ mark: window.${RELOAD_MARK_GLOBAL} ?? null, readyState: document.readyState }))()`,
  );
  if (!isDocumentSwapState(value)) {
    throw new Error("Native CDP Runtime.evaluate returned an unexpected reload state.");
  }
  return value;
}

/**
 * Reloads the current native page via CDP `Page.reload` and waits until the
 * document has actually been swapped.
 *
 * A reload keeps the same URL, so the navigate ready-poll (which anchors on a
 * URL change) would falsely report readiness while the stale document is still
 * `readyState === "complete"`. Instead we tag the live document with a window
 * sentinel, trigger the reload, and only return once that sentinel is gone
 * (window globals are wiped when the document is replaced) and the fresh
 * document has reached an interactive/complete ready state.
 */
export async function reloadNativePageAndWaitForSwap(
  controller: NativeReloadController,
  options: ReloadNativePageOptions,
): Promise<void> {
  const token = (options.createToken ?? defaultCreateToken)();
  const now = options.now ?? (() => Date.now());
  const wait = options.delay ?? delay;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RELOAD_READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_RELOAD_READY_POLL_MS;

  await controller.evaluateJson<boolean>(
    `(() => { window.${RELOAD_MARK_GLOBAL} = ${JSON.stringify(token)}; return true; })()`,
  );
  await controller.reload({
    url: options.url,
    ...(options.ignoreCache !== undefined ? { ignoreCache: options.ignoreCache } : {}),
  });
  options.onReloadSent?.();

  const startedAt = now();
  let lastError: Error | undefined;

  while (now() - startedAt < timeoutMs) {
    try {
      const state = await readDocumentSwapState(controller);
      if (
        state.mark !== token &&
        (state.readyState === "interactive" || state.readyState === "complete")
      ) {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await wait(pollMs);
  }

  throw new Error(
    `Native page reload did not swap document within ${String(timeoutMs)}ms${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}
