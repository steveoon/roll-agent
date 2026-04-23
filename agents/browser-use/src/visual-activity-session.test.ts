import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Page } from "@roll-agent/browser";
import { setVisualActivityEnabledForTests } from "./visual-activity.ts";
import { VisualActivitySession } from "./visual-activity-session.ts";

function createPageTarget(
  name: string,
  options: {
    readonly closed?: boolean;
    readonly throwOnEvaluate?: boolean;
    readonly log?: Array<{ target: string; mode: unknown }>;
  } = {},
) {
  const evaluateCalls: unknown[][] = [];

  const page = {
    isClosed() {
      return options.closed ?? false;
    },
    async evaluate(...args: unknown[]) {
      if (options.throwOnEvaluate) {
        throw new Error(`evaluate failed for ${name}`);
      }

      evaluateCalls.push(args);
      options.log?.push({
        target: name,
        mode: (args[1] as { mode?: unknown } | undefined)?.mode,
      });
      return undefined;
    },
    locator() {
      throw new Error("locator() should not be used in this test");
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

describe("visual-activity-session", () => {
  it("clears the old target before continuing on a new page", async () => {
    setVisualActivityEnabledForTests(true);
    const log: Array<{ target: string; mode: unknown }> = [];
    const first = createPageTarget("first", { log });
    const second = createPageTarget("second", { log });
    const session = new VisualActivitySession(first.page);

    await session.begin("正在打开消息列表");
    await session.retarget(second.page);
    await session.begin("正在读取消息列表");

    assert.deepEqual(log, [
      { target: "first", mode: "begin" },
      { target: "first", mode: "clear" },
      { target: "second", mode: "begin" },
    ]);
    assert.equal(session.page, second.page);
    assert.equal(session.target, second.page);
  });

  it("succeed, fail and clear never throw when the target renderer fails", async () => {
    setVisualActivityEnabledForTests(true);
    const failing = createPageTarget("failing", { throwOnEvaluate: true });
    const session = new VisualActivitySession(failing.page);

    await assert.doesNotReject(async () => {
      assert.equal(await session.begin("正在读取消息列表"), false);
      assert.equal(await session.succeed("已读取 1 条消息"), false);
      assert.equal(await session.fail("读取失败"), false);
      assert.equal(await session.clear(), false);
    });
  });

  it("retarget updates the current page even when the previous page is already closed", async () => {
    setVisualActivityEnabledForTests(true);
    const closed = createPageTarget("closed", { closed: true });
    const next = createPageTarget("next");
    const session = new VisualActivitySession(closed.page);

    assert.equal(await session.retarget(next.page), true);
    assert.equal(session.page, next.page);
    assert.equal(session.target, next.page);
    assert.equal(next.getEvaluateCalls().length, 0);
  });
});
