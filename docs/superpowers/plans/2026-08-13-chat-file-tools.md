# roll chat 内建文件工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 roll chat 新增四个内建文件工具（`roll__read_file` / `roll__edit_file` / `roll__write_file` / `roll__list_dir`），按「状态同步协议」设计：读写契约耦合、失败携带纠错诊断、成功免验证、Unicode 归一化容错、read-before-edit 与 stale 检测。

**Architecture:** 全部代码落在 `packages/runtime/src/tool-bridge/file-tools/` 新目录，按既有内建工具模式（参照 `bash-tool.ts` / `skill-tool.ts`）：Zod schema + `tool()` + `ToolExecutionPlan`（prepare 走 `gateToolCall` 审批门，resources 声明 `file:` 资源键）+ `normalizeToolResult` 家族构造返回。基建层（归一化、匹配管线、状态跟踪、文件 IO）与工具层分离，各自独立测试。设计依据见 `docs/chat-file-tools-design.md`。

**Tech Stack:** TypeScript（Node.js Type Stripping 直跑 .ts）、zod、ai（AI SDK v6 `tool()`）、node:test + node:assert/strict、node:fs / node:crypto。

## Global Constraints

- Node.js ≥22.6.0；开发运行 `node --experimental-strip-types`
- `erasableSyntaxOnly`：禁 enum/namespace/构造器参数属性，用 `as const` 对象
- 导入相对路径**必须**带 `.ts` 扩展名；类型导入用 `import type`
- 零 `any`；`exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess` 开启（索引访问返回 `T | undefined`，必须收窄）
- **核心代码零注释**——WHAT/WHY 靠命名表达
- if/else **必须**加花括号，单行也不省略
- Prettier：双引号、分号、尾逗号、100 字符行宽
- 测试文件与源码同目录，命名 `*.test.ts`；单文件跑法：`node --experimental-strip-types --test <path>`
- 每个 commit message 结尾加：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- GitNexus 纪律：修改**既有**符号前先跑 `impact({target, direction: "upstream"})`（Task 8/9 涉及）；本计划新增文件不需要
- 工具返回给模型的所有文案用中文（与 `bash-tool.ts` 既有文案风格一致）

## File Structure

```
packages/runtime/src/tool-bridge/file-tools/
  settings.ts               共享类型 + 默认值解析（防循环 import）
  text-normalize.ts         Unicode 归一化 + index map          （Task 1）
  match-pipeline.ts         匹配管线 + 行渲染 + 失败诊断        （Task 2）
  file-io.ts                路径解析/加载/保存/二进制与 BOM     （Task 3）
  file-state-tracker.ts     内容 hash 状态跟踪                  （Task 3）
  read-file-tool.ts         roll__read_file                     （Task 4）
  list-dir-tool.ts          roll__list_dir                      （Task 5）
  edit-file-tool.ts         roll__edit_file                     （Task 6）
  write-file-tool.ts        roll__write_file                    （Task 7）
  index.ts                  buildFileToolset 组装               （Task 8）
修改：
  packages/runtime/src/engine/capability-manifest.ts             （Task 8）
  packages/runtime/src/engine/agent-session.ts                   （Task 8）
  packages/runtime/src/engine/conversation-engine.ts             （Task 8）
  packages/runtime/src/engine/system-prompt.ts                   （Task 9）
```

---

### Task 1: 归一化模块 text-normalize.ts

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/text-normalize.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/text-normalize.test.ts`

**Interfaces:**
- Consumes: 无（叶子模块）
- Produces: `interface NormalizedText { readonly text: string; readonly map: readonly number[] }`；`function normalizeForMatch(input: string): NormalizedText`。`map[i]` 是归一化文本第 i 个 UTF-16 code unit 在原文中的下标。Task 2 依赖此契约将归一化命中切回原文字节区间。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForMatch } from "./text-normalize.ts";

test("CRLF 折叠为 LF 且映射指回原文", () => {
  const result = normalizeForMatch("a\r\nb");
  assert.equal(result.text, "a\nb");
  assert.deepEqual(result.map, [0, 2, 3]);
});

test("全角标点与智能引号折叠为半角", () => {
  const result = normalizeForMatch("你好，“世界”！");
  assert.equal(result.text, '你好,"世界"!');
});

test("全角空格与 NBSP 折叠为半角空格", () => {
  assert.equal(normalizeForMatch("a　b c").text, "a b c");
});

test("破折号族折叠为连字符", () => {
  assert.equal(normalizeForMatch("a—b–c―d").text, "a-b-c-d");
});

test("顿号与省略号保持原样", () => {
  assert.equal(normalizeForMatch("甲、乙…").text, "甲、乙…");
});

test("代理对字符原样保留且映射逐单元对应", () => {
  const result = normalizeForMatch("\u{1F600}");
  assert.equal(result.text, "\u{1F600}");
  assert.deepEqual(result.map, [0, 1]);
});

test("映射能将归一化命中切回原文区间", () => {
  const original = "前缀“内容”后缀";
  const { text, map } = normalizeForMatch(original);
  const needle = '"内容"';
  const start = text.indexOf(needle);
  const origStart = map[start];
  const lastMapped = map[start + needle.length - 1];
  assert.ok(origStart !== undefined && lastMapped !== undefined);
  assert.equal(original.slice(origStart, lastMapped + 1), "“内容”");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/text-normalize.test.ts`
Expected: FAIL（模块不存在，`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3: 写实现**

```ts
const CHAR_FOLD: Readonly<Record<string, string>> = {
  " ": " ",
  "　": " ",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "—": "-",
  "–": "-",
  "―": "-",
  "，": ",",
  "：": ":",
  "；": ";",
  "！": "!",
  "？": "?",
  "（": "(",
  "）": ")",
  "．": ".",
};

export interface NormalizedText {
  readonly text: string;
  readonly map: readonly number[];
}

export function normalizeForMatch(input: string): NormalizedText {
  let text = "";
  const map: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    if (char === "\r") {
      continue;
    }
    text += CHAR_FOLD[char] ?? char;
    map.push(index);
  }
  return { text, map };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/text-normalize.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/text-normalize.ts packages/runtime/src/tool-bridge/file-tools/text-normalize.test.ts
