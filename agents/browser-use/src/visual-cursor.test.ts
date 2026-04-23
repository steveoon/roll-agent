import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Page } from "@roll-agent/browser";
import {
  clearVisualCursor,
  isVisualCursorEnabled,
  moveVisualCursorToLocator,
  setVisualCursorEnabledForTests,
  showVisualClickOnLocator,
} from "./visual-cursor.ts";

type LocatorCall = "scroll" | "evaluate";

function createLocator(options: {
  point?: { x: number; y: number } | null;
}) {
  const calls: LocatorCall[] = [];

  const locator = {
    async scrollIntoViewIfNeeded() {
      calls.push("scroll");
    },
    async evaluate() {
      calls.push("evaluate");
      return options.point ?? null;
    },
  };

  return {
    locator: locator as unknown as ReturnType<Page["locator"]>,
    getCalls: () => calls,
  };
}

function createPage() {
  const evaluateCalls: unknown[] = [];
  const waits: number[] = [];
  const frames: Page[] = [];

  const page = {
    isClosed() {
      return false;
    },
    async evaluate(...args: unknown[]) {
      evaluateCalls.push(args);
      return undefined;
    },
    async waitForTimeout(ms: number) {
      waits.push(ms);
    },
    frames() {
      return frames;
    },
  };

  return {
    page: page as unknown as Page,
    getEvaluateCalls: () => evaluateCalls,
    getWaits: () => waits,
    setFrames: (nextFrames: Page[]) => {
      frames.length = 0;
      frames.push(...nextFrames);
    },
  };
}

function createTarget() {
  const evaluateCalls: unknown[] = [];
  const target = {
    async evaluate(...args: unknown[]) {
      evaluateCalls.push(args);
      return undefined;
    },
  };

  return {
    target: target as unknown as Page,
    getEvaluateCalls: () => evaluateCalls,
  };
}

afterEach(() => {
  setVisualCursorEnabledForTests(undefined);
});

describe("visual-cursor", () => {
  it("defaults to enabled when env is unset", () => {
    const previous = process.env["BROWSER_VISUAL_CURSOR"];
    delete process.env["BROWSER_VISUAL_CURSOR"];
    setVisualCursorEnabledForTests(undefined);

    try {
      assert.equal(isVisualCursorEnabled(), true);
    } finally {
      if (previous === undefined) {
        delete process.env["BROWSER_VISUAL_CURSOR"];
      } else {
        process.env["BROWSER_VISUAL_CURSOR"] = previous;
      }
    }
  });

  it("skips cursor movement when disabled", async () => {
    setVisualCursorEnabledForTests(false);
    const { page, getEvaluateCalls, getWaits } = createPage();
    const { locator, getCalls } = createLocator({ point: { x: 120, y: 240 } });

    const moved = await moveVisualCursorToLocator(page, locator);

    assert.equal(moved, false);
    assert.deepEqual(getCalls(), []);
    assert.deepEqual(getEvaluateCalls(), []);
    assert.deepEqual(getWaits(), []);
  });

  it("moves the cursor and waits for the animation when enabled", async () => {
    setVisualCursorEnabledForTests(true);
    const { page, getEvaluateCalls, getWaits } = createPage();
    const { locator, getCalls } = createLocator({ point: { x: 120, y: 240 } });

    const moved = await moveVisualCursorToLocator(page, locator, {
      durationMs: 100,
      settleMs: 25,
    });

    assert.equal(moved, true);
    assert.deepEqual(getCalls(), ["scroll", "evaluate"]);
    assert.equal(getEvaluateCalls().length, 1);
    assert.deepEqual(getWaits(), [125]);
  });

  it("clears stale cursors from other contexts before rendering into the active target", async () => {
    setVisualCursorEnabledForTests(true);
    const { page, setFrames, getEvaluateCalls, getWaits } = createPage();
    const frame = createTarget();
    setFrames([frame.target]);
    const { locator } = createLocator({ point: { x: 120, y: 240 } });

    const moved = await moveVisualCursorToLocator(page, locator, {
      durationMs: 100,
      settleMs: 25,
      target: frame.target,
    });

    assert.equal(moved, true);
    assert.equal(getEvaluateCalls().length, 1);
    assert.equal(frame.getEvaluateCalls().length, 1);
    assert.deepEqual(getWaits(), [125]);
  });

  it("shows a click pulse when enabled", async () => {
    setVisualCursorEnabledForTests(true);
    const { page, getEvaluateCalls, getWaits } = createPage();
    const { locator, getCalls } = createLocator({ point: { x: 88, y: 166 } });

    const shown = await showVisualClickOnLocator(page, locator);

    assert.equal(shown, true);
    assert.deepEqual(getCalls(), ["evaluate"]);
    assert.equal(getEvaluateCalls().length, 1);
    assert.deepEqual(getWaits(), [280]);
  });

  it("supports clearing all cursor overlays explicitly", async () => {
    setVisualCursorEnabledForTests(true);
    const { page, setFrames } = createPage();
    const frame = createTarget();
    setFrames([frame.target]);

    const cleared = await clearVisualCursor(page);

    assert.equal(cleared, true);
    assert.equal(frame.getEvaluateCalls().length, 1);
  });

  it("supports shorter click pulse durations", async () => {
    setVisualCursorEnabledForTests(true);
    const { page, getWaits } = createPage();
    const { locator } = createLocator({ point: { x: 88, y: 166 } });

    const shown = await showVisualClickOnLocator(page, locator, { pulseDurationMs: 160 });

    assert.equal(shown, true);
    assert.deepEqual(getWaits(), [160]);
  });
});
