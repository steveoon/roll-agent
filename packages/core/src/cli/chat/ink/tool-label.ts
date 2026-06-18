import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Text } from "ink";

export function ToolLabel({ name }: { name: string }): ReactElement {
  const dot = name.indexOf(".");
  if (dot < 0) {
    return h(Text, { color: "cyan" }, name);
  }
  return h(
    Text,
    null,
    h(Text, { dimColor: true }, name.slice(0, dot + 1)),
    h(Text, { color: "cyan" }, name.slice(dot + 1)),
  );
}