git commit -m "feat(runtime): add unicode fold normalization with index map for file tools

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 匹配管线与诊断 match-pipeline.ts

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/match-pipeline.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/match-pipeline.test.ts`

**Interfaces:**
- Consumes: `normalizeForMatch`、`NormalizedText`（Task 1）
- Produces（Task 4/6 依赖，签名逐字使用）:
  - `interface MatchSpan { readonly start: number; readonly end: number }`（原文 UTF-16 偏移，end 开区间）
  - `type MatchResult = { kind: "unique"; span: MatchSpan; viaNormalization: boolean } | { kind: "multiple"; spans: readonly MatchSpan[]; viaNormalization: boolean } | { kind: "none" }`
  - `function findAllExact(content: string, needle: string): MatchSpan[]`
  - `function findOldString(content: string, oldString: string): MatchResult`
  - `function renderNumberedLines(lines: readonly string[], firstLineNumber: number): string`（`padStart(5)` 右对齐 + `→`）
  - `function lineNumberAt(content: string, offset: number): number`（1-based）
  - `function lineNumberPrefixWarning(oldString: string): string | undefined`
  - `function formatNoMatchDiagnosis(content: string, oldString: string): string`
  - `function formatMultiMatchDiagnosis(content: string, spans: readonly MatchSpan[]): string`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findAllExact,
  findOldString,
  formatMultiMatchDiagnosis,
  formatNoMatchDiagnosis,
  lineNumberAt,
  lineNumberPrefixWarning,
  renderNumberedLines,
} from "./match-pipeline.ts";

test("findAllExact 返回不重叠命中", () => {
  assert.deepEqual(findAllExact("aaa", "aa"), [{ start: 0, end: 2 }]);
  assert.deepEqual(findAllExact("ab ab", "ab"), [
    { start: 0, end: 2 },
    { start: 3, end: 5 },
  ]);
});

test("精确唯一命中优先且不标记归一化", () => {
  const result = findOldString("hello world", "world");
  assert.equal(result.kind, "unique");
  if (result.kind === "unique") {
    assert.deepEqual(result.span, { start: 6, end: 11 });
    assert.equal(result.viaNormalization, false);
  }
});

test("精确失败后归一化唯一命中并切回原文区间", () => {
  const content = "标题：“花卷”正文";
  const result = findOldString(content, '标题:"花卷"');
  assert.equal(result.kind, "unique");
  if (result.kind === "unique") {
    assert.equal(content.slice(result.span.start, result.span.end), "标题：“花卷”");
    assert.equal(result.viaNormalization, true);
  }
});

test("CRLF 文件可用 LF old_string 命中且区间含 CR", () => {
  const content = "first\r\nsecond\r\n";
  const result = findOldString(content, "first\nsecond");
  assert.equal(result.kind, "unique");
  if (result.kind === "unique") {
    assert.equal(content.slice(result.span.start, result.span.end), "first\r\nsecond");
  }
});

test("多处命中返回 multiple", () => {
  const result = findOldString("x=1\nx=1\n", "x=1");
  assert.equal(result.kind, "multiple");
  if (result.kind === "multiple") {
    assert.equal(result.spans.length, 2);
  }
});

test("完全不命中返回 none", () => {
  assert.equal(findOldString("abc", "zzz").kind, "none");
});

test("renderNumberedLines 五位右对齐加箭头", () => {
  assert.equal(renderNumberedLines(["a", "b"], 9), "    9→a\n   10→b");
});

test("lineNumberAt 按换行计数", () => {
  assert.equal(lineNumberAt("a\nb\nc", 0), 1);
  assert.equal(lineNumberAt("a\nb\nc", 2), 2);
  assert.equal(lineNumberAt("a\nb\nc", 4), 3);
});

test("行号前缀警告识别误带前缀", () => {
  assert.ok(lineNumberPrefixWarning("   12→const x = 1") !== undefined);
  assert.equal(lineNumberPrefixWarning("const x = 1"), undefined);
});

test("no-match 诊断包含最近似行的上下文与差异描述", () => {
  const content = "第一行\n总部位于上海市\n第三行";
  const diagnosis = formatNoMatchDiagnosis(content, "总部位于上海");
  assert.match(diagnosis, /未在文件中找到匹配/u);
  assert.match(diagnosis, /第 2 行/u);
  assert.match(diagnosis, /总部位于上海市/u);
  assert.match(diagnosis, /重新 read_file/u);
});

test("multi-match 诊断列出各命中行并给出两条出路", () => {
  const content = "x=1\ny\nx=1\n";
  const diagnosis = formatMultiMatchDiagnosis(content, findAllExact(content, "x=1"));
  assert.match(diagnosis, /出现 2 次/u);
  assert.match(diagnosis, /第 1 行/u);
  assert.match(diagnosis, /第 3 行/u);
  assert.match(diagnosis, /replace_all/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/match-pipeline.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
import { normalizeForMatch, type NormalizedText } from "./text-normalize.ts";

export interface MatchSpan {
  readonly start: number;
  readonly end: number;
}

export type MatchResult =
  | { readonly kind: "unique"; readonly span: MatchSpan; readonly viaNormalization: boolean }
  | {
      readonly kind: "multiple";
      readonly spans: readonly MatchSpan[];
      readonly viaNormalization: boolean;
    }
  | { readonly kind: "none" };

export function findAllExact(content: string, needle: string): MatchSpan[] {
  if (needle.length === 0) {
    return [];
  }
  const spans: MatchSpan[] = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const at = content.indexOf(needle, from);
    if (at === -1) {
      break;
    }
    spans.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return spans;
}

function spanFromNormalized(
  normalized: NormalizedText,
  normStart: number,
  needleLength: number,
  contentLength: number,
): MatchSpan {
  const origStart = normalized.map[normStart];
  const lastMapped = normalized.map[normStart + needleLength - 1];
  return {
    start: origStart ?? 0,
    end: lastMapped === undefined ? contentLength : lastMapped + 1,
  };
}

export function findOldString(content: string, oldString: string): MatchResult {
  const exact = findAllExact(content, oldString);
  const firstExact = exact[0];
  if (firstExact !== undefined && exact.length === 1) {
    return { kind: "unique", span: firstExact, viaNormalization: false };
  }
  if (exact.length > 1) {
    return { kind: "multiple", spans: exact, viaNormalization: false };
  }
  const normContent = normalizeForMatch(content);
  const normNeedle = normalizeForMatch(oldString).text;
  if (normNeedle.length === 0) {
    return { kind: "none" };
  }
  const spans = findAllExact(normContent.text, normNeedle).map((span) =>
    spanFromNormalized(normContent, span.start, normNeedle.length, content.length),
  );
  const firstNorm = spans[0];
  if (firstNorm !== undefined && spans.length === 1) {
    return { kind: "unique", span: firstNorm, viaNormalization: true };
  }
  if (spans.length > 1) {
    return { kind: "multiple", spans, viaNormalization: true };
  }
  return { kind: "none" };
}

export function renderNumberedLines(lines: readonly string[], firstLineNumber: number): string {
  return lines
    .map((line, index) => `${String(firstLineNumber + index).padStart(5)}→${line}`)
    .join("\n");
}

export function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < content.length; index += 1) {
    if (content.charAt(index) === "\n") {
      line += 1;
    }
  }
  return line;
}

function contextWindow(content: string, targetLine: number, radius: number): string {
  const lines = content.split("\n");
  const startLine = Math.max(1, targetLine - radius);
  const endLine = Math.min(lines.length, targetLine + radius);
  return renderNumberedLines(lines.slice(startLine - 1, endLine), startLine);
}

function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charAt(prefix) === b.charAt(prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < max - prefix &&
    a.charAt(a.length - 1 - suffix) === b.charAt(b.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return (prefix + suffix) / Math.max(a.length, b.length);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function firstDifference(expected: string, actual: string): string {
  const max = Math.min(expected.length, actual.length);
  let at = 0;
  while (at < max && expected.charAt(at) === actual.charAt(at)) {
    at += 1;
  }
  return `第 ${String(at + 1)} 个字符起不同：old_string 为 "${clip(expected.slice(at), 30)}"，文件为 "${clip(actual.slice(at), 30)}"`;
}

export function lineNumberPrefixWarning(oldString: string): string | undefined {
  return /^\s*\d+→/m.test(oldString)
    ? '警告：old_string 疑似包含 read_file 的行号前缀（如 "  12→"）。行号前缀不是文件内容，请删除前缀后重试。'
    : undefined;
}

export function formatNoMatchDiagnosis(content: string, oldString: string): string {
  const parts: string[] = ["old_string 未在文件中找到匹配。"];
  const prefixWarning = lineNumberPrefixWarning(oldString);
  if (prefixWarning !== undefined) {
    parts.push(prefixWarning);
  }
  const probe = oldString
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (probe !== undefined) {
    const lines = content.split("\n");
    let bestLine = 0;
    let bestScore = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const score = similarity(probe, (lines[index] ?? "").trim());
      if (score > bestScore) {
        bestScore = score;
        bestLine = index + 1;
      }
    }
    if (bestScore >= 0.3 && bestLine > 0) {
      const actual = (lines[bestLine - 1] ?? "").trim();
      parts.push(`最接近的位置在第 ${String(bestLine)} 行：`);
      parts.push(contextWindow(content, bestLine, 3));
      if (actual !== probe) {
        parts.push(firstDifference(probe, actual));
      }
    }
  }
  parts.push(
    "文件可能在你上次读取后有变化，或 old_string 与文件内容存在不可见差异。请重新 read_file 并逐字复制目标内容。",
  );
  return parts.join("\n");
}

export function formatMultiMatchDiagnosis(content: string, spans: readonly MatchSpan[]): string {
  const lines = content.split("\n");
  const shown = spans.slice(0, 8);
  const entries = shown.map((span) => {
    const line = lineNumberAt(content, span.start);
    return `  第 ${String(line)} 行：${clip((lines[line - 1] ?? "").trim(), 60)}`;
  });
  const suffix = spans.length > shown.length ? `\n  …（共 ${String(spans.length)} 处）` : "";
  return [
    `old_string 在文件中出现 ${String(spans.length)} 次，需要唯一匹配：`,
    `${entries.join("\n")}${suffix}`,
    "请在 old_string 中加入更多上下文行使其唯一，或设置 replace_all: true 一次替换全部。",
  ].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/match-pipeline.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/match-pipeline.ts packages/runtime/src/tool-bridge/file-tools/match-pipeline.test.ts
git commit -m "feat(runtime): add match pipeline with normalization fallback and failure diagnosis

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 基建 — settings.ts / file-io.ts / file-state-tracker.ts

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/settings.ts`
- Create: `packages/runtime/src/tool-bridge/file-tools/file-io.ts`
- Create: `packages/runtime/src/tool-bridge/file-tools/file-state-tracker.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/file-io.test.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/file-state-tracker.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 4–8 依赖，签名逐字使用）:
  - settings.ts: `interface SessionFileToolsSettings { readonly workdir: string; readonly maxFileBytes?: number; readonly maxOutputChars?: number }`；`interface ResolvedFileToolsSettings { readonly workdir: string; readonly maxFileBytes: number; readonly maxOutputChars: number }`；`const FILE_TOOLS_AGENT_NAME = "roll"`；`function resolveFileToolsSettings(input: SessionFileToolsSettings): ResolvedFileToolsSettings`（默认 maxFileBytes 2 MiB、maxOutputChars 40_000）
  - file-io.ts: `function resolveFilePath(workdir: string, input: string): string`；`function canonicalFileKey(path: string): string`；`function loadTextFile(path: string, limits: { readonly maxFileBytes: number }): LoadedTextFile | LoadFileFailure`（`LoadedTextFile = { ok: true; path; key; content; hadBom; suspectEncoding }`，`LoadFileFailure = { ok: false; code: "not-found" | "is-directory" | "too-large" | "binary"; message }`）；`function saveTextFile(path: string, content: string, hadBom: boolean): void`（自动建父目录）
  - file-state-tracker.ts: `const FILE_FRESHNESS = { fresh: "fresh", stale: "stale", unread: "unread" } as const`；`type FileFreshness`；`class FileStateTracker { recordKnownContent(key: string, content: string): void; checkFreshness(key: string, currentContent: string): FileFreshness }`

- [ ] **Step 1: 写失败测试（两个测试文件）**

`file-io.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTextFile, resolveFilePath, saveTextFile } from "./file-io.ts";

const LIMITS = { maxFileBytes: 1024 * 1024 };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "file-io-test-"));
}

test("resolveFilePath 相对路径基于 workdir 解析", () => {
  assert.equal(resolveFilePath("/base", "a/b.txt"), "/base/a/b.txt");
  assert.equal(resolveFilePath("/base", "/abs/c.txt"), "/abs/c.txt");
});

test("loadTextFile 读取 UTF-8 内容", () => {
  const dir = tempDir();
  const path = join(dir, "a.txt");
  writeFileSync(path, "你好\n世界", "utf8");
  const loaded = loadTextFile(path, LIMITS);
  assert.ok(loaded.ok);
  assert.equal(loaded.content, "你好\n世界");
  assert.equal(loaded.hadBom, false);
});

