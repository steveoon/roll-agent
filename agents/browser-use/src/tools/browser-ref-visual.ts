import type { BrowserElementRefTarget, NativeCdpController } from "@roll-agent/browser";
import { NativeMouseMotionController } from "../native-mouse-motion.ts";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";

export type BrowserRefVisualSession = Pick<
  NativeVisualActivitySession,
  "begin" | "succeed" | "fail" | "previewMouseMotion" | "previewMouseClick"
>;

export function createBrowserRefVisualSession(
  controller: Pick<NativeCdpController, "evaluateJson">,
): BrowserRefVisualSession {
  return new NativeVisualActivitySession(controller);
}

export async function clickBrowserRefVisualTarget(
  controller: Pick<NativeCdpController, "dispatchMouseEvent">,
  session: BrowserRefVisualSession,
  target: BrowserElementRefTarget,
): Promise<void> {
  const mouse = new NativeMouseMotionController(controller);
  await mouse.click(
    { x: target.x, y: target.y },
    {
      motionObserver: session,
    },
  );
}
