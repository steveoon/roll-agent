import { useEffect, useSyncExternalStore } from "react";
import type {
  ChatConnection,
  ChatConnectionSnapshot,
} from "../../../runtime-host/chatgpt-connection.ts";

const emptySnapshot = (): undefined => undefined;
const noop = () => {};
const emptySubscribe = (): (() => void) => noop;

/** Presentation subscribes independently of history, including while panels hide the status line. */
export function useChatConnection(
  connection: ChatConnection | undefined,
): ChatConnectionSnapshot | undefined {
  const snapshot = useSyncExternalStore(
    connection?.subscribe ?? emptySubscribe,
    connection?.getSnapshot ?? emptySnapshot,
  );
  useEffect(() => {
    connection?.start();
  }, [connection]);
  return snapshot;
}