test("loadTextFile 剥离 BOM 并标记", () => {
  const dir = tempDir();
  const path = join(dir, "bom.txt");
  writeFileSync(path, "﻿内容", "utf8");
  const loaded = loadTextFile(path, LIMITS);
  assert.ok(loaded.ok);
  assert.equal(loaded.content, "内容");
  assert.equal(loaded.hadBom, true);
});

test("loadTextFile 拒绝不存在的路径与目录", () => {
  const dir = tempDir();
  const missing = loadTextFile(join(dir, "nope.txt"), LIMITS);
  assert.ok(!missing.ok && missing.code === "not-found");
  const directory = loadTextFile(dir, LIMITS);
  assert.ok(!directory.ok && directory.code === "is-directory");
});

test("loadTextFile 拒绝超大文件与二进制文件", () => {
  const dir = tempDir();
  const big = join(dir, "big.txt");
  writeFileSync(big, "x".repeat(64), "utf8");
  const tooLarge = loadTextFile(big, { maxFileBytes: 16 });
  assert.ok(!tooLarge.ok && tooLarge.code === "too-large");
  const bin = join(dir, "bin.dat");
  writeFileSync(bin, Buffer.from([0x61, 0x00, 0x62]));
  const binary = loadTextFile(bin, LIMITS);
  assert.ok(!binary.ok && binary.code === "binary");
});

test("saveTextFile 自动建父目录并按需还原 BOM", () => {
  const dir = tempDir();
  const nested = join(dir, "sub", "deep", "out.txt");
  saveTextFile(nested, "内容", true);
  assert.equal(readFileSync(nested, "utf8"), "﻿内容");
});
```

`file-state-tracker.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FILE_FRESHNESS, FileStateTracker } from "./file-state-tracker.ts";

test("未记录的文件返回 unread", () => {
  const tracker = new FileStateTracker();
  assert.equal(tracker.checkFreshness("/a", "content"), FILE_FRESHNESS.unread);
});

test("记录后内容一致返回 fresh、不一致返回 stale", () => {
  const tracker = new FileStateTracker();
  tracker.recordKnownContent("/a", "v1");
  assert.equal(tracker.checkFreshness("/a", "v1"), FILE_FRESHNESS.fresh);
  assert.equal(tracker.checkFreshness("/a", "v2"), FILE_FRESHNESS.stale);
});

test("重新记录覆盖旧状态", () => {
  const tracker = new FileStateTracker();
  tracker.recordKnownContent("/a", "v1");
  tracker.recordKnownContent("/a", "v2");
  assert.equal(tracker.checkFreshness("/a", "v2"), FILE_FRESHNESS.fresh);
});

test("超过容量上限时最早记录被淘汰", () => {
  const tracker = new FileStateTracker();
  for (let index = 0; index < 513; index += 1) {
    tracker.recordKnownContent(`/f${String(index)}`, "v");
  }
  assert.equal(tracker.checkFreshness("/f0", "v"), FILE_FRESHNESS.unread);
  assert.equal(tracker.checkFreshness("/f512", "v"), FILE_FRESHNESS.fresh);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/file-io.test.ts packages/runtime/src/tool-bridge/file-tools/file-state-tracker.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现（三个文件）**

`settings.ts`：

```ts
export const FILE_TOOLS_AGENT_NAME = "roll";

export interface SessionFileToolsSettings {
  readonly workdir: string;
  readonly maxFileBytes?: number;
  readonly maxOutputChars?: number;
}

export interface ResolvedFileToolsSettings {
  readonly workdir: string;
  readonly maxFileBytes: number;
  readonly maxOutputChars: number;
}

export function resolveFileToolsSettings(
  input: SessionFileToolsSettings,
): ResolvedFileToolsSettings {
  return {
    workdir: input.workdir,
    maxFileBytes: input.maxFileBytes ?? 2 * 1024 * 1024,
    maxOutputChars: input.maxOutputChars ?? 40_000,
  };
}
```

`file-io.ts`：

```ts
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const UTF8_BOM = "﻿";
const BINARY_PROBE_BYTES = 8192;

export type LoadFileFailure = {
  readonly ok: false;
  readonly code: "not-found" | "is-directory" | "too-large" | "binary";
  readonly message: string;
};

export interface LoadedTextFile {
  readonly ok: true;
  readonly path: string;
  readonly key: string;
  readonly content: string;
  readonly hadBom: boolean;
  readonly suspectEncoding: boolean;
}

export function resolveFilePath(workdir: string, input: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(workdir, input);
}

export function canonicalFileKey(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function looksBinary(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

export function loadTextFile(
  path: string,
  limits: { readonly maxFileBytes: number },
): LoadedTextFile | LoadFileFailure {
  let size: number;
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      return {
        ok: false,
        code: "is-directory",
        message: `${path} 是目录，浏览目录请用 roll__list_dir`,
      };
    }
    size = stats.size;
  } catch {
    return { ok: false, code: "not-found", message: `文件不存在: ${path}` };
  }
  if (size > limits.maxFileBytes) {
    return {
      ok: false,
      code: "too-large",
      message: `文件过大（${String(size)} 字节，上限 ${String(limits.maxFileBytes)} 字节），文件工具仅支持文本文件`,
    };
  }
  const buffer = readFileSync(path);
  if (looksBinary(buffer)) {
    return { ok: false, code: "binary", message: `${path} 是二进制文件，文件工具仅支持文本` };
  }
  const raw = buffer.toString("utf8");
  const hadBom = raw.startsWith(UTF8_BOM);
  const content = hadBom ? raw.slice(UTF8_BOM.length) : raw;
  return {
    ok: true,
    path,
    key: canonicalFileKey(path),
    content,
    hadBom,
    suspectEncoding: content.includes("�"),
  };
}

export function saveTextFile(path: string, content: string, hadBom: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, hadBom ? `${UTF8_BOM}${content}` : content, "utf8");
}
```

`file-state-tracker.ts`：

```ts
import { createHash } from "node:crypto";

export const FILE_FRESHNESS = {
  fresh: "fresh",
  stale: "stale",
  unread: "unread",
} as const;

export type FileFreshness = (typeof FILE_FRESHNESS)[keyof typeof FILE_FRESHNESS];

const MAX_TRACKED_FILES = 512;

function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class FileStateTracker {
  private readonly digests = new Map<string, string>();

  recordKnownContent(key: string, content: string): void {
    if (this.digests.has(key)) {
      this.digests.delete(key);
    } else if (this.digests.size >= MAX_TRACKED_FILES) {
      const oldest = this.digests.keys().next().value;
      if (oldest !== undefined) {
        this.digests.delete(oldest);
      }
    }
    this.digests.set(key, contentDigest(content));
  }

  checkFreshness(key: string, currentContent: string): FileFreshness {
    const recorded = this.digests.get(key);
    if (recorded === undefined) {
      return FILE_FRESHNESS.unread;
    }
    return recorded === contentDigest(currentContent)
      ? FILE_FRESHNESS.fresh
      : FILE_FRESHNESS.stale;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/file-io.test.ts packages/runtime/src/tool-bridge/file-tools/file-state-tracker.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/settings.ts packages/runtime/src/tool-bridge/file-tools/file-io.ts packages/runtime/src/tool-bridge/file-tools/file-io.test.ts packages/runtime/src/tool-bridge/file-tools/file-state-tracker.ts packages/runtime/src/tool-bridge/file-tools/file-state-tracker.test.ts
git commit -m "feat(runtime): add file tools infrastructure (io, settings, content-hash state tracker)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: roll__read_file

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/read-file-tool.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/read-file-tool.test.ts`

**Interfaces:**
- Consumes: Task 1–3 全部产出；既有模块 `../naming.ts`（`ToolRegistry`）、`../normalize-result.ts`（`TOOL_OUTCOME_KINDS` / `failedToolResult` / `successfulToolResult` / `toolResultToModelOutput` / `NormalizedToolResult`）、`../tool-execution-coordinator.ts`（`TOOL_RESOURCE_ACCESS_MODES` / `executeCoordinatedTool` / `ToolExecutionPlan`）、`../build-tools.ts`（`gateToolCall` / `ToolBridgeContext`）
- Produces（Task 8 依赖）: `const READ_FILE_TOOL_NAME = "read_file"`；`function executeReadFile(settings: ResolvedFileToolsSettings, tracker: FileStateTracker, input: { path: string; offset?: number; limit?: number }): NormalizedToolResult`（纯函数，便于测试）；`function buildReadFileTool(settings: ResolvedFileToolsSettings, tracker: FileStateTracker, registry: ToolRegistry, ctx: ToolBridgeContext): ToolSet`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_FRESHNESS, FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings } from "./settings.ts";
import { executeReadFile } from "./read-file-tool.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

function fixture(): { workdir: string; tracker: FileStateTracker } {
  return {
    workdir: mkdtempSync(join(tmpdir(), "read-tool-test-")),
    tracker: new FileStateTracker(),
  };
}

test("读取返回头部行数与带行号正文，并记录 tracker", () => {
  const { workdir, tracker } = fixture();
  const path = join(workdir, "a.txt");
  writeFileSync(path, "第一行\n第二行\n第三行", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "a.txt" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.match(text, /共 3 行/u);
  assert.match(text, /    1→第一行/u);
  assert.match(text, /    3→第三行/u);
  assert.equal(tracker.checkFreshness(canonicalFileKey(path), "第一行\n第二行\n第三行"), FILE_FRESHNESS.fresh);
});

test("offset 与 limit 控制窗口并提示继续位置", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "b.txt"), ["l1", "l2", "l3", "l4", "l5"].join("\n"), "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "b.txt", offset: 2, limit: 2 });
  const text = String(result.display);
  assert.match(text, /    2→l2/u);
  assert.match(text, /    3→l3/u);
  assert.doesNotMatch(text, /    4→l4/u);
  assert.match(text, /从第 4 行继续/u);
});

