import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Page } from "@roll-agent/browser";
import {
  beginVisualActivity,
  completeVisualActivity,
  highlightVisualRegionForLocator,
  isVisualActivityEnabled,
  setVisualActivityEnabledForTests,
} from "./visual-activity.ts";

type LocatorCall = "scroll" | "evaluate";

function createLocator(options: {
  rect?: { x: number; y: number; width: number; height: number } | null;
}) {
  const calls: LocatorCall[] = [];

  const locator = {
    async scrollIntoViewIfNeeded() {
      calls.push("scroll");
    },
    async evaluate() {
      calls.push("evaluate");
      return options.rect ?? null;
    },
  };

  return {
    locator: locator as unknown as ReturnType<Page["locator"]>,
    getCalls: () => calls,
  };
}

function createPage() {
  const evaluateCalls: unknown[] = [];

  const page = {
    isClosed() {
      return false;
    },
    async evaluate(...args: unknown[]) {
      evaluateCalls.push(args);
      return undefined;
    },
  };

  return {
    page: page as unknown as Page,
    getEvaluateCalls: () => evaluateCalls,
  };
}

afterEach(() => {
  setVisualActivityEnabledForTests(undefined);
});

describe("visual-activity", () => {
  it("defaults to enabled when env is unset", () => {
    const previous = process.env["BROWSER_VISUAL_ACTIVITY"];
    delete process.env["BROWSER_VISUAL_ACTIVITY"];
    setVisualActivityEnabledForTests(undefined);

    try {
      assert.equal(isVisualActivityEnabled(), true);
    } finally {
      if (previous === undefined) {
        delete process.env["BROWSER_VISUAL_ACTIVITY"];
      } else {
        process.env["BROWSER_VISUAL_ACTIVITY"] = previous;
      }
    }
  });

  it("skips rendering activity when disabled", async () => {
    setVisualActivityEnabledForTests(false);
    const { page, getEvaluateCalls } = createPage();

    const started = await beginVisualActivity(page, { label: "正在读取消息列表" });

    assert.equal(started, false);
    assert.deepEqual(getEvaluateCalls(), []);
  });

  it("shows the activity capsule when enabled", async () => {
    setVisualActivityEnabledForTests(true);
    const { page, getEvaluateCalls } = createPage();

    const started = await beginVisualActivity(page, { label: "正在读取消息列表" });

    assert.equal(started, true);
    assert.equal(getEvaluateCalls().length, 1);
  });

  it("highlights a region when enabled", async () => {
    setVisualActivityEnabledForTests(true);
    const { page, getEvaluateCalls } = createPage();
    const { locator, getCalls } = createLocator({
      rect: { x: 24, y: 80, width: 320, height: 480 },
    });

    const highlighted = await highlightVisualRegionForLocator(page, locator, {
      label: "正在读取消息列表",
      padding: 10,
    });

    assert.equal(highlighted, true);
    assert.deepEqual(getCalls(), ["scroll", "evaluate"]);
    assert.equal(getEvaluateCalls().length, 1);
  });

  it("shows a completion state when enabled", async () => {
    setVisualActivityEnabledForTests(true);
    const { page, getEvaluateCalls } = createPage();

    const completed = await completeVisualActivity(page, {
      label: "已读取 40 条消息",
    });

    assert.equal(completed, true);
    assert.equal(getEvaluateCalls().length, 1);
  });
});
