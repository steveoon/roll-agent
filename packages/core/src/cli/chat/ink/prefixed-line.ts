import { createElement as h } from "react";
import type { ReactElement, ReactNode } from "react";
import { Box } from "ink";

export interface PrefixedLineProps {
  readonly prefix: ReactElement;
  readonly children?: ReactNode;
}

export function PrefixedLine({ prefix, children }: PrefixedLineProps): ReactElement {
  return h(
    Box,
    { flexDirection: "row" },
    h(Box, { flexShrink: 0 }, prefix),
    h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1 }, children),
  );
}
