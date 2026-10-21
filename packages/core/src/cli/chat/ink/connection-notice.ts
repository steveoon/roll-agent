import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { ChatConnectionSnapshot } from "../../../runtime-host/chatgpt-connection.ts";

/** Only the current failure is visible; connection transitions never enter the transcript. */
export function ConnectionNotice({
  snapshot,
  width,
}: {
  readonly snapshot: ChatConnectionSnapshot | undefined;
  readonly width: number;
}): ReactElement | null {
  if (snapshot?.state !== "failed" || snapshot.reportedInTurn === true) return null;
  return h(
    Box,
    { width, paddingX: 1, flexShrink: 0 },
    h(Text, { color: "yellow" }, snapshot.message),
  );
}
