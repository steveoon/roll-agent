import { createElement as h, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 80;

export function Spinner(): ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, FRAME_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return h(Text, { color: "cyan" }, FRAMES[frame] ?? FRAMES[0]);
}
