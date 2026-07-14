import { createElement as h, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { revealLogoLines, splitBannerLogoLines, type BannerLine } from "../banner.ts";

const FRAME_INTERVAL_MS = 50;
/** ~1.1s logo reveal, then rest lines stagger in at ~100ms intervals. */
const LOGO_FRAMES = 22;
const REST_STAGGER_FRAMES = 2;
const HIDDEN_LINE: BannerLine = { spans: [{ text: " " }] };

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function BannerLinesView({
  lines,
}: {
  readonly lines: readonly BannerLine[];
}): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    ...lines.map((line, index) =>
      h(
        Text,
        { key: String(index) },
        ...line.spans.map((span, spanIndex) =>
          h(
            Text,
            {
              key: String(spanIndex),
              ...(span.color !== undefined ? { color: span.color } : {}),
              ...(span.dim === true ? { dimColor: true } : {}),
            },
            span.text,
          ),
        ),
      ),
    ),
  );
}

/**
 * Animated banner entrance. Must be rendered OUTSIDE Ink's Static region (Static prints
 * each item exactly once, so interval-driven re-renders are never repainted there).
 * Calls `onSettled` once the animation completes (immediately when there is no logo),
 * letting the parent commit the final banner into Static.
 */
export function BannerHistoryView({
  lines,
  onSettled,
}: {
  readonly lines: readonly BannerLine[];
  readonly onSettled?: () => void;
}): ReactElement {
  const { logo, rest } = splitBannerLogoLines(lines);
  const shouldAnimate = logo.length > 0;
  const totalFrames = LOGO_FRAMES + REST_STAGGER_FRAMES * rest.length;
  const [frame, setFrame] = useState(0);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    if (!shouldAnimate) {
      onSettledRef.current?.();
      return;
    }
    let current = 0;
    const timer = setInterval(() => {
      current += 1;
      if (current >= totalFrames) {
        clearInterval(timer);
        setFrame(totalFrames);
        onSettledRef.current?.();
        return;
      }
      setFrame(current);
    }, FRAME_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [shouldAnimate, totalFrames]);

  if (!shouldAnimate || frame >= totalFrames) {
    return h(BannerLinesView, { lines });
  }

  const logoProgress = easeOutCubic(Math.min(1, frame / LOGO_FRAMES));
  const stagedRest = rest.map((line, index) =>
    frame >= LOGO_FRAMES + REST_STAGGER_FRAMES * index ? line : HIDDEN_LINE,
  );
  return h(BannerLinesView, { lines: [...revealLogoLines(logo, logoProgress), ...stagedRest] });
}
