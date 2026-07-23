import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { StatusState } from "./state.ts";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import {
  computeUsageParts,
  contextPressure,
  formatContextUsage,
  formatThroughput,
  formatTokens,
  formatTurnUsage,
} from "../../utils/token-format.ts";
import { displayWidth } from "./display-width.ts";
import { GLYPHS } from "../../utils/glyphs.ts";
import { thinkingLabel } from "./thinking.ts";

const PRESSURE_STYLES = {
  ok: { dimColor: true },
  warn: { color: "yellow" },
  critical: { color: "red" },
} as const;

const COMPACT_THINKING: Record<ThinkingLevel, string> = {
  off: "off",
  low: "low",
  medium: "med",
  high: "high",
};

const DROP_ORDER = ["tps", "session", "turn", "think"] as const;

const SEPARATOR = " · ";

interface SegmentProps {
  readonly color?: string;
  readonly dimColor?: boolean;
}

interface SegmentSpec {
  readonly key: string;
  readonly full: string;
  readonly compact: string;
  readonly props: SegmentProps;
}

export interface StatusSegmentView {
  readonly key: string;
  readonly text: string;
  readonly props: SegmentProps;
}

export function composeStatusSegments(status: StatusState, width: number): StatusSegmentView[] {
  const parts = computeUsageParts(
    status.turnUsage,
    status.sessionUsage,
    status.contextWindow,
    status.contextInputTokens,
  );
  const specs: SegmentSpec[] = [
    { key: "model", full: status.model, compact: status.model, props: { color: "magenta" } },
    {
      key: "think",
      full: thinkingLabel(status.thinkingLevel),
      compact: `${GLYPHS.think} ${COMPACT_THINKING[status.thinkingLevel]}`,
      props: status.thinkingLevel === "off" ? { color: "yellow" } : { dimColor: true },
    },
  ];
  if (status.autoApprove) {
    specs.push({
      key: "auto",
      full: `${GLYPHS.auto} auto-approve`,
      compact: `${GLYPHS.auto} auto`,
      props: { color: "yellow" },
    });
  }
  const context = formatContextUsage(parts);
  if (
    context !== undefined &&
    parts.usedTokens !== undefined &&
    parts.contextWindow !== undefined
  ) {
    specs.push({
      key: "ctx",
      full: context,
      compact: `ctx ${formatTokens(parts.usedTokens)}/${formatTokens(parts.contextWindow)}`,
      props: PRESSURE_STYLES[contextPressure(parts.percentLeft)],
    });
  }
  const turn = formatTurnUsage(parts);
  if (turn !== undefined) {
    const bits: string[] = [];
    if (parts.inputTokens !== undefined) {
      bits.push(`↑${formatTokens(parts.inputTokens)}`);
    }
    if (parts.outputTokens !== undefined) {
      bits.push(`↓${formatTokens(parts.outputTokens)}`);
    }
    specs.push({ key: "turn", full: turn, compact: bits.join(" "), props: { dimColor: true } });
  }
  const throughput = formatThroughput(status.outputTokensPerSecond);
  if (throughput !== undefined) {
    specs.push({
      key: "tps",
      full: throughput,
      compact: throughput.replace(" tok/s", "t/s"),
      props: { dimColor: true },
    });
  }
  if (parts.sessionTokens !== undefined) {
    specs.push({
      key: "session",
      full: `session ${formatTokens(parts.sessionTokens)}`,
      compact: `Σ${formatTokens(parts.sessionTokens)}`,
      props: { dimColor: true },
    });
  }

  const render = (list: readonly SegmentSpec[], mode: "full" | "compact"): StatusSegmentView[] =>
    list.map((spec) => ({ key: spec.key, text: spec[mode], props: spec.props }));
  const fits = (views: readonly StatusSegmentView[]): boolean =>
    displayWidth(views.map((view) => view.text).join(SEPARATOR)) <= width;

  const fullViews = render(specs, "full");
  if (fits(fullViews)) {
    return fullViews;
  }
  let list: readonly SegmentSpec[] = specs;
  let views = render(list, "compact");
  for (const dropKey of DROP_ORDER) {
    if (fits(views)) {
      break;
    }
    list = list.filter((spec) => spec.key !== dropKey);
    views = render(list, "compact");
  }
  return views;
}

export function StatusLine({
  status,
  width,
}: {
  readonly status: StatusState;
  readonly width: number;
}): ReactElement {
  const segments = composeStatusSegments(status, width);
  return h(
    Box,
    { width },
    h(
      Text,
      { wrap: "truncate-end" },
      ...segments.flatMap((segment, index) => [
        ...(index > 0 ? [h(Text, { key: `${segment.key}-sep`, dimColor: true }, SEPARATOR)] : []),
        h(Text, { key: segment.key, ...segment.props }, segment.text),
      ]),
    ),
  );
}
