import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChatLayout } from "./layout.ts";

test("resolveChatLayout bounds prompt and popup while preserving a transcript viewport", () => {
  const normal = resolveChatLayout(120, 40);
  assert.deepEqual(normal, {
    columns: 120,
    rows: 40,
    renderRows: 39,
    contentWidth: 118,
    promptRows: 12,
    popupRows: 8,
    showHelp: true,
    tooSmall: false,
  });

  const compact = resolveChatLayout(60, 10);
  assert.equal(compact.renderRows, 9);
  assert.equal(compact.promptRows, 3);
  assert.equal(compact.popupRows, 3);
  assert.equal(compact.showHelp, false);
  assert.equal(compact.tooSmall, false);
});

test("resolveChatLayout reports terminals below the supported viewport", () => {
  assert.equal(resolveChatLayout(39, 20).tooSmall, true);
  assert.equal(resolveChatLayout(80, 9).tooSmall, true);
});
