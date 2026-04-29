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
    const clickPreviews: Array<{ readonly x: number; readonly y: number }> = [];
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
          async previewMouseClick(preview) {
            clickPreviews.push(preview.point);
          },
        },
      },
    );

    assert.equal(previews.length, 1);
    assert.deepEqual(clickPreviews, [{ x: 180, y: 220 }]);
    assert.equal(previews[0], events.filter((event) => event.type === "mouseMoved").length);
    assert.equal(events.at(-2)?.type, "mousePressed");
    assert.equal(events.at(-1)?.type, "mouseReleased");
    assert.equal(events.at(-1)?.x, 180);
    assert.equal(events.at(-1)?.y, 220);
  });

  it("uses a visible default movement duration", async () => {
    const durations: number[] = [];
    const controller = new NativeMouseMotionController(
      {
        async dispatchMouseEvent() {},
      },
      {
        sleep: async () => {},
      },
    );

    await controller.moveTo(
      { x: 320, y: 240 },
      {
        motionObserver: {
          async previewMouseMotion(preview) {
            durations.push(preview.durationMs);
          },
        },
      },
    );

    assert.equal(durations.length, 1);
    const duration = durations[0];
    if (duration === undefined) {
      assert.fail("expected a preview duration");
    }
    assert.equal(duration >= 220, true);
  });
});
