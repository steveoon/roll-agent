import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeAutoLayoutGrid,
  computeAutoLayoutRows,
  resolveAutoWindowBoundsForIndex,
} from "./auto-window-layout.ts";

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 } as const;

describe("computeAutoLayoutGrid", () => {
  it("uses one row for 2–3 instances", () => {
    assert.deepEqual(computeAutoLayoutGrid(2), { cols: 2, rows: 1 });
    assert.deepEqual(computeAutoLayoutGrid(3), { cols: 3, rows: 1 });
  });

  it("uses 2×2 for 4 instances", () => {
    assert.deepEqual(computeAutoLayoutGrid(4), { cols: 2, rows: 2 });
  });

  it("adds rows after 4 instances", () => {
    assert.deepEqual(computeAutoLayoutGrid(5), { cols: 3, rows: 2 });
    assert.deepEqual(computeAutoLayoutGrid(6), { cols: 3, rows: 2 });
    assert.deepEqual(computeAutoLayoutGrid(7), { cols: 4, rows: 2 });
    assert.deepEqual(computeAutoLayoutGrid(8), { cols: 4, rows: 2 });
    assert.deepEqual(computeAutoLayoutGrid(9), { cols: 3, rows: 3 });
    assert.deepEqual(computeAutoLayoutGrid(10), { cols: 4, rows: 3 });
    assert.deepEqual(computeAutoLayoutGrid(13), { cols: 4, rows: 4 });
  });
});

describe("computeAutoLayoutRows", () => {
  it("keeps every row filled for 5+ instances", () => {
    assert.deepEqual(computeAutoLayoutRows(5), [3, 2]);
    assert.deepEqual(computeAutoLayoutRows(6), [3, 3]);
    assert.deepEqual(computeAutoLayoutRows(7), [4, 3]);
    assert.deepEqual(computeAutoLayoutRows(8), [4, 4]);
    assert.deepEqual(computeAutoLayoutRows(9), [3, 3, 3]);
    assert.deepEqual(computeAutoLayoutRows(10), [4, 3, 3]);
    assert.deepEqual(computeAutoLayoutRows(13), [4, 3, 3, 3]);
  });
});

describe("resolveAutoWindowBoundsForIndex", () => {
  it("tiles 2 instances side-by-side at full work-area height", () => {
    assert.deepEqual(resolveAutoWindowBoundsForIndex({ index: 0, total: 2, workArea: WORK_AREA }), {
      x: 0,
      y: 0,
      width: 960,
      height: 1080,
    });
    assert.deepEqual(resolveAutoWindowBoundsForIndex({ index: 1, total: 2, workArea: WORK_AREA }), {
      x: 960,
      y: 0,
      width: 960,
      height: 1080,
    });
  });

  it("tiles 3 instances side-by-side at full work-area height", () => {
    assert.deepEqual(resolveAutoWindowBoundsForIndex({ index: 0, total: 3, workArea: WORK_AREA }), {
      x: 0,
      y: 0,
      width: 640,
      height: 1080,
    });
    assert.deepEqual(resolveAutoWindowBoundsForIndex({ index: 2, total: 3, workArea: WORK_AREA }), {
      x: 1280,
      y: 0,
      width: 640,
      height: 1080,
    });
  });

  it("fills a 2×2 grid for 4 instances", () => {
    assert.deepEqual(resolveAutoWindowBoundsForIndex({ index: 0, total: 4, workArea: WORK_AREA }), {
      x: 0,
      y: 0,
      width: 960,
      height: 540,
    });
    assert.deepEqual(resolveAutoWindowBoundsForIndex({ index: 3, total: 4, workArea: WORK_AREA }), {
      x: 960,
      y: 540,
      width: 960,
      height: 540,
    });
  });

  it("lays out 5 instances as 3+2 rows", () => {
    assert.deepEqual(resolveAutoWindowBoundsForIndex({ index: 4, total: 5, workArea: WORK_AREA }), {
      x: 960,
      y: 540,
      width: 960,
      height: 540,
    });
  });

  it("uses balanced full-width rows for 10 instances instead of a tall 2-column stack", () => {
    assert.deepEqual(
      resolveAutoWindowBoundsForIndex({ index: 9, total: 10, workArea: WORK_AREA }),
      {
        x: 1280,
        y: 720,
        width: 640,
        height: 360,
      },
    );
  });

  it("distributes remainder pixels so the grid fills odd desktop sizes", () => {
    const oddWorkArea = { x: 0, y: 0, width: 1366, height: 769 } as const;

    assert.deepEqual(
      resolveAutoWindowBoundsForIndex({ index: 2, total: 3, workArea: oddWorkArea }),
      {
        x: 910,
        y: 0,
        width: 456,
        height: 769,
      },
    );
    assert.deepEqual(
      resolveAutoWindowBoundsForIndex({ index: 3, total: 4, workArea: oddWorkArea }),
      {
        x: 683,
        y: 384,
        width: 683,
        height: 385,
      },
    );
    assert.deepEqual(
      resolveAutoWindowBoundsForIndex({ index: 4, total: 5, workArea: oddWorkArea }),
      {
        x: 683,
        y: 384,
        width: 683,
        height: 385,
      },
    );
  });

  it("rejects invalid indexes instead of producing off-screen bounds", () => {
    assert.throws(
      () => resolveAutoWindowBoundsForIndex({ index: 5, total: 5, workArea: WORK_AREA }),
      RangeError,
    );
  });
});
