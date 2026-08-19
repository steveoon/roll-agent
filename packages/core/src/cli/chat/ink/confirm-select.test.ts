import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { ConfirmSelect } from "./confirm-select.ts";
import type { ConfirmDecision } from "./state.ts";
import type { FileChangeDiff } from "@roll-agent/runtime";

const ANSI_STYLE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const ESC = "\u001b";
const SESSION_LABEL = "本会话内不再询问：写入工作目录内的文件";
const EXTERNAL_SESSION_LABEL = "本会话内不再询问：roll__read_file 访问工作目录外的任意路径";

function stripAnsi(value: string): string {
  return value.replace(ANSI_STYLE_PATTERN, "");
}

const CONFIRM_DIFF: FileChangeDiff = {
  path: "src/a.ts",
  change: "modify",
  added: 3,
  removed: 1,
  hunks: 1,
  unified: [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,4 @@",
    " keep",
    "-old",
    "+n1",
    "+n2",
    "+n3",
    "",
  ].join("\n"),
  truncated: false,
};

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

test("compact confirmation keeps options and help visible and only offers Always with its label", () => {
  const renderCompact = (maxRows: number) => {
    const { lastFrame, unmount } = render(
      h(ConfirmSelect, {
        prompt: "执行 roll.write_file？",
        explanation: "写入 src/a.ts（12 行）",
        args: `file_path: src/a.ts content: ${"x".repeat(60)}`,
        sessionGrantLabel: SESSION_LABEL,
        width: 80,
        maxRows,
        onDecide: () => {},
      }),
    );
    const frame = (lastFrame() ?? "").replace(ANSI_STYLE_PATTERN, "");
    unmount();
    const lines = frame.split("\n");
    assert.ok(
      lines.length <= maxRows,
      `maxRows=${String(maxRows)} rendered ${String(lines.length)}`,
    );
    return {
      frame,
      optionLine: lines.find((line) => line.includes("Yes") && line.includes("No")) ?? "",
      helpLine: lines.at(-1) ?? "",
    };
  };

  const roomy = renderCompact(6);
  assert.match(roomy.optionLine, /Yes\s+Always\s+❯ No/u);
  assert.match(roomy.frame, new RegExp(SESSION_LABEL, "u"));
  assert.match(roomy.helpLine, /←→\/y\/a\/n 选择 · Enter · Esc · ⇧Tab 自动/u);

  for (const maxRows of [4, 3]) {
    const tight = renderCompact(maxRows);
    assert.match(tight.optionLine, /Yes\s+❯ No/u);
    assert.doesNotMatch(tight.optionLine, /Always/u);
    assert.doesNotMatch(tight.frame, new RegExp(SESSION_LABEL, "u"));
    assert.match(tight.helpLine, /←→\/y\/n 选择 · Enter · Esc · ⇧Tab 自动/u);
  }
});

test("compact confirmation without room for the label ignores the a shortcut", async () => {
  const decisions: ConfirmDecision[] = [];
  const { stdin, unmount } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.write_file？",
      explanation: "写入 src/a.ts（12 行）",
      args: "file_path: src/a.ts",
      sessionGrantLabel: SESSION_LABEL,
      width: 40,
      maxRows: 4,
      onDecide: (decision) => {
        decisions.push(decision);
      },
    }),
  );
  stdin.write("a");
  await delay(10);
  unmount();
  assert.deepEqual(decisions, []);
});