test("不存在的文件返回 invalid_input", () => {
  const { workdir, tracker } = fixture();
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "missing.txt" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
});

test("offset 超出行数返回 invalid_input", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "c.txt"), "only", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeReadFile(settings, tracker, { path: "c.txt", offset: 9 });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
});

test("超长单行被截断标注", () => {
  const { workdir, tracker } = fixture();
  writeFileSync(join(workdir, "d.txt"), "x".repeat(1500), "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const text = String(executeReadFile(settings, tracker, { path: "d.txt" }).display);
  assert.match(text, /\[行截断\]/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/read-file-tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolRegistry } from "../naming.ts";
import type { ToolBridgeContext } from "../build-tools.ts";
import { gateToolCall } from "../build-tools.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "../tool-execution-coordinator.ts";
import { renderNumberedLines } from "./match-pipeline.ts";
import { canonicalFileKey, loadTextFile, resolveFilePath } from "./file-io.ts";
import type { FileStateTracker } from "./file-state-tracker.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const READ_FILE_TOOL_NAME = "read_file";

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_CHARS = 1000;

const readFileInputSchema = z.object({
  path: z.string().min(1).describe("要读取的文件路径，相对当前工作目录或绝对路径"),
  offset: z.number().int().min(1).optional().describe("起始行号（从 1 开始），默认 1"),
  limit: z.number().int().min(1).optional().describe("最多返回的行数，默认 2000"),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

const READ_ANNOTATIONS = { readOnlyHint: true } as const;

function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[行截断]` : line;
}

export function executeReadFile(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  input: ReadFileInput,
): NormalizedToolResult {
  const path = resolveFilePath(settings.workdir, input.path);
  const loaded = loadTextFile(path, { maxFileBytes: settings.maxFileBytes });
  if (!loaded.ok) {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, loaded.message);
  }
  tracker.recordKnownContent(loaded.key, loaded.content);
  const lines = loaded.content.split("\n");
  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_LINE_LIMIT;
  if (offset > lines.length) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.invalidInput,
      `offset ${String(offset)} 超出文件行数（共 ${String(lines.length)} 行）`,
    );
  }
  const slice = lines.slice(offset - 1, offset - 1 + limit).map(clipLine);
  let body = renderNumberedLines(slice, offset);
  if (body.length > settings.maxOutputChars) {
    const cut = body.lastIndexOf("\n", settings.maxOutputChars);
    body = body.slice(0, cut > 0 ? cut : settings.maxOutputChars);
  }
  const shownLines = body.length === 0 ? 0 : body.split("\n").length;
  const nextLine = offset + shownLines;
  const parts = [`文件: ${path}（共 ${String(lines.length)} 行）`, body];
  if (loaded.suspectEncoding) {
    parts.push("警告：内容含替换字符，文件可能不是 UTF-8 编码。");
  }
  if (nextLine <= lines.length) {
    parts.push(`（未展示全部内容，用 offset: ${String(nextLine)} 继续读取）`);
  }
  return successfulToolResult(parts.join("\n"));
}

export function buildReadFileTool(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, READ_FILE_TOOL_NAME, {
    annotations: READ_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = readFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: path 必须为非空字符串，offset/limit 须为正整数",
        );
      }
      return gateToolCall(ctx, FILE_TOOLS_AGENT_NAME, READ_FILE_TOOL_NAME, parsed.data, READ_ANNOTATIONS);
    },
    resources: (rawInput) => {
      const parsed = readFileInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalFileKey(resolveFilePath(settings.workdir, parsed.data.path))}`
        : `file-tools:${settings.workdir}`;
      return [{ key, mode: TOOL_RESOURCE_ACCESS_MODES.read }];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        "读取文本文件内容。输出每行带行号前缀（如 \"   12→\"），前缀不是文件内容。编辑文件前必须先用本工具读取。",
      inputSchema: readFileInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: ReadFileInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(ctx.coordinator, plan, id, options.toolCallId, input, options.abortSignal, () =>
          Promise.resolve(executeReadFile(settings, tracker, input)),
        ),
    }),
  };
}
```

注意：`result.display` 的字段名以 `normalize-result.ts` 中 `NormalizedToolResult` 实际结构为准（写测试前先 `rg "interface NormalizedToolResult" -A 6 packages/runtime/src/tool-bridge/normalize-result.ts` 核对 outcome/display 字段名，若为其他名称同步调整测试断言——`successfulToolResult(display)` 第一参数即展示值）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/read-file-tool.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/read-file-tool.ts packages/runtime/src/tool-bridge/file-tools/read-file-tool.test.ts
git commit -m "feat(runtime): add roll__read_file builtin tool with numbered output and state tracking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: roll__list_dir

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/list-dir-tool.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/list-dir-tool.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `resolveFilePath` / `canonicalFileKey` / settings；既有 `../` 模块同 Task 4
- Produces（Task 8 依赖）: `const LIST_DIR_TOOL_NAME = "list_dir"`；`function executeListDir(settings: ResolvedFileToolsSettings, input: { path?: string }): NormalizedToolResult`；`function buildListDirTool(settings, registry, ctx): ToolSet`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFileToolsSettings } from "./settings.ts";
import { executeListDir } from "./list-dir-tool.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

test("目录优先排序且文件附带大小", () => {
  const workdir = mkdtempSync(join(tmpdir(), "list-dir-test-"));
  mkdirSync(join(workdir, "zdir"));
  writeFileSync(join(workdir, "a.txt"), "hello", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeListDir(settings, {});
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const text = String(result.display);
  assert.ok(text.indexOf("zdir/") < text.indexOf("a.txt"));
  assert.match(text, /a\.txt（5 字节）/u);
});

test("不存在的目录返回 invalid_input", () => {
  const workdir = mkdtempSync(join(tmpdir(), "list-dir-test-"));
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeListDir(settings, { path: "nope" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
});

test("超过 300 项时截断并提示", () => {
  const workdir = mkdtempSync(join(tmpdir(), "list-dir-test-"));
  for (let index = 0; index < 305; index += 1) {
    writeFileSync(join(workdir, `f${String(index).padStart(3, "0")}.txt`), "", "utf8");
  }
  const text = String(executeListDir(resolveFileToolsSettings({ workdir }), {}).display);
  assert.match(text, /仅显示前 300 项（共 305 项）/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/list-dir-tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolRegistry } from "../naming.ts";
import type { ToolBridgeContext } from "../build-tools.ts";
import { gateToolCall } from "../build-tools.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "../tool-execution-coordinator.ts";
import { canonicalFileKey, resolveFilePath } from "./file-io.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const LIST_DIR_TOOL_NAME = "list_dir";

const MAX_ENTRIES = 300;

const listDirInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe("目录路径，相对当前工作目录或绝对路径，默认当前工作目录"),
});

export type ListDirInput = z.infer<typeof listDirInputSchema>;

const LIST_ANNOTATIONS = { readOnlyHint: true } as const;

function fileSizeSuffix(target: string): string {
  try {
    return `（${String(statSync(target).size)} 字节）`;
  } catch {
    return "";
  }
}

export function executeListDir(
  settings: ResolvedFileToolsSettings,
  input: ListDirInput,
): NormalizedToolResult {
  const path = resolveFilePath(settings.workdir, input.path ?? ".");
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, `目录不存在或不可读: ${path}`);
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  const shown = sorted.slice(0, MAX_ENTRIES);
  const lines = shown.map((entry) =>
    entry.isDirectory() ? `${entry.name}/` : `${entry.name}${fileSizeSuffix(resolve(path, entry.name))}`,
  );
  const parts = [`目录: ${path}`, lines.join("\n")];
  if (sorted.length > shown.length) {
    parts.push(`（仅显示前 ${String(MAX_ENTRIES)} 项（共 ${String(sorted.length)} 项））`);
  }
  return successfulToolResult(parts.join("\n"));
}

export function buildListDirTool(
  settings: ResolvedFileToolsSettings,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, LIST_DIR_TOOL_NAME, {
    annotations: LIST_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = listDirInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, "参数校验失败: path 须为非空字符串");
      }
      return gateToolCall(ctx, FILE_TOOLS_AGENT_NAME, LIST_DIR_TOOL_NAME, parsed.data, LIST_ANNOTATIONS);
    },
    resources: (rawInput) => {
      const parsed = listDirInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalFileKey(resolveFilePath(settings.workdir, parsed.data.path ?? "."))}`
        : `file-tools:${settings.workdir}`;
      return [{ key, mode: TOOL_RESOURCE_ACCESS_MODES.read }];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description: "列出目录内容（目录带 / 后缀，文件附字节数）。默认列出当前工作目录。",
      inputSchema: listDirInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: ListDirInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(ctx.coordinator, plan, id, options.toolCallId, input, options.abortSignal, () =>
          Promise.resolve(executeListDir(settings, input)),
        ),
    }),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/list-dir-tool.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/list-dir-tool.ts packages/runtime/src/tool-bridge/file-tools/list-dir-tool.test.ts
