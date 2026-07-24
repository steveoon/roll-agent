import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { ConfirmSelect } from "./confirm-select.ts";

const ANSI_STYLE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

test("confirmation treats its row budget as a ceiling instead of a fixed height", () => {
  const { lastFrame, unmount } = render(
    h(ConfirmSelect, {
      prompt: "执行 browser-use-agent.open_platform？",
      args: "platform: zhipin",
      width: 100,
      maxRows: 20,
      onDecide: () => {},
    }),
  );

  const lines = (lastFrame() ?? "").replace(ANSI_STYLE_PATTERN, "").split("\n");
  assert.equal(lines.length, 7);
  assert.match(lines.at(-2) ?? "", /^╰/u);
  assert.match(lines.at(-1) ?? "", /←→\/y\/n 选择/u);
  unmount();
});

test("compact confirmation stays inside its row budget", () => {
  const { lastFrame, unmount } = render(
    h(ConfirmSelect, {
      prompt: "执行 browser-use-agent.click_ref？这是一个会换行的长确认提示",
      args: "conversationId: 1234567890, selector: a-very-long-selector",
      width: 40,
      maxRows: 6,
      onDecide: () => {},
    }),
  );

  const lines = (lastFrame() ?? "").replace(ANSI_STYLE_PATTERN, "").split("\n");
  assert.ok(lines.length <= 6);
  assert.match(lines.at(-1) ?? "", /←→\/y\/n 选择/);
  unmount();
});