test("compact confirmation only offers Always when the external-path scope is fully visible", async () => {
  const narrowDecisions: ConfirmDecision[] = [];
  const narrow = render(
    h(ConfirmSelect, {
      prompt: "执行 roll__read_file？",
      args: "path: /tmp/harmless",
      sessionGrantLabel: EXTERNAL_SESSION_LABEL,
      width: 40,
      maxRows: 6,
      onDecide: (decision) => {
        narrowDecisions.push(decision);
      },
    }),
  );
  const narrowFrame = (narrow.lastFrame() ?? "").replace(ANSI_STYLE_PATTERN, "");
  assert.doesNotMatch(narrowFrame, /工作目录外的任意路径/u);
  assert.doesNotMatch(narrowFrame, /Always/u);
  assert.match(narrowFrame, /←→\/y\/n 选择/u);
  narrow.stdin.write("a");
  await delay(10);
  narrow.unmount();
  assert.deepEqual(narrowDecisions, []);

  const wideDecisions: ConfirmDecision[] = [];
  const wide = render(
    h(ConfirmSelect, {
      prompt: "执行 roll__read_file？",
      args: "path: /tmp/harmless",
      sessionGrantLabel: EXTERNAL_SESSION_LABEL,
      width: 100,
      maxRows: 6,
      onDecide: (decision) => {
        wideDecisions.push(decision);
      },
    }),
  );
  const wideFrame = (wide.lastFrame() ?? "").replace(ANSI_STYLE_PATTERN, "");
  assert.match(wideFrame, new RegExp(EXTERNAL_SESSION_LABEL, "u"));
  assert.match(wideFrame, /Always/u);
  assert.match(wideFrame, /←→\/y\/a\/n 选择/u);
  wide.stdin.write("a");
  await delay(10);
  wide.unmount();
  assert.deepEqual(wideDecisions, [{ approved: true, scope: "session" }]);
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
      width: 100,
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

test("expanded 布局内嵌 diff 头与正文，隐藏原始 args，选项行仍在框内最后一行", () => {
  const { lastFrame } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.edit_file?",
      args: 'file_path: src/a.ts\nedits: [{"old_string":"old","new_string":"n1\\nn2\\nn3"}]',
      explanation: "修改 src/a.ts：1 处编辑",
      diff: CONFIRM_DIFF,
      width: 80,
      maxRows: 20,
      onDecide: () => {},
    }),
  );
  const frame = stripAnsi(lastFrame() ?? "");
  assert.match(frame, /src\/a\.ts\s+\+3 −1/u);
  assert.match(frame, /-old/u);
  assert.match(frame, /\+n3/u);
  assert.doesNotMatch(frame, /old_string/u);
  const lines = frame.split("\n");
  const optionIndex = lines.findIndex((l) => /❯ No|Yes\s+❯ No/u.test(l) || l.includes("No"));
  const bottomBorder = lines.findIndex((l) => l.trimStart().startsWith("╰"));
  assert.ok(optionIndex !== -1 && bottomBorder !== -1 && optionIndex < bottomBorder);
  assert.ok(lines.length <= 20);
});

test("expanded 布局行预算不足时截断 diff 正文并提示剩余行数，选项行不被挤出", () => {
  const { lastFrame } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.edit_file?",
      args: "",
      diff: CONFIRM_DIFF,
      width: 80,
      maxRows: 12,
      onDecide: () => {},
    }),
  );
  const frame = stripAnsi(lastFrame() ?? "");
  const lines = frame.split("\n");
  assert.ok(lines.length <= 12);
  assert.match(frame, /另 \d+ 行/u);
  assert.ok(lines.some((l) => l.includes("Yes")));
});

test("compact 布局只显示 diff 头行", () => {
  const { lastFrame } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.edit_file?",
      args: "file_path: src/a.ts",
      diff: CONFIRM_DIFF,
      width: 80,
      maxRows: 6,
      onDecide: () => {},
    }),
  );
  const frame = stripAnsi(lastFrame() ?? "");
  assert.match(frame, /src\/a\.ts\s+\+3 −1/u);
  assert.doesNotMatch(frame, /\+n1/u);
  assert.ok(frame.split("\n").length <= 6);
});

test("compact 行预算紧张时 diff 头行优先于说明第二行", () => {
  const { lastFrame } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.edit_file?",
      args: "file_path: src/a.ts",
      explanation: "修改 src/a.ts：1 处编辑，顺便补一句很长的说明文字以确保第二行存在",
      sessionGrantLabel: "本会话内不再询问：修改工作目录内的文件",
      diff: CONFIRM_DIFF,
      width: 80,
      maxRows: 6,
      onDecide: () => {},
    }),
  );
  const frame = stripAnsi(lastFrame() ?? "");
  const lines = frame.split("\n");
  assert.match(frame, /src\/a\.ts\s+\+3 −1/u);
  assert.ok(lines.length <= 6);
  assert.ok(lines.some((line) => line.includes("Yes")));
});

test("compact 无 diff 时说明第二行 / 标签仍优先于 args 行（现状不变）", () => {
  const { lastFrame } = render(
    h(ConfirmSelect, {
      prompt: "执行 roll.edit_file?",
      args: "file_path: src/a.ts",
      explanation: "修改 src/a.ts：1 处编辑，顺便补一句很长的说明文字以确保第二行存在",
      sessionGrantLabel: "本会话内不再询问：修改工作目录内的文件",
      width: 80,
      maxRows: 6,
      onDecide: () => {},
    }),
  );
  const frame = stripAnsi(lastFrame() ?? "");
  assert.doesNotMatch(frame, /file_path: src\/a\.ts/u);
  assert.ok(frame.split("\n").length <= 6);
  assert.match(frame, /本会话内不再询问：修改工作目录内的文件/u);
});
