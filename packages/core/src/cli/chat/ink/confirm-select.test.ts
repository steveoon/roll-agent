import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
      explanation:
        "运行当前包的完整测试套件并检查所有边界行为，确认这次交互调整没有破坏已有功能或改变审批语义",
      args: `command: pnpm --filter @roll-agent/core test -- --runInBand ${"very-long-argument-".repeat(4)}`,
      width: 40,
      maxRows: 6,
      onDecide: () => {},
    }),
  );

  const frame = (lastFrame() ?? "").replace(ANSI_STYLE_PATTERN, "");
  const lines = frame.split("\n");
  const optionLine = lines.find((line) => line.includes("Yes") && line.includes("No")) ?? "";
  assert.ok(lines.length <= 6);
  assert.match(frame, /AI 说明：/u);
  assert.match(frame, /command: pnpm/u);
  assert.match(optionLine, /Yes\s+❯ No/u);
  assert.match(lines.at(-1) ?? "", /←→\/y\/n 选择 · Enter · Esc · ⇧Tab 自动/u);
  unmount();
});

async function decideAfter(inputs: readonly string[]): Promise<boolean[]> {
  const decisions: boolean[] = [];
  const { stdin, unmount } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.bash?",
      args: "command: pnpm test",
      width: 40,
      maxRows: 6,
      onDecide: (approved) => {
        decisions.push(approved);
      },
    }),
  );
  for (const input of inputs) {
    stdin.write(input);
    await delay(input === "\u001b" ? 100 : 10);
  }
  unmount();
  return decisions;
}

test("confirmation keeps default No and y/n/Esc shortcuts", async () => {
  assert.deepEqual(await decideAfter(["\r"]), [false]);
  assert.deepEqual(await decideAfter(["y"]), [true]);
  assert.deepEqual(await decideAfter(["Y"]), [true]);
  assert.deepEqual(await decideAfter(["n"]), [false]);
  assert.deepEqual(await decideAfter(["N"]), [false]);
  assert.deepEqual(await decideAfter(["\u001b"]), [false]);
});

test("all arrow keys move the selection to Yes before Enter", async () => {
  for (const arrow of ["\u001b[D", "\u001b[C", "\u001b[A", "\u001b[B"]) {
    assert.deepEqual(await decideAfter([arrow, "\r"]), [true]);
  }
});