git commit -m "feat(runtime): add roll__list_dir builtin tool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: roll__edit_file（核心）

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/edit-file-tool.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/edit-file-tool.test.ts`

**Interfaces:**
- Consumes: Task 1–4 全部产出（`findOldString` / `findAllExact` / `formatNoMatchDiagnosis` / `formatMultiMatchDiagnosis` / `renderNumberedLines` / `lineNumberAt` / `loadTextFile` / `saveTextFile` / `FileStateTracker` / `FILE_FRESHNESS`）
- Produces（Task 8 依赖）: `const EDIT_FILE_TOOL_NAME = "edit_file"`；`function executeEditFile(settings: ResolvedFileToolsSettings, tracker: FileStateTracker, input: EditFileInput): NormalizedToolResult`；`function buildEditFileTool(settings, tracker, registry, ctx): ToolSet`；`EditFileInput = { file_path: string; edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> }`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings, type ResolvedFileToolsSettings } from "./settings.ts";
import { executeEditFile } from "./edit-file-tool.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

interface Fixture {
  readonly workdir: string;
  readonly path: string;
  readonly settings: ResolvedFileToolsSettings;
  readonly tracker: FileStateTracker;
}

function fixture(content: string): Fixture {
  const workdir = mkdtempSync(join(tmpdir(), "edit-tool-test-"));
  const path = join(workdir, "target.txt");
  writeFileSync(path, content, "utf8");
  return { workdir, path, settings: resolveFileToolsSettings({ workdir }), tracker: new FileStateTracker() };
}

function markRead(f: Fixture): void {
  f.tracker.recordKnownContent(canonicalFileKey(f.path), readFileSync(f.path, "utf8"));
}

test("未读取过的文件拒绝编辑", () => {
  const f = fixture("内容");
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "内容", new_string: "新内容" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /先用 roll__read_file/u);
  assert.equal(readFileSync(f.path, "utf8"), "内容");
});

test("外部修改后拒绝并引导重读", () => {
  const f = fixture("v1");
  markRead(f);
  writeFileSync(f.path, "v2-外部修改", "utf8");
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "v1", new_string: "v3" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /已被修改/u);
  assert.match(String(result.display), /重新 roll__read_file/u);
});

test("唯一命中成功改写并返回编辑点快照", () => {
  const f = fixture("第一行\n目标行\n第三行");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "目标行", new_string: "修改后的行" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "第一行\n修改后的行\n第三行");
  const text = String(result.display);
  assert.match(text, /已完成 1 处修改/u);
  assert.match(text, /    2→修改后的行/u);
});

test("编辑成功后无需重读即可继续编辑", () => {
  const f = fixture("a\nb");
  markRead(f);
  const first = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "a", new_string: "A" }],
  });
  assert.equal(first.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const second = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "b", new_string: "B" }],
  });
  assert.equal(second.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "A\nB");
});

test("归一化命中只替换目标段且保留文件其余字节", () => {
  const f = fixture("保留“原样”前缀\n标题：“花卷”\n保留“原样”后缀");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: '标题:"花卷"', new_string: "标题：《花卷》" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "保留“原样”前缀\n标题：《花卷》\n保留“原样”后缀");
});

test("多处命中失败并列出位置", () => {
  const f = fixture("x=1\ny\nx=1");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "x=1", new_string: "x=2" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /出现 2 次/u);
  assert.equal(readFileSync(f.path, "utf8"), "x=1\ny\nx=1");
});

test("replace_all 替换全部精确命中", () => {
  const f = fixture("x=1\ny\nx=1");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "x=1", new_string: "x=2", replace_all: true }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "x=2\ny\nx=2");
});

test("批量编辑原子性：第二条失败则第一条不落盘", () => {
  const f = fixture("alpha\nbeta");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [
      { old_string: "alpha", new_string: "ALPHA" },
      { old_string: "不存在的内容", new_string: "x" },
    ],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /第 2 条编辑（共 2 条）失败/u);
  assert.match(String(result.display), /未写入任何修改/u);
  assert.equal(readFileSync(f.path, "utf8"), "alpha\nbeta");
});

test("批量编辑顺序应用：后条可匹配前条结果", () => {
  const f = fixture("v1");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [
      { old_string: "v1", new_string: "v2" },
      { old_string: "v2", new_string: "v3" },
    ],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "v3");
});

test("CRLF 文件回写保持 CRLF", () => {
  const f = fixture("first\r\nsecond\r\n");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "first\nsecond", new_string: "first\nchanged" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "first\r\nchanged\r\n");
});

test("old_string 与 new_string 相同返回 invalid_input", () => {
  const f = fixture("same");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "same", new_string: "same" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
});

test("BOM 文件编辑后 BOM 保留", () => {
  const f = fixture("﻿内容");
  markRead(f);
  const result = executeEditFile(f.settings, f.tracker, {
    file_path: "target.txt",
    edits: [{ old_string: "内容", new_string: "新内容" }],
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "﻿新内容");
});
```

注意：`markRead` 里记录的内容须与 `loadTextFile` 的 BOM 剥离语义一致——BOM 用例中 `readFileSync` 返回带 BOM 字符串而 tracker 记录的应是剥离后的；该用例的 `markRead` 改为手动记录 `"内容"`（剥离后）。实现该测试时直接写：

```ts
f.tracker.recordKnownContent(canonicalFileKey(f.path), "内容");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/edit-file-tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
import { basename } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolRegistry } from "../naming.ts";
import type { ToolBridgeContext } from "../build-tools.ts";
import { gateToolCall } from "../build-tools.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "../tool-execution-coordinator.ts";
import {
  findAllExact,
  findOldString,
  formatMultiMatchDiagnosis,
  formatNoMatchDiagnosis,
  lineNumberAt,
  renderNumberedLines,
  type MatchSpan,
} from "./match-pipeline.ts";
import { canonicalFileKey, loadTextFile, resolveFilePath, saveTextFile } from "./file-io.ts";
import { FILE_FRESHNESS, type FileStateTracker } from "./file-state-tracker.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const EDIT_FILE_TOOL_NAME = "edit_file";

const SNAPSHOT_RADIUS = 3;

const editEntrySchema = z.object({
  old_string: z
    .string()
    .min(1)
    .describe("要替换的原文，必须逐字复制自 read_file 读到的内容（不含行号前缀）"),
  new_string: z.string().describe("替换后的新内容，必须与 old_string 不同"),
  replace_all: z
    .boolean()
    .optional()
    .describe("替换所有精确匹配处，默认 false（要求唯一匹配）"),
});

const editFileInputSchema = z.object({
  file_path: z.string().min(1).describe("要修改的文件路径，相对当前工作目录或绝对路径"),
  edits: z
    .array(editEntrySchema)
    .min(1)
    .describe("按顺序应用的编辑列表；任何一条失败则整体不写入"),
});

export type EditFileInput = z.infer<typeof editFileInputSchema>;

const EDIT_ANNOTATIONS = {} as const;

interface AppliedEdit {
  position: number;
  length: number;
}

function detectCrlfOnly(content: string): boolean {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const bareLf = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > 0 && bareLf === 0;
}

function adaptLineEndings(value: string, crlfOnly: boolean): string {
  return crlfOnly ? value.replace(/\r?\n/g, "\r\n") : value;
}

function shiftApplied(applied: AppliedEdit[], at: number, delta: number): void {
  for (const record of applied) {
    if (record.position > at) {
      record.position += delta;
    }
  }
}

function applySpan(
  working: string,
  span: MatchSpan,
  replacement: string,
  applied: AppliedEdit[],
): string {
  const next = working.slice(0, span.start) + replacement + working.slice(span.end);
  shiftApplied(applied, span.start, replacement.length - (span.end - span.start));
  applied.push({ position: span.start, length: replacement.length });
  return next;
}

function applyReplaceAll(
  working: string,
  spans: readonly MatchSpan[],
  replacement: string,
  applied: AppliedEdit[],
): string {
  let next = working;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans.at(index);
    if (span === undefined) {
      continue;
    }
    next = next.slice(0, span.start) + replacement + next.slice(span.end);
    shiftApplied(applied, span.start, replacement.length - (span.end - span.start));
    applied.push({ position: span.start, length: replacement.length });
  }
  return next;
}

function renderEditSuccess(
  path: string,
  content: string,
  applied: readonly AppliedEdit[],
  maxOutputChars: number,
): string {
  const lines = content.split("\n");
  const parts = [`已完成 ${String(applied.length)} 处修改并写入 ${path}：`];
  applied.forEach((record, index) => {
    const startLineNo = lineNumberAt(content, record.position);
    const endOffset = record.position + Math.max(record.length - 1, 0);
    const endLineNo = lineNumberAt(content, Math.min(endOffset, Math.max(content.length - 1, 0)));
    const windowStart = Math.max(1, startLineNo - SNAPSHOT_RADIUS);
    const windowEnd = Math.min(lines.length, endLineNo + SNAPSHOT_RADIUS);
    parts.push(`[${String(index + 1)}] 第 ${String(startLineNo)} 行附近：`);
    parts.push(renderNumberedLines(lines.slice(windowStart - 1, windowEnd), windowStart));
  });
  const rendered = parts.join("\n");
  return rendered.length > maxOutputChars
    ? `${rendered.slice(0, maxOutputChars)}\n…（快照过长已截断，修改均已写入）`
    : rendered;
}

export function executeEditFile(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  input: EditFileInput,
): NormalizedToolResult {
  const path = resolveFilePath(settings.workdir, input.file_path);
  const loaded = loadTextFile(path, { maxFileBytes: settings.maxFileBytes });
  if (!loaded.ok) {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, loaded.message);
  }
  const freshness = tracker.checkFreshness(loaded.key, loaded.content);
  if (freshness === FILE_FRESHNESS.unread) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.toolFailed,
      `尚未读取过 ${path}。请先用 roll__read_file 读取文件，再基于读到的内容编辑。`,
    );
  }
  if (freshness === FILE_FRESHNESS.stale) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.toolFailed,
      `${path} 在你上次读取后已被修改（可能是用户或其他程序改动）。请重新 roll__read_file 获取最新内容，再基于最新内容编辑，不要用旧内容重试。`,
    );
  }
  const crlfOnly = detectCrlfOnly(loaded.content);
  let working = loaded.content;
  const applied: AppliedEdit[] = [];
  for (const [index, edit] of input.edits.entries()) {
    const label = `第 ${String(index + 1)} 条编辑（共 ${String(input.edits.length)} 条）`;
    if (edit.old_string === edit.new_string) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.invalidInput,
        `${label}：new_string 与 old_string 相同，没有可应用的变化。未写入任何修改。`,
      );
    }
    const oldAdapted = adaptLineEndings(edit.old_string, crlfOnly);
    const newAdapted = adaptLineEndings(edit.new_string, crlfOnly);
    if (edit.replace_all === true) {
      const spans = findAllExact(working, oldAdapted);
      if (spans.length === 0) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.toolFailed,
          `${label}失败，未写入任何修改。\n${formatNoMatchDiagnosis(working, oldAdapted)}`,
        );
      }
      working = applyReplaceAll(working, spans, newAdapted, applied);
      continue;
    }
    const match = findOldString(working, oldAdapted);
    if (match.kind === "none") {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${label}失败，未写入任何修改。\n${formatNoMatchDiagnosis(working, oldAdapted)}`,
      );
    }
    if (match.kind === "multiple") {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${label}失败，未写入任何修改。\n${formatMultiMatchDiagnosis(working, match.spans)}`,
      );
    }
    working = applySpan(working, match.span, newAdapted, applied);
  }
  saveTextFile(path, working, loaded.hadBom);
  tracker.recordKnownContent(loaded.key, working);
  return successfulToolResult(renderEditSuccess(path, working, applied, settings.maxOutputChars));
}

export function buildEditFileTool(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, EDIT_FILE_TOOL_NAME, {
    annotations: EDIT_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = editFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: file_path 必须为非空字符串，edits 至少一条且每条含非空 old_string 与 new_string",
        );
      }
      const path = resolveFilePath(settings.workdir, parsed.data.file_path);
      return gateToolCall(ctx, FILE_TOOLS_AGENT_NAME, EDIT_FILE_TOOL_NAME, parsed.data, EDIT_ANNOTATIONS, {
        explanation: `修改 ${basename(path)}：${String(parsed.data.edits.length)} 处编辑`,
      });
    },
    resources: (rawInput) => {
      const parsed = editFileInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalFileKey(resolveFilePath(settings.workdir, parsed.data.file_path))}`
        : `file-tools:${settings.workdir}`;
      return [{ key, mode: TOOL_RESOURCE_ACCESS_MODES.write }];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        "对文本文件做精确字符串替换。使用前必须先 roll__read_file 读取文件；old_string 逐字复制读到的内容（不含行号前缀）且须唯一定位；同一文件多处修改放进 edits 数组一次提交，任何一条失败则整体不写入。成功返回已含修改点最新内容，无需再次读取确认。",
      inputSchema: editFileInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: EditFileInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(ctx.coordinator, plan, id, options.toolCallId, input, options.abortSignal, () =>
          Promise.resolve(executeEditFile(settings, tracker, input)),
        ),
    }),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/edit-file-tool.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/edit-file-tool.ts packages/runtime/src/tool-bridge/file-tools/edit-file-tool.test.ts
