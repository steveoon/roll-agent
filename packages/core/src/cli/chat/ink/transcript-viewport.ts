import {
  createElement as h,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { DOMElement } from "ink";
import type { ChatThinkingDisplay } from "../../../config/schema.ts";
import type { DiffDisplayMode } from "../diff-display.ts";
import type { BannerLine } from "../banner.ts";
import { BannerHistoryView, BannerLinesView } from "./banner-view.ts";
import { useDeferredBoxMetrics } from "./deferred-box-metrics.ts";
import { HistoryItemView } from "./history-item.ts";
import { LiveRegion } from "./live-region.ts";
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  parseMouseWheelInput,
} from "./mouse-input.ts";
import type { HistoryItem, LiveState } from "./state.ts";

const WINDOWING_THRESHOLD = 20;
const MOUSE_SCROLL_ROWS = 3;
const SCROLL_COALESCE_MS = 16;

interface TranscriptEntry {
  readonly key: string;
  readonly element: ReactElement;
  readonly paddingTop: number;
  readonly marginLeft: number;
}

export interface TranscriptViewportProps {
  readonly width: number;
  readonly history: readonly HistoryItem[];
  readonly live: LiveState;
  readonly banner?: readonly BannerLine[];
  readonly animateBanner: boolean;
  readonly onBannerSettled: () => void;
  readonly navigationBlocked: boolean;
  readonly mouseTracking?: boolean;
  readonly onWheelScroll?: () => void;
  readonly thinkingDisplay: ChatThinkingDisplay;
  readonly diffDisplay: DiffDisplayMode;
}

interface VisibleWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly topSpacer: number;
  readonly bottomSpacer: number;
  readonly totalHeight: number;
}

function hasLiveContent(live: LiveState): boolean {
  return (
    live.streamingText.length > 0 ||
    live.reasoningText.length > 0 ||
    live.activeTools.length > 0 ||
    live.compacting
  );
}

function historyEntry(
  item: HistoryItem,
  previous: HistoryItem | undefined,
  thinkingDisplay: ChatThinkingDisplay,
  diffDisplay: DiffDisplayMode,
  width: number,
): TranscriptEntry {
  const spaced =
    item.kind === "user" ||
    item.kind === "assistant" ||
    item.kind === "reasoning" ||
    previous?.kind === "reasoning";
  const indented = item.kind === "tool" || item.kind === "denied" || item.kind === "cancelled";
  const marginLeft = indented ? 3 : 1;
  return {
    key: `history:${item.id}`,
    element: h(HistoryItemView, {
      item,
      thinkingDisplay,
      diffDisplay,
      width: Math.max(1, width - marginLeft),
    }),
    paddingTop: spaced ? 1 : 0,
    marginLeft,
  };
}

export function coalesceScrollOffset(next: number, maxScroll: number): number {
  return Math.min(Math.max(0, next), Math.max(0, maxScroll));
}

export function computeVisibleWindow(
  heights: readonly number[],
  viewportHeight: number,
  scrollOffset: number,
): VisibleWindow {
  const safeViewportHeight = Math.max(1, Math.floor(viewportHeight));
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);
  const maxScroll = Math.max(0, totalHeight - safeViewportHeight);
  const safeOffset = Math.min(Math.max(0, Math.floor(scrollOffset)), maxScroll);
  const visibleStart = Math.max(0, totalHeight - safeViewportHeight - safeOffset);
  const overscanStart = Math.max(0, visibleStart - safeViewportHeight);
  const overscanEnd = Math.min(totalHeight, visibleStart + safeViewportHeight * 2);
  let cursor = 0;
  let startIndex = 0;
  while (startIndex < heights.length && cursor + (heights[startIndex] ?? 0) <= overscanStart) {
    cursor += heights[startIndex] ?? 0;
    startIndex += 1;
  }
  const topSpacer = cursor;
  let endIndex = startIndex;
  while (endIndex < heights.length && cursor < overscanEnd) {
    cursor += heights[endIndex] ?? 0;
    endIndex += 1;
  }
  return {
    startIndex,
    endIndex,
    topSpacer,
    bottomSpacer: Math.max(0, totalHeight - cursor),
    totalHeight,
  };
}

function MeasuredEntry({
  entry,
  onMeasure,
}: {
  readonly entry: TranscriptEntry;
  readonly onMeasure: (key: string, height: number) => void;
}): ReactElement {
  const ref = useRef<DOMElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (node !== null) {
      // The parent already re-renders on every layout-affecting event. Reading Yoga here avoids
      // one stdout resize listener per transcript row, which otherwise triggers listener leaks
      // for long histories.
      const layout = node.yogaNode?.getComputedLayout();
      if (layout !== undefined) {
        onMeasure(entry.key, layout.height);
      }
    }
  });
  return h(
    Box,
    {
      ref,
      flexDirection: "column",
      flexShrink: 0,
      paddingTop: entry.paddingTop,
      marginLeft: entry.marginLeft,
    },
    entry.element,
  );
}

