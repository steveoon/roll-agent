import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectDynamicListItems,
  type DynamicListSnapshot,
  type DynamicListTarget,
} from "./dynamic-list-scroller.ts";

type Item = {
  readonly id: string;
};

const boundarySnapshot: DynamicListSnapshot = {
  containerFound: true,
  containerLabel: ".list",
  scrollTop: 100,
  scrollHeight: 200,
  clientHeight: 100,
  itemCount: 1,
  atStart: false,
  atEnd: true,
};

function createTarget(snapshots: readonly DynamicListSnapshot[]): DynamicListTarget {
  let index = 0;
  return {
    async evaluate() {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      if (!snapshot) throw new Error("Missing test snapshot");
      return snapshot;
    },
    async waitForTimeout() {},
  } as DynamicListTarget;
}

describe("dynamic list scroller", () => {
  it("waits at the boundary for delayed dynamic items before stopping", async () => {
    let readCalls = 0;
    const result = await collectDynamicListItems<Item>(
      createTarget([
        boundarySnapshot,
        {
          ...boundarySnapshot,
          scrollHeight: 300,
          itemCount: 2,
        },
      ]),
      { containerSelectors: [".list"], itemSelector: ".item" },
      async () => {
        readCalls += 1;
        return readCalls === 1 ? [{ id: "a" }] : [{ id: "a" }, { id: "b" }];
      },
      (item) => item.id,
      {
        targetCount: 2,
        steps: 3,
        boundaryLoadRetries: 1,
        boundarySettleMs: 0,
      },
    );

    assert.equal(result.uniqueCount, 2);
    assert.equal(result.stepsCompleted, 0);
    assert.equal(result.stopReason, "target-count");
  });

  it("reports boundary when touching the end does not add items", async () => {
    const result = await collectDynamicListItems<Item>(
      createTarget([boundarySnapshot, boundarySnapshot]),
      { containerSelectors: [".list"], itemSelector: ".item" },
      async () => [{ id: "a" }],
      (item) => item.id,
      {
        targetCount: 2,
        steps: 3,
        boundaryLoadRetries: 1,
        boundarySettleMs: 0,
      },
    );

    assert.equal(result.uniqueCount, 1);
    assert.equal(result.stepsCompleted, 0);
    assert.equal(result.stopReason, "boundary");
  });
});