git commit -m "feat(runtime): add roll__edit_file with atomic batch edits, staleness gate and diagnosis

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: roll__write_file

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/write-file-tool.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts`

**Interfaces:**
- Consumes: Task 2–3 产出 + 既有 `../` 模块同 Task 4
- Produces（Task 8 依赖）: `const WRITE_FILE_TOOL_NAME = "write_file"`；`function executeWriteFile(settings, tracker, input: { file_path: string; content: string }): NormalizedToolResult`；`function buildWriteFileTool(settings, tracker, registry, ctx): ToolSet`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateTracker } from "./file-state-tracker.ts";
import { canonicalFileKey } from "./file-io.ts";
import { resolveFileToolsSettings } from "./settings.ts";
import { executeWriteFile } from "./write-file-tool.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

test("新文件写入成功并自动建父目录", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const settings = resolveFileToolsSettings({ workdir });
  const tracker = new FileStateTracker();
  const result = executeWriteFile(settings, tracker, {
    file_path: "sub/dir/new.txt",
    content: "第一行\n第二行",
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(join(workdir, "sub/dir/new.txt"), "utf8"), "第一行\n第二行");
  assert.match(String(result.display), /已写入/u);
  assert.match(String(result.display), /    1→第一行/u);
});

test("覆盖已存在但未读取过的文件被拒绝", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const path = join(workdir, "exists.txt");
  writeFileSync(path, "旧内容", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeWriteFile(settings, new FileStateTracker(), {
    file_path: "exists.txt",
    content: "新内容",
  });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /先用 roll__read_file/u);
  assert.equal(readFileSync(path, "utf8"), "旧内容");
});

test("读取过且未变化的文件允许覆盖", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const path = join(workdir, "exists.txt");
  writeFileSync(path, "旧内容", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), "旧内容");
  const result = executeWriteFile(settings, tracker, { file_path: "exists.txt", content: "新内容" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(path, "utf8"), "新内容");
});

test("读取后被外部修改的文件拒绝覆盖", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const path = join(workdir, "exists.txt");
  writeFileSync(path, "v1", "utf8");
  const settings = resolveFileToolsSettings({ workdir });
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), "v1");
  writeFileSync(path, "v2-外部修改", "utf8");
  const result = executeWriteFile(settings, tracker, { file_path: "exists.txt", content: "v3" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /已被修改/u);
  assert.equal(readFileSync(path, "utf8"), "v2-外部修改");
});

test("写入目标是目录时拒绝", () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
  const settings = resolveFileToolsSettings({ workdir });
  const result = executeWriteFile(settings, new FileStateTracker(), { file_path: ".", content: "x" });
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
  assert.ok(existsSync(workdir));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
import { basename } from "node:path";
import { statSync } from "node:fs";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolRegistry } from "../naming.ts";
import type { ToolBridgeContext } from "../build-tools.ts";
import { gateToolCall } from "../build-tools.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "../tool-execution-coordinator.ts";
import { renderNumberedLines } from "./match-pipeline.ts";
import { canonicalFileKey, loadTextFile, resolveFilePath, saveTextFile } from "./file-io.ts";
import { FILE_FRESHNESS, type FileStateTracker } from "./file-state-tracker.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const WRITE_FILE_TOOL_NAME = "write_file";

const PREVIEW_LINES = 10;

const writeFileInputSchema = z.object({
  file_path: z.string().min(1).describe("要写入的文件路径，相对当前工作目录或绝对路径"),
  content: z.string().describe("完整的文件内容（整文件写入，覆盖原有内容）"),
});

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

const WRITE_ANNOTATIONS = {} as const;

function existsAsFile(path: string): boolean | "directory" {
  try {
    return statSync(path).isDirectory() ? "directory" : true;
  } catch {
    return false;
  }
}

export function executeWriteFile(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  input: WriteFileInput,
): NormalizedToolResult {
  const path = resolveFilePath(settings.workdir, input.file_path);
  const existing = existsAsFile(path);
  if (existing === "directory") {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, `${path} 是目录，不能作为文件写入`);
  }
  if (existing === true) {
    const loaded = loadTextFile(path, { maxFileBytes: settings.maxFileBytes });
    if (!loaded.ok) {
      return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, loaded.message);
    }
    const freshness = tracker.checkFreshness(loaded.key, loaded.content);
    if (freshness === FILE_FRESHNESS.unread) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${path} 已存在。覆盖前请先用 roll__read_file 读取并确认现有内容；若只改部分内容，优先用 roll__edit_file。`,
      );
    }
    if (freshness === FILE_FRESHNESS.stale) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.toolFailed,
        `${path} 在你上次读取后已被修改（可能是用户或其他程序改动）。请重新 roll__read_file 确认最新内容后再决定是否覆盖。`,
      );
    }
  }
  saveTextFile(path, input.content, false);
  tracker.recordKnownContent(canonicalFileKey(path), input.content);
  const lines = input.content.split("\n");
  const preview = renderNumberedLines(lines.slice(0, PREVIEW_LINES), 1);
  const parts = [
    `已写入 ${path}（${String(lines.length)} 行，${String(Buffer.byteLength(input.content, "utf8"))} 字节）：`,
    preview,
  ];
  if (lines.length > PREVIEW_LINES) {
    parts.push(`（预览前 ${String(PREVIEW_LINES)} 行）`);
  }
  return successfulToolResult(parts.join("\n"));
}

export function buildWriteFileTool(
  settings: ResolvedFileToolsSettings,
  tracker: FileStateTracker,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, WRITE_FILE_TOOL_NAME, {
    annotations: WRITE_ANNOTATIONS,
  });
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = writeFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: file_path 必须为非空字符串，content 必须为字符串",
        );
      }
      const path = resolveFilePath(settings.workdir, parsed.data.file_path);
      return gateToolCall(ctx, FILE_TOOLS_AGENT_NAME, WRITE_FILE_TOOL_NAME, parsed.data, WRITE_ANNOTATIONS, {
        explanation: `写入 ${basename(path)}（${String(parsed.data.content.split("\n").length)} 行）`,
      });
    },
    resources: (rawInput) => {
      const parsed = writeFileInputSchema.safeParse(rawInput);
      const key = parsed.success
        ? `file:${canonicalFileKey(resolveFilePath(settings.workdir, parsed.data.file_path))}`
        : `file-tools:${settings.workdir}`;
      return [{ key, mode: TOOL_RESOURCE_ACCESS_MODES.write }];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        "新建文件或整文件重写。已存在的文件必须先 roll__read_file 读取确认后才能覆盖；只改部分内容时优先用 roll__edit_file。",
      inputSchema: writeFileInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: WriteFileInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(ctx.coordinator, plan, id, options.toolCallId, input, options.abortSignal, () =>
          Promise.resolve(executeWriteFile(settings, tracker, input)),
        ),
    }),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/write-file-tool.ts packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts
