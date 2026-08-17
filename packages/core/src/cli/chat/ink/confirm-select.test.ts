import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { ConfirmSelect } from "./confirm-select.ts";
import type { ConfirmDecision } from "./state.ts";

const ANSI_STYLE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const ESC = "\u001b";
const SESSION_LABEL = "本会话内不再询问：写入工作目录内的文件";

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
  assert.ok(lines.length <= 7);
  assert.match(lines.at(-2) ?? "", /^╰/u);
  assert.match(lines.at(-1) ?? "", /←→\/y\/n 选择/u);
  assert.doesNotMatch(lastFrame() ?? "", /Always/u);
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
  assert.doesNotMatch(optionLine, /Always/u);
  assert.match(lines.at(-1) ?? "", /←→\/y\/n 选择 · Enter · Esc · ⇧Tab 自动/u);
  unmount();
});

async function decideAfter(
  inputs: readonly string[],
  sessionGrantLabel?: string,
): Promise<ConfirmDecision[]> {
  const decisions: ConfirmDecision[] = [];
  const { stdin, unmount } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.bash?",
      args: "command: pnpm test",
      width: 40,
      maxRows: 6,
      ...(sessionGrantLabel !== undefined ? { sessionGrantLabel } : {}),
      onDecide: (decision) => {
        decisions.push(decision);
      },
    }),
  );
  for (const input of inputs) {
    stdin.write(input);
    await delay(input === ESC ? 100 : 10);
  }
  unmount();
  return decisions;
}

test("confirmation keeps default No and y/n/Esc shortcuts", async () => {
  assert.deepEqual(await decideAfter(["\r"]), [{ approved: false }]);
  assert.deepEqual(await decideAfter(["y"]), [{ approved: true }]);
  assert.deepEqual(await decideAfter(["Y"]), [{ approved: true }]);
  assert.deepEqual(await decideAfter(["n"]), [{ approved: false }]);
  assert.deepEqual(await decideAfter(["N"]), [{ approved: false }]);
  assert.deepEqual(await decideAfter([ESC]), [{ approved: false }]);
});

test("无 sessionGrantLabel 时 a 无效且不渲染 Always", async () => {
  const { lastFrame, unmount } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.bash?",
      args: "command: pnpm test",
      width: 80,
      maxRows: 20,
      onDecide: () => {},
    }),
  );
  assert.doesNotMatch(lastFrame() ?? "", /Always/u);
  assert.doesNotMatch(lastFrame() ?? "", /a 允许并且本会话内不再询问/u);
  unmount();
  assert.deepEqual(await decideAfter(["a"]), []);
});

test("有 sessionGrantLabel 时渲染三选项与 label，a 写入 session", async () => {
  const { lastFrame, unmount } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.write_file?",
      args: "file_path: a.ts",
      sessionGrantLabel: SESSION_LABEL,
      width: 100,
      maxRows: 20,
      onDecide: () => {},
    }),
  );
  assert.match(lastFrame() ?? "", /Always/u);
  assert.match(lastFrame() ?? "", new RegExp(SESSION_LABEL, "u"));
  unmount();
  assert.deepEqual(await decideAfter(["a"], SESSION_LABEL), [{ approved: true, scope: "session" }]);
  assert.deepEqual(await decideAfter(["A"], SESSION_LABEL), [{ approved: true, scope: "session" }]);
});

test("all arrow keys move the selection to Yes before Enter", async () => {
  for (const arrow of [`${ESC}[D`, `${ESC}[C`, `${ESC}[A`, `${ESC}[B`]) {
    assert.deepEqual(await decideAfter([arrow, "\r"]), [{ approved: true }]);
  }
});

test("有 label 时右/下按视觉顺序 Yes · Always · No 循环，左/上反向", async () => {
  const right = `${ESC}[C`;
  const left = `${ESC}[D`;
  assert.deepEqual(await decideAfter([right, "\r"], SESSION_LABEL), [{ approved: true }]);
  assert.deepEqual(await decideAfter([right, right, "\r"], SESSION_LABEL), [
    { approved: true, scope: "session" },
  ]);
  assert.deepEqual(await decideAfter([right, right, right, "\r"], SESSION_LABEL), [
    { approved: false },
  ]);
  assert.deepEqual(await decideAfter([left, "\r"], SESSION_LABEL), [
    { approved: true, scope: "session" },
  ]);
});

test("expanded help row explains the session-remember option only with label", () => {
  const { lastFrame, unmount } = render(
    h(ConfirmSelect, {
      prompt: "执行 browser-use-agent.open_platform？",
      args: "platform: zhipin",
      sessionGrantLabel: SESSION_LABEL,
      width: 100,
      maxRows: 20,
      onDecide: () => {},
    }),
  );
  assert.match(lastFrame() ?? "", /a 允许并且本会话内不再询问/u);
  unmount();
});
