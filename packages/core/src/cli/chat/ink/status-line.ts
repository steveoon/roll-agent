import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text, useStdout } from "ink";
import type { StatusState } from "./state.ts";
import { computeUsageParts, formatTokens } from "../../utils/token-format.ts";

export function StatusLine({ status }: { status: StatusState }): ReactElement {
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;
  const parts = computeUsageParts(
    status.turnUsage,
    status.sessionUsage,
    status.contextWindow,
    status.contextInputTokens,
  );
  const segments: ReactElement[] = [h(Text, { key: "model", color: "magenta" }, status.model)];
  if (
    parts.percentLeft !== undefined &&
    parts.usedTokens !== undefined &&
    parts.contextWindow !== undefined
  ) {
    segments.push(
      h(
        Text,
        { key: "ctx", dimColor: true },
        ` · ${String(parts.percentLeft)}% left (${formatTokens(parts.usedTokens)}/${formatTokens(parts.contextWindow)})`,
      ),
    );
  }
  if (parts.inputTokens !== undefined) {
    const cached =
      parts.cachedInputTokens !== undefined
        ? ` (+${formatTokens(parts.cachedInputTokens)} cached)`
        : "";
    segments.push(
      h(Text, { key: "in", dimColor: true }, ` · in ${formatTokens(parts.inputTokens)}${cached}`),
    );
  }
  if (parts.outputTokens !== undefined) {
    const reasoning =
      parts.reasoningTokens !== undefined
        ? ` (+${formatTokens(parts.reasoningTokens)} reasoning)`
        : "";
    segments.push(
      h(
        Text,
        { key: "out", dimColor: true },
        ` · out ${formatTokens(parts.outputTokens)}${reasoning}`,
      ),
    );
  }
  if (parts.sessionTokens !== undefined) {
    segments.push(
      h(
        Text,
        { key: "session", dimColor: true },
        ` · session ${formatTokens(parts.sessionTokens)}`,
      ),
    );
  }
  return h(Box, { width }, h(Text, { wrap: "truncate-end" }, ...segments));
}