git commit -m "feat(runtime): add roll__write_file with read-before-overwrite discipline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: 组装 index.ts + AgentSession / ConversationEngine / capability 接线

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/index.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/index.test.ts`
- Modify: `packages/runtime/src/engine/capability-manifest.ts:17-27`（CAPABILITY_TOOL_ROLES）与 `:334-341` 附近（CAPABILITY_APPROVAL_BY_ROLE）
- Modify: `packages/runtime/src/engine/agent-session.ts`（AgentSessionOptions + constructor 工具组装段 :890-970 附近）
- Modify: `packages/runtime/src/engine/conversation-engine.ts`（ConversationEngineOptions + createSession 组装段 :538-570 附近）
- Test: `packages/runtime/src/engine/agent-session.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 4–7 的 `build*Tool` 函数、Task 3 的 settings
- Produces:
  - `interface BuiltFileToolset { readonly readTools: ToolSet; readonly editTools: ToolSet }`
  - `function buildFileToolset(settings: SessionFileToolsSettings, registry: ToolRegistry, ctx: ToolBridgeContext): BuiltFileToolset`（内部创建 tracker，read/edit/write/list 共享）
  - `AgentSessionOptions.fileTools?: SessionFileToolsSettings`
  - `ConversationEngineOptions.fileToolsEnabled?: boolean`（默认 true）
  - 新 roles：`CAPABILITY_TOOL_ROLES.fileRead = "file-read"`、`CAPABILITY_TOOL_ROLES.fileEdit = "file-edit"`（Task 9 依赖这两个字符串）

- [ ] **Step 1: GitNexus impact 前置检查**

对将修改的既有符号跑 upstream impact 并记录风险（HIGH/CRITICAL 须先向用户报告再动手）：

```
mcp__gitnexus__impact({target: "buildEffectiveCapabilityManifest", direction: "upstream", repo: "roll-agent"})
mcp__gitnexus__impact({target: "AgentSession", direction: "upstream", repo: "roll-agent"})
mcp__gitnexus__impact({target: "ConversationEngine", direction: "upstream", repo: "roll-agent"})
```

预期：改动均为「新增可选字段 + 新增组装分支」，向后兼容；`CAPABILITY_APPROVAL_BY_ROLE` 是 `Partial<Record<...>>`（capability-manifest.ts:333-335），新增 role 不触发穷尽性错误。

- [ ] **Step 2: 写失败测试（index.test.ts）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../naming.ts";
import { DefaultToolPolicy } from "../../policy/default-policy.ts";
import type { ApprovalRequest } from "../build-tools.ts";
import { buildFileToolset } from "./index.ts";

function buildFixture(workdir: string) {
  const approvals: ApprovalRequest[] = [];
  const registry = new ToolRegistry();
  const toolset = buildFileToolset({ workdir }, registry, {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve({ approved: true });
    },
  });
  return { approvals, registry, toolset };
}

test("注册四个 roll__ 前缀工具并按读写分组", () => {
  const workdir = mkdtempSync(join(tmpdir(), "file-toolset-test-"));
  const { toolset } = buildFixture(workdir);
  assert.deepEqual(Object.keys(toolset.readTools).sort(), ["roll__list_dir", "roll__read_file"]);
  assert.deepEqual(Object.keys(toolset.editTools).sort(), ["roll__edit_file", "roll__write_file"]);
});

test("read 与 edit 共享同一 tracker：读后即可编辑", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "file-toolset-test-"));
  writeFileSync(join(workdir, "a.txt"), "原文", "utf8");
  const { approvals, toolset } = buildFixture(workdir);
  const readTool = toolset.readTools.roll__read_file;
  const editTool = toolset.editTools.roll__edit_file;
  assert.ok(readTool?.execute !== undefined && editTool?.execute !== undefined);
  const readResult = await readTool.execute(
    { path: "a.txt" },
    { toolCallId: "t1", messages: [] },
  );
  assert.equal(readResult.outcome.kind, "success");
  const editResult = await editTool.execute(
    { file_path: "a.txt", edits: [{ old_string: "原文", new_string: "改后" }] },
    { toolCallId: "t2", messages: [] },
  );
  assert.equal(editResult.outcome.kind, "success");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.toolName, "edit_file");
});
```

注意：`execute` 的第二参数形状以 `ToolExecutionOptions` 实际要求为准（参照 `bash-tool.test.ts` 中现有调用方式，若需要额外字段照抄该测试的构造 helper）。

- [ ] **Step 3: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/index.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 写 index.ts**

```ts
import type { ToolSet } from "ai";
import type { ToolRegistry } from "../naming.ts";
import type { ToolBridgeContext } from "../build-tools.ts";
import { FileStateTracker } from "./file-state-tracker.ts";
import { resolveFileToolsSettings, type SessionFileToolsSettings } from "./settings.ts";
import { buildReadFileTool } from "./read-file-tool.ts";
import { buildListDirTool } from "./list-dir-tool.ts";
import { buildEditFileTool } from "./edit-file-tool.ts";
import { buildWriteFileTool } from "./write-file-tool.ts";

export type { SessionFileToolsSettings } from "./settings.ts";
export { READ_FILE_TOOL_NAME } from "./read-file-tool.ts";
export { LIST_DIR_TOOL_NAME } from "./list-dir-tool.ts";
export { EDIT_FILE_TOOL_NAME } from "./edit-file-tool.ts";
export { WRITE_FILE_TOOL_NAME } from "./write-file-tool.ts";

export interface BuiltFileToolset {
  readonly readTools: ToolSet;
  readonly editTools: ToolSet;
}

export function buildFileToolset(
  settings: SessionFileToolsSettings,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): BuiltFileToolset {
  const resolved = resolveFileToolsSettings(settings);
  const tracker = new FileStateTracker();
  return {
    readTools: {
      ...buildReadFileTool(resolved, tracker, registry, ctx),
      ...buildListDirTool(resolved, registry, ctx),
    },
    editTools: {
      ...buildEditFileTool(resolved, tracker, registry, ctx),
      ...buildWriteFileTool(resolved, tracker, registry, ctx),
    },
  };
}
```

- [ ] **Step 5: 跑 index.test.ts 确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/index.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 6: capability-manifest.ts 加 roles**

在 `CAPABILITY_TOOL_ROLES`（capability-manifest.ts:17）对象里追加两个 key（保持既有排序风格，加在 `shell` 之后）：

```ts
  fileRead: "file-read",
  fileEdit: "file-edit",
```

在 `CAPABILITY_APPROVAL_BY_ROLE`（:334 附近）里追加一行（fileEdit 不加条目，走默认 runtimePolicy）：

```ts
  [CAPABILITY_TOOL_ROLES.fileRead]: CAPABILITY_APPROVAL_MODES.readOnly,
```

- [ ] **Step 7: agent-session.ts 接线**

AgentSessionOptions（`bash?: SessionBashSettings;` 声明附近，agent-session.ts:236）加：

```ts
  readonly fileTools?: SessionFileToolsSettings;
```

顶部 import（与既有 tool-bridge import 并列）：

```ts
import { buildFileToolset, type SessionFileToolsSettings } from "../tool-bridge/file-tools/index.ts";
```

constructor 中 `markToolRole(toolRoles, skillTools, CAPABILITY_TOOL_ROLES.skill);`（:891）之后、`bashCtx` 定义之前插入：

```ts
    const fileToolset = options.fileTools
      ? buildFileToolset(options.fileTools, registry, {
          ...(options.policy ? { policy: options.policy } : {}),
          requestApproval: (request) => this.requestApproval(request),
          coordinator: this.toolCoordinator,
        })
      : undefined;
    if (fileToolset) {
      markToolRole(toolRoles, fileToolset.readTools, CAPABILITY_TOOL_ROLES.fileRead);
      markToolRole(toolRoles, fileToolset.editTools, CAPABILITY_TOOL_ROLES.fileEdit);
    }
```

`this.tools = {...}`（:963）合并顺序在 skillTools 之后插入：

```ts
    this.tools = {
      ...transcriptTools,
      ...skillTools,
      ...(fileToolset ? { ...fileToolset.readTools, ...fileToolset.editTools } : {}),
      ...bashTools,
      ...sessionExecTools,
      ...agentInstallTools,
      ...built.tools,
    };
```

- [ ] **Step 8: conversation-engine.ts 接线**

ConversationEngineOptions（:104 附近）加：

```ts
  readonly fileToolsEnabled?: boolean;
```

构造函数存字段（`this.policy = options.policy;` 附近）：

```ts
  private readonly fileToolsEnabled: boolean;
```

```ts
    this.fileToolsEnabled = options.fileToolsEnabled ?? true;
```

createSession 组装处（:541-569 `const bash = ...` 之后），构造 fileTools 并传入 AgentSession options spread：

```ts
    const fileTools = this.fileToolsEnabled
      ? { workdir: bash?.workdir ?? process.cwd() }
      : undefined;
```

在 new AgentSession 的 options 里（与 `...(bash ? { bash } : {})` 并列）加：

```ts
      ...(fileTools ? { fileTools } : {}),
