import { createElement as h, useEffect, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { ChatConnection } from "../../../runtime-host/chatgpt-connection.ts";

export function ConnectionNotice({
  connection,
}: {
  readonly connection: ChatConnection;
}): ReactElement {
  const message = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  useEffect(() => {
    connection.start();
  }, [connection]);
  return h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, message));
}
