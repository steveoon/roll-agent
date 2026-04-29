import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NativeCdpMouseEventInput } from "@roll-agent/browser";
import { createNativeMousePath, NativeMouseMotionController } from "./native-mouse-motion.ts";

describe("NativeMouseMotionController", () => {
  it("creates a multi-step path that ends exactly at the target", () => {
    const path = createNativeMousePath({ x: 20, y: 30 }, { x: 240, y: 180 });

    assert.equal(path[0]?.x, 20);
    assert.equal(path[0]?.y, 30);
    assert.equal(path.at(-1)?.x, 240);
    assert.equal(path.at(-1)?.y, 180);
    assert.equal(path.length > 3, true);
  });

  it("dispatches native mouse movement before press and release", async () => {
    const events: NativeCdpMouseEventInput[] = [];
    const previews: number[] = [];
    const controller = new NativeMouseMotionController(
      {
        async dispatchMouseEvent(input) {
          events.push(input);
        },
      },
      {
        sleep: async () => {},
        stepDelayMs: 12,
      },
    );

    await controller.click(
      { x: 180, y: 220 },
      {
        motionObserver: {
          async previewMouseMotion(preview) {
            previews.push(preview.points.length);
          },
        },
      },
    );

    assert.equal(previews.length, 1);
    assert.equal(previews[0], events.filter((event) => event.type === "mouseMoved").length);
    assert.equal(events.at(-2)?.type, "mousePressed");
    assert.equal(events.at(-1)?.type, "mouseReleased");
    assert.equal(events.at(-1)?.x, 180);
    assert.equal(events.at(-1)?.y, 220);
  });
});
