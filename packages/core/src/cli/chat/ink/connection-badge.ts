import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Text } from "ink";
import isUnicodeSupported from "is-unicode-supported";
import type {
  ChatConnectionSnapshot,
  ChatConnectionState,
} from "../../../runtime-host/chatgpt-connection.ts";
import { Spinner } from "./spinner.ts";

const MARKERS: Record<ChatConnectionState, string> = isUnicodeSupported()
  ? { idle: "○", connecting: "…", connected: "✓", failed: "!", disabled: "" }
  : { idle: "-", connecting: "~", connected: "+", failed: "!", disabled: "" };

export function connectionBadgeText(snapshot: ChatConnectionSnapshot | undefined): string {
  return snapshot === undefined || snapshot.state === "disabled"
    ? ""
    : `ChatGPT ${MARKERS[snapshot.state]}`;
}

export function ConnectionBadge({
  snapshot,
}: {
  readonly snapshot: ChatConnectionSnapshot | undefined;
}): ReactElement | null {
  const text = connectionBadgeText(snapshot);
  if (!text) return null;
  if (snapshot?.state === "connecting") {
    return h(Text, { dimColor: true }, "ChatGPT ", h(Spinner, { color: "gray" }));
  }
  return h(Text, snapshot?.state === "failed" ? { color: "yellow" } : { dimColor: true }, text);
}