export function TranscriptViewport(props: TranscriptViewportProps): ReactElement {
  const { stdout } = useStdout();
  const viewportRef = useRef<DOMElement | null>(null);
  const viewportMetrics = useDeferredBoxMetrics(viewportRef);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [scrollOffset, setScrollOffset] = useState(0);
  const [unseenHistory, setUnseenHistory] = useState(0);
  const [unseenLive, setUnseenLive] = useState(false);
  const scrollOffsetRef = useRef(0);
  const pendingScrollRef = useRef<number | undefined>(undefined);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  scrollOffsetRef.current = scrollOffset;

  const entries = useMemo(() => {
    const result = props.history.map((item, index) =>
      historyEntry(
        item,
        props.history[index - 1],
        props.thinkingDisplay,
        props.diffDisplay,
        props.width,
      ),
    );
    if (props.banner !== undefined) {
      result.unshift({
        key: "animated-banner",
        element: props.animateBanner
          ? h(BannerHistoryView, {
              lines: props.banner,
              onSettled: props.onBannerSettled,
            })
          : h(BannerLinesView, { lines: props.banner }),
        paddingTop: 0,
        marginLeft: 1,
      });
    }
    if (hasLiveContent(props.live)) {
      result.push({
        key: "live",
        element: h(LiveRegion, { live: props.live, width: Math.max(1, props.width - 1) }),
        paddingTop: 0,
        marginLeft: 1,
      });
    }
    return result;
  }, [
    props.animateBanner,
    props.banner,
    props.diffDisplay,
    props.history,
    props.live,
    props.onBannerSettled,
    props.thinkingDisplay,
    props.width,
  ]);

  useEffect(() => {
    setHeights(new Map());
  }, [props.width, props.thinkingDisplay, props.diffDisplay]);

  const onMeasure = useCallback((key: string, height: number): void => {
    setHeights((current) => {
      if (current.get(key) === height) {
        return current;
      }
      const next = new Map(current);
      next.set(key, height);
      return next;
    });
  }, []);

  useEffect(() => {
    const validKeys = new Set(entries.map((entry) => entry.key));
    setHeights((current) => {
      if ([...current.keys()].every((key) => validKeys.has(key))) {
        return current;
      }
      return new Map([...current].filter(([key]) => validKeys.has(key)));
    });
  }, [entries]);

  const measuredHeights = entries.map((entry) => heights.get(entry.key));
  const allMeasured = measuredHeights.every((height) => height !== undefined);
  const numericHeights = allMeasured ? measuredHeights.map((height) => height ?? 0) : [];
  const totalHeight = numericHeights.reduce((sum, height) => sum + height, 0);
  const viewportHeight = Math.max(1, viewportMetrics.height);
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const clampedOffset = Math.min(scrollOffset, maxScroll);
  const previousGeometryRef = useRef<{ totalHeight: number; viewportHeight: number } | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!allMeasured) {
      return;
    }
    const previous = previousGeometryRef.current;
    previousGeometryRef.current = { totalHeight, viewportHeight };
    if (previous === undefined || scrollOffsetRef.current === 0) {
      return;
    }
    const delta = totalHeight - previous.totalHeight - (viewportHeight - previous.viewportHeight);
    if (delta !== 0) {
      setScrollOffset((current) => Math.min(Math.max(0, current + delta), maxScroll));
    }
  }, [allMeasured, maxScroll, totalHeight, viewportHeight]);

  const previousHistoryLengthRef = useRef(props.history.length);
  useEffect(() => {
    const previous = previousHistoryLengthRef.current;
    previousHistoryLengthRef.current = props.history.length;
    if (scrollOffsetRef.current > 0 && props.history.length > previous) {
      setUnseenHistory((current) => current + props.history.length - previous);
    }
  }, [props.history.length]);

  const liveSignature = `${props.live.streamingText.length}:${props.live.reasoningText.length}:${props.live.activeTools.length}:${props.live.compacting ? "1" : "0"}`;
  const previousLiveSignatureRef = useRef(liveSignature);
  useEffect(() => {
    if (scrollOffsetRef.current > 0 && previousLiveSignatureRef.current !== liveSignature) {
      setUnseenLive(true);
    }
    previousLiveSignatureRef.current = liveSignature;
  }, [liveSignature]);

  const clearUnseen = useCallback((): void => {
    setUnseenHistory(0);
    setUnseenLive(false);
  }, []);
  const flushPendingScroll = useCallback((): void => {
    scrollTimerRef.current = undefined;
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = undefined;
    if (pending === undefined) {
      return;
    }
    const clamped = coalesceScrollOffset(pending, maxScroll);
    setScrollOffset(clamped);
    if (clamped === 0) {
      clearUnseen();
    }
  }, [clearUnseen, maxScroll]);
  const scrollTo = useCallback(
    (next: number): void => {
      pendingScrollRef.current = next;
      if (scrollTimerRef.current !== undefined) {
        return;
      }
      scrollTimerRef.current = setTimeout(flushPendingScroll, SCROLL_COALESCE_MS);
    },
    [flushPendingScroll],
  );
  const scrollBy = useCallback(
    (delta: number): void => {
      const base = pendingScrollRef.current ?? scrollOffsetRef.current;
      scrollTo(base + delta);
    },
    [scrollTo],
  );
  const followTail = useCallback((): void => {
    // A hidden live entry may have changed height while the user was browsing history.
    setHeights(new Map());
    scrollTo(0);
  }, [scrollTo]);

  useInput(
    (input, key) => {
      const mouse = parseMouseWheelInput(input);
      if (mouse !== undefined) {
        props.onWheelScroll?.();
        const row = mouse.row - 1;
        if (
          viewportMetrics.hasMeasured &&
          row >= viewportMetrics.top &&
          row < viewportMetrics.top + viewportMetrics.height
        ) {
          scrollBy(mouse.direction === "up" ? MOUSE_SCROLL_ROWS : -MOUSE_SCROLL_ROWS);
        }
        return;
      }
      if (key.pageUp) {
        scrollBy(Math.max(1, viewportHeight - 2));
      } else if (key.pageDown) {
        scrollBy(-Math.max(1, viewportHeight - 2));
      } else if (key.ctrl && key.home) {
        scrollTo(maxScroll);
      } else if (key.ctrl && key.end) {
        followTail();
      }
    },
    { isActive: !props.navigationBlocked },
  );

  useEffect(() => {
    stdout.write(props.mouseTracking === false ? DISABLE_MOUSE_TRACKING : ENABLE_MOUSE_TRACKING);
    return () => {
      if (scrollTimerRef.current !== undefined) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = undefined;
      }
      stdout.write(DISABLE_MOUSE_TRACKING);
    };
  }, [stdout, props.mouseTracking]);

  const shouldWindow = allMeasured && entries.length > WINDOWING_THRESHOLD;
  const visible = shouldWindow
    ? computeVisibleWindow(numericHeights, viewportHeight, clampedOffset)
    : undefined;
  const visibleEntries =
    visible === undefined ? entries : entries.slice(visible.startIndex, visible.endIndex);
  const contentHeight = visible?.totalHeight ?? (allMeasured ? totalHeight : undefined);
  const contentChildren: ReactElement[] = [];
  if (visible !== undefined && visible.topSpacer > 0) {
    contentChildren.push(h(Box, { key: "top-spacer", height: visible.topSpacer, flexShrink: 0 }));
  }
  for (const entry of visibleEntries) {
    contentChildren.push(h(MeasuredEntry, { key: entry.key, entry, onMeasure }));
  }
  if (visible !== undefined && visible.bottomSpacer > 0) {
    contentChildren.push(
      h(Box, { key: "bottom-spacer", height: visible.bottomSpacer, flexShrink: 0 }),
    );
  }

  const notice =
    clampedOffset > 0 && (unseenHistory > 0 || unseenLive)
      ? unseenHistory > 0
        ? `↓ ${String(unseenHistory)} 条新内容 · Ctrl+End 返回底部`
        : "↓ 有新内容 · Ctrl+End 返回底部"
      : clampedOffset > 0
        ? "↓ Ctrl+End 返回底部"
        : undefined;

  return h(
    Box,
    { flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 1 },
    h(
      Box,
      {
        ref: viewportRef,
        flexDirection: "column",
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 1,
        overflowY: "hidden",
        justifyContent: "flex-end",
      },
      h(
        Box,
        {
          flexDirection: "column",
          flexShrink: 0,
          position: "relative",
          top: clampedOffset,
          ...(contentHeight === undefined ? {} : { height: contentHeight }),
        },
        ...contentChildren,
      ),
    ),
    notice === undefined
      ? null
      : h(Box, { flexShrink: 0, paddingLeft: 1 }, h(Text, { color: "cyan" }, notice)),
  );
}
