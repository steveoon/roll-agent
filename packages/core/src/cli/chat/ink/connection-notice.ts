import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ChatConnection } from "../../../runtime-host/chatgpt-connection.ts";

export function ConnectionNotice({
  connection,
  onNotice,
}: {
  readonly connection: ChatConnection;
  readonly onNotice: (message: string) => void;
}): null {
  const message = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const lastNotice = useRef<{ connection: ChatConnection; message: string } | undefined>(undefined);
  useEffect(() => {
    connection.start();
  }, [connection]);
  useEffect(() => {
    if (lastNotice.current?.connection === connection && lastNotice.current.message === message) {
      return;
    }
    lastNotice.current = { connection, message };
    // Connection updates belong in the transcript, not in the permanent input chrome.
    if (message) onNotice(message);
  }, [connection, message, onNotice]);
  return null;
}
