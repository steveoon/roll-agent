import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { Markdown } from "./markdown.ts";
import { displayWidth } from "./display-width.ts";

test("Markdown renders headings/bold/code/list/quote without literal syntax", () => {
  const { lastFrame, unmount } = render(
    h(Markdown, {
      text: "## 标题\n\n**加粗** 与 `代码`\n\n- 一 **强调**\n- 二\n\n> 引用一句",
    }),
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /标题/);
  assert.match(frame, /加粗/);
  assert.match(frame, /代码/);
  assert.match(frame, /一/);
  assert.match(frame, /二/);
  assert.match(frame, /•/);
  assert.match(frame, /│/);
  assert.match(frame, /引用一句/);
  assert.doesNotMatch(frame, /\*\*/);
  assert.doesNotMatch(frame, /## /);
  unmount();
});

test("Markdown renders an ordered list with numbers", () => {
  const { lastFrame, unmount } = render(h(Markdown, { text: "1. 甲\n2. 乙" }));
  const frame = lastFrame() ?? "";
  assert.match(frame, /1\. /);
  assert.match(frame, /2\. /);
  assert.match(frame, /甲/);
  assert.match(frame, /乙/);
  unmount();
});

test("Markdown renders a GFM table aligned, not as raw pipes", () => {
  const { lastFrame, unmount } = render(
    h(Markdown, {
      text: "| 字段 | 状态 |\n|------|------|\n| 招聘类型 | ✅ 社招全职 |\n| 薪资 | ❌ 待填写 |",
    }),
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /字段/);
  assert.match(frame, /状态/);
  assert.match(frame, /招聘类型/);
  assert.match(frame, /社招全职/);
  assert.doesNotMatch(frame, /\|---/);
  assert.doesNotMatch(frame, /\| 招聘类型 \|/);
  unmount();
});

test("Markdown table aligns CJK/codespan/emphasis cells by display width", () => {
  const { lastFrame, unmount } = render(
    h(Markdown, {
      text: "| 项目 | 值 |\n|---|---|\n| 短 | a |\n| 很长很长的项目·条目 | b |\n| `code` | c |\n| **强调** | d |",
    }),
  );
  const frame = lastFrame() ?? "";
  const lines = frame.split("\n");
  const offsets = ["a", "b", "c", "d"].map((mark) => {
    const line = lines.find((candidate) => candidate.trimEnd().endsWith(mark)) ?? "";
    return displayWidth(line.slice(0, line.lastIndexOf(mark)));
  });
  assert.equal(new Set(offsets).size, 1, `column offsets diverge: ${offsets.join(",")}`);
  unmount();
});

test("Markdown falls back to plain text on weird input", () => {
  const { lastFrame, unmount } = render(h(Markdown, { text: "纯文本无标记" }));
  assert.match(lastFrame() ?? "", /纯文本无标记/);
  unmount();
});

test("列表项与引用块的长文本在固定宽度内换行，不会多出一列", () => {
  const body =
    "packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts：末尾新增镜像用例「write_file 工作目录外路径在策略门之前不触碰文件系统」，deny 策略下对已存在未读的 secret.txt 与 missing.txt 各执行一次";
  for (const text of [`- ${body}`, `1. ${body}`, `> ${body}`]) {
    const { lastFrame, unmount } = render(
      h(Box, { width: 91 }, h(Box, { marginLeft: 1 }, h(Markdown, { text }))),
    );
    try {
      const lines = stripVTControlCharacters(lastFrame() ?? "").split("\n");
      for (const line of lines) {
        assert.ok(displayWidth(line) <= 91, `超宽: ${String(displayWidth(line))} ${line}`);
      }
      assert.ok(lines.length >= 2);
    } finally {
      unmount();
    }
  }
});

test("表格宽于终端时分隔线单行截断而不是折成多行", () => {
  const text = [
    "| 命令 | 结果 |",
    "| --- | --- |",
    "| node --experimental-strip-types --test packages/core/src/cli/chat/ink/confirm-select.test.ts | 16 pass / 0 fail（含新增 2 条） |",
  ].join("\n");
  const { lastFrame, unmount } = render(h(Box, { width: 60 }, h(Markdown, { text })));
  try {
    const lines = stripVTControlCharacters(lastFrame() ?? "").split("\n");
    const separatorLines = lines.filter((line) => /^[\s─]+$/u.test(line) && line.includes("─"));
    assert.equal(separatorLines.length, 1);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 60, `超宽: ${line}`);
    }
  } finally {
    unmount();
  }
});

test("Markdown 知道可用宽度时，超宽表格的列按整数缩放到恰好放下，任何一行都不超宽", () => {
  const text = [
    "| 命令 | 结果 |",
    "| --- | --- |",
    "| node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts packages/runtime/src/tool-bridge/file-tools/edit-file-tool.test.ts | 53 pass / 0 fail（write_file 22 条含新增外部路径用例、edit_file 31 条，duration_ms≈194） |",
  ].join("\n");
  for (const width of [91, 80, 60]) {
    const { lastFrame, unmount } = render(
      h(Box, { width }, h(Box, { marginLeft: 1 }, h(Markdown, { text, width: width - 1 }))),
    );
    try {
      for (const line of stripVTControlCharacters(lastFrame() ?? "").split("\n")) {
        assert.ok(displayWidth(line) <= width, `width ${String(width)} 超宽: ${line}`);
      }
    } finally {
      unmount();
    }
  }
});

test("表格单元格折行时列间距仍然保留", () => {
  const text = [
    "| 命令 | 结果 |",
    "| --- | --- |",
    "| node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts | 合计 53 条全部通过，新增的外部路径用例均绿 |",
  ].join("\n");
  const { lastFrame, unmount } = render(h(Box, { width: 60 }, h(Markdown, { text, width: 60 })));
  try {
    const lines = stripVTControlCharacters(lastFrame() ?? "").split("\n");
    const bodyLines = lines.filter((line) => /合计|全部通过|均绿|条/u.test(line));
    assert.ok(bodyLines.length >= 1);
    for (const line of bodyLines) {
      assert.match(line, /\S  +\S/u, `列间应有空隙: ${line}`);
    }
  } finally {
    unmount();
  }
});
