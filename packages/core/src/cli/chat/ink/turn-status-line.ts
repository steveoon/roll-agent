import { createElement as h, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { displayWidth } from "./display-width.ts";
import { Spinner } from "./spinner.ts";
import { TURN_ACTIVITY_KINDS, type TurnActivity, type TurnActivityKind } from "./turn-activity.ts";

const TIMER_INTERVAL_MS = 250;
const STATUS_MARKER_WIDTH = 2;
const STATUS_HORIZONTAL_PADDING = 2;
const MIN_STATUS_GAP = 2;
const MIN_LABEL_WITH_PHASE_WIDTH = 4;
// 相位计时器满 1s 才出现，避免快速相位切换时反复闪现 "0s"
const MIN_PHASE_TIMER_MS = 1_000;
const ELLIPSIS = "…";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ACTIVITY_COLORS: Record<TurnActivityKind, string> = {
  [TURN_ACTIVITY_KINDS.waitingModel]: "gray",
  [TURN_ACTIVITY_KINDS.reasoning]: "magenta",
  [TURN_ACTIVITY_KINDS.replying]: "green",
  [TURN_ACTIVITY_KINDS.tool]: "cyan",
  [TURN_ACTIVITY_KINDS.compacting]: "yellow",
  [TURN_ACTIVITY_KINDS.waitingUser]: "yellow",
  [TURN_ACTIVITY_KINDS.cancelling]: "yellow",
};

function truncateDisplay(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  const contentWidth = maxWidth - displayWidth(ELLIPSIS);
  let result = "";
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = displayWidth(segment);
    if (width + segmentWidth > contentWidth) {
      break;
    }
    result += segment;
    width += segmentWidth;
  }
  return `${result}${ELLIPSIS}`;
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m${String(seconds)}s` : `${String(seconds)}s`;
}

export interface TurnStatusLayout {
  readonly label: string;
  readonly phaseTime: string | undefined;
  readonly spacer: string;
  readonly turnTime: string;
}

export function composeTurnStatusLayout(
  activity: TurnActivity,
  phaseElapsedMs: number,
  turnElapsedMs: number,
  width: number,
): TurnStatusLayout {
  if (width <= 0) {
    return { label: "", phaseTime: undefined, spacer: "", turnTime: "" };
  }
  const turnTime = `本轮 ${formatElapsed(turnElapsedMs)}`;
  const turnTimeWidth = displayWidth(turnTime);
  if (turnTimeWidth >= width) {
    return {
      label: "",
      phaseTime: undefined,
      spacer: "",
      turnTime: truncateDisplay(turnTime, width),
    };
  }

  const leftWidth = Math.max(0, width - turnTimeWidth - MIN_STATUS_GAP);
  let phaseTime =
    activity.showPhaseElapsed && phaseElapsedMs >= MIN_PHASE_TIMER_MS
      ? formatElapsed(phaseElapsedMs)
      : undefined;
  const phaseWidth = phaseTime === undefined ? 0 : displayWidth(`  ${phaseTime}`);
  let labelWidth = leftWidth - phaseWidth;
  if (phaseTime !== undefined && labelWidth < MIN_LABEL_WITH_PHASE_WIDTH) {
    phaseTime = undefined;
    labelWidth = leftWidth;
  }
  const label = truncateDisplay(activity.label, Math.max(0, labelWidth));
  const visiblePhase = phaseTime === undefined ? "" : `  ${phaseTime}`;
  const spacer = " ".repeat(
    Math.max(1, width - displayWidth(label) - displayWidth(visiblePhase) - turnTimeWidth),
  );
  return { label, phaseTime, spacer, turnTime };
}

export function composeTurnStatusLine(
  activity: TurnActivity,
  phaseElapsedMs: number,
  turnElapsedMs: number,
  width: number,
): string {
  const layout = composeTurnStatusLayout(activity, phaseElapsedMs, turnElapsedMs, width);
  const phaseTime = layout.phaseTime === undefined ? "" : `  ${layout.phaseTime}`;
  return `${layout.label}${phaseTime}${layout.spacer}${layout.turnTime}`;
}

export function TurnStatusLine({
  activity,
  width,
}: {
  readonly activity: TurnActivity;
  readonly width: number;
}): ReactElement {
  const renderedAt = Date.now();
  const turnStartedAt = useRef(renderedAt);
  const activityTiming = useRef({ key: activity.key, startedAt: renderedAt });
  if (activityTiming.current.key !== activity.key) {
    activityTiming.current = { key: activity.key, startedAt: renderedAt };
  }
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TIMER_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const currentTime = Math.max(now, renderedAt);
  const layout = composeTurnStatusLayout(
    activity,
    currentTime - activityTiming.current.startedAt,
    currentTime - turnStartedAt.current,
    Math.max(0, width - STATUS_HORIZONTAL_PADDING - STATUS_MARKER_WIDTH),
  );
  return h(
    Box,
    { width, paddingX: 1 },
    activity.animated
      ? h(Spinner, { color: ACTIVITY_COLORS[activity.kind] })
      : h(Text, { color: ACTIVITY_COLORS[activity.kind] }, "◆"),
    width > STATUS_HORIZONTAL_PADDING + 1 ? h(Text, null, " ") : null,
    layout.label.length > 0
      ? h(Text, { color: ACTIVITY_COLORS[activity.kind] }, layout.label)
      : null,
    layout.phaseTime === undefined ? null : h(Text, { dimColor: true }, `  ${layout.phaseTime}`),
    layout.spacer.length > 0 ? h(Text, null, layout.spacer) : null,
    layout.turnTime.length > 0 ? h(Text, { dimColor: true }, layout.turnTime) : null,
  );
}