```

- [ ] **Step 9: agent-session.test.ts 追加集成用例**

参照同文件既有用例的 MockLanguageModelV4 / streamChunks / textStep / collect helper 构造（agent-session.test.ts:90-132 的模式）：

```ts
test("AgentSession 注册文件工具并按 role 标记 capability", async () => {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options);
      return streamChunks(textStep("done"));
    },
  });
  const session = new AgentSession({
    id: "file-tools-capability",
    model,
    sources: [],
    maxSteps: 2,
    fileTools: { workdir: process.cwd() },
  });
  const tools = session.getCapabilityManifest().tools;
  assert.equal(
    tools.find((tool) => tool.role === "file-read" && tool.id === "roll__read_file")?.id,
    "roll__read_file",
  );
  assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__edit_file"));
  assert.ok(tools.some((tool) => tool.role === "file-edit" && tool.id === "roll__write_file"));
  assert.ok(tools.some((tool) => tool.role === "file-read" && tool.id === "roll__list_dir"));
  await collect(session.send("hi"));
  assert.match(JSON.stringify(calls[0]?.tools), /roll__edit_file/u);
});
```

- [ ] **Step 10: 跑测试与包级检查**

Run:
```bash
node --experimental-strip-types --test packages/runtime/src/tool-bridge/file-tools/index.test.ts packages/runtime/src/engine/agent-session.test.ts
pnpm --filter @roll-agent/runtime typecheck
```
Expected: 全 PASS，typecheck 无错误

- [ ] **Step 11: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/index.ts packages/runtime/src/tool-bridge/file-tools/index.test.ts packages/runtime/src/engine/capability-manifest.ts packages/runtime/src/engine/agent-session.ts packages/runtime/src/engine/conversation-engine.ts packages/runtime/src/engine/agent-session.test.ts
git commit -m "feat(runtime): wire file toolset into AgentSession and ConversationEngine with capability roles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: system prompt 文件工具纪律

**Files:**
- Modify: `packages/runtime/src/engine/system-prompt.ts`（BuildChatSystemPromptOptions :31、组装函数 :168-243）
- Test: `packages/runtime/src/engine/system-prompt.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 8 的 role 字符串 `"file-read"` / `"file-edit"`、工具 id `roll__read_file` 等四个
- Produces: `BuildChatSystemPromptOptions.fileToolIds?: FileToolPromptIds`，其中 `interface FileToolPromptIds { readonly read: string; readonly edit: string; readonly write: string; readonly listDir: string }`

- [ ] **Step 1: GitNexus impact 前置检查**

```
mcp__gitnexus__impact({target: "buildChatSystemPrompt", direction: "upstream", repo: "roll-agent"})
mcp__gitnexus__impact({target: "buildChatSystemPromptFromManifest", direction: "upstream", repo: "roll-agent"})
```

- [ ] **Step 2: 读现实现确认字段名**

Run: `sed -n 168,243p packages/runtime/src/engine/system-prompt.ts`

确认两件事：(a) `buildChatSystemPrompt` 的 section 组装顺序与既有 options 传递方式；(b) `buildChatSystemPromptFromManifest` 从 manifest 提取工具 id 的既有模式（manifest tool 条目有 `id` 与 `role` 字段，参照其处理 shell/skill 工具的写法）。下方代码按此模式校准。

- [ ] **Step 3: 写失败测试**

在 system-prompt.test.ts 追加（import 沿用文件既有形式）：

```ts
test("提供 fileToolIds 时注入文件工具纪律", () => {
  const prompt = buildChatSystemPrompt({
    fileToolIds: {
      read: "roll__read_file",
      edit: "roll__edit_file",
      write: "roll__write_file",
      listDir: "roll__list_dir",
    },
  });
  assert.match(prompt, /# 文件工具/u);
  assert.match(prompt, /行号前缀不是文件内容/u);
  assert.match(prompt, /先用 roll__read_file/u);
  assert.match(prompt, /edits 数组/u);
  assert.match(prompt, /无需再次读取确认/u);
});

test("未提供 fileToolIds 时不出现文件工具章节", () => {
  const prompt = buildChatSystemPrompt({});
  assert.doesNotMatch(prompt, /# 文件工具/u);
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/engine/system-prompt.test.ts`
Expected: FAIL（新用例，`fileToolIds` 属性不存在或章节缺失）

- [ ] **Step 5: 写实现**

`BuildChatSystemPromptOptions` 加字段：

```ts
export interface FileToolPromptIds {
  readonly read: string;
  readonly edit: string;
  readonly write: string;
  readonly listDir: string;
}
```

```ts
  readonly fileToolIds?: FileToolPromptIds;
```

新增 section 构造函数（与 `buildShellSection` 并列）：

```ts
function buildFileToolsSection(ids: FileToolPromptIds): string {
  return [
    "# 文件工具",
    `- 读文件用 ${ids.read}：输出每行带行号前缀（如 "   12→"），行号前缀不是文件内容，复制内容时必须去掉前缀。`,
    `- 修改文件前必须先用 ${ids.read} 读取；${ids.edit} 的 old_string 必须逐字复制读到的内容（不含行号前缀），包括缩进与标点。`,
    `- old_string 必须能唯一定位目标；同一文件的多处修改放进同一次 ${ids.edit} 调用的 edits 数组，一次提交。`,
    `- 新建文件或整文件重写用 ${ids.write}；浏览目录用 ${ids.listDir}。`,
    `- ${ids.edit} 与 ${ids.write} 成功的返回已附带修改点最新内容，无需再次读取确认。`,
    `- 读取和修改文件优先用文件工具，不要用 shell 的 cat/sed/echo 重定向操作文件。`,
  ].join("\n");
}
```

在 `buildChatSystemPrompt` 的 sections 组装中（skills 节之后、shell 节之前）插入：

```ts
  if (options.fileToolIds) {
    sections.push(buildFileToolsSection(options.fileToolIds));
  }
```

（若现实现不是 sections 数组而是其他拼接形式，按 Step 2 确认的实际形式等价插入。）

在 `buildChatSystemPromptFromManifest` 中，按该函数处理其他 role 的既有模式，从 manifest 提取四个工具 id 并传入：

```ts
  const fileRead = manifest.tools.find((tool) => tool.role === "file-read" && tool.id.endsWith("read_file"));
  const fileEdit = manifest.tools.find((tool) => tool.role === "file-edit" && tool.id.endsWith("edit_file"));
  const fileWrite = manifest.tools.find((tool) => tool.role === "file-edit" && tool.id.endsWith("write_file"));
  const fileList = manifest.tools.find((tool) => tool.role === "file-read" && tool.id.endsWith("list_dir"));
  const fileToolIds =
    fileRead && fileEdit && fileWrite && fileList
      ? { read: fileRead.id, edit: fileEdit.id, write: fileWrite.id, listDir: fileList.id }
      : undefined;
```

并在其调用 `buildChatSystemPrompt` 的 options 里加 `...(fileToolIds ? { fileToolIds } : {})`。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/runtime/src/engine/system-prompt.test.ts packages/runtime/src/engine/agent-session.test.ts`
Expected: 全 PASS（含既有用例回归）

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/engine/system-prompt.ts packages/runtime/src/engine/system-prompt.test.ts
git commit -m "feat(runtime): add file tools discipline section to chat system prompt

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: 全量回归 + changeset

**Files:**
- Create: `.changeset/chat-file-tools.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 可发布的 minor 变更声明

- [ ] **Step 1: 全仓检查**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: 全绿。lint 若报 file-tools 下格式问题先 `pnpm format` 再复跑。

- [ ] **Step 2: GitNexus 变更面核查**

```
mcp__gitnexus__detect_changes({scope: "working"})
```
确认受影响符号仅限本计划列出的文件；出现计划外符号时停下来向用户报告。

- [ ] **Step 3: 核对包名后写 changeset**

先核对真实包名（引用型标识符不凭记忆）：

```bash
node -e "console.log(require('./packages/runtime/package.json').name)"
```

创建 `.changeset/chat-file-tools.md`（`@roll-agent/runtime` 以上一步输出为准）：

```markdown
---
"@roll-agent/runtime": minor
---

roll chat 新增内建文件工具：roll__read_file / roll__edit_file / roll__write_file / roll__list_dir。按状态同步协议设计——read-before-edit 与内容 hash stale 检测、Unicode 归一化容错匹配（全角标点/智能引号/CRLF）、失败返回最近似位置与差异诊断、批量 edits 原子落盘、成功返回编辑点快照免二次读取。默认启用，可用 ConversationEngineOptions.fileToolsEnabled=false 关闭。
```

- [ ] **Step 4: 验证 changeset**

Run: `pnpm changeset status`
Expected: 列出 `@roll-agent/runtime` minor，无 "not in the workspace" 类错误

- [ ] **Step 5: Commit**

```bash
git add .changeset/chat-file-tools.md
git commit -m "chore: add changeset for chat file tools

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：设计文档 §4 四工具契约 → Task 4/5/6/7；§5.1 tracker → Task 3；§5.2 归一化 → Task 1；§5.3 诊断 → Task 2；§5.4 policy/capability → Task 8（annotations + roles）；§5.5 prompt → Task 9；§6 组装与默认开关 → Task 8；发布 → Task 10。§7 non-goals 无对应任务（有意）。
- **类型一致性**：`ResolvedFileToolsSettings` / `FileStateTracker.recordKnownContent/checkFreshness` / `MatchSpan` / `findOldString` / `build*Tool` 签名在 Task 间逐字一致；role 字符串 `"file-read"`/`"file-edit"` 在 Task 8 定义、Task 9 消费。
- **已知校准点**（执行者需现场核对，均已在对应 Step 标注）：`NormalizedToolResult` 的 outcome/display 字段名（Task 4 Step 3 注）、`ToolExecutionOptions` 测试构造形状（Task 8 Step 2 注）、system-prompt 组装的实际拼接形式（Task 9 Step 2）。

