# roll chat `/resume` 会话切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `roll chat` 的 Ink TUI 与基础 REPL 中新增 `/resume` 命令,对话中随时列出已有会话并安全切换。

**Architecture:** 共享纯函数 formatter 生成会话行;Ink 侧 `ChatApp` 上提为壳组件(持 `activeSession` + picker 状态 + effect-based 退役收尾),会话作用域 UI 下沉为 `ChatSessionView key={session.id}`(keyed remount 自然重置 hook/state);REPL 侧 `runRepl` 的 session 改可变引用 + clack select。切换遵循"先 resume 成功再动旧会话"的失败安全顺序。

**Tech Stack:** TypeScript ESM(Node 22 type-stripping)、ink(fork)+ ink-testing-library、@clack/prompts、node:test + node:assert/strict。

**Spec:** `docs/superpowers/specs/2026-08-05-chat-session-resume-design.md`

**Impact 分析结论(已执行,GitNexus):** `runInkRepl`(直接调用者 1)、`runRepl`(0)、`ChatApp`(0)、`useSession`(1)均为 **LOW** 风险,CLI 叶子层,无受影响执行流。

## Global Constraints

- Node ≥22.6.0;开发/测试直接跑 .ts:`node --experimental-strip-types --test <file>`(在仓库根执行)
- 零 `any`;`exactOptionalPropertyTypes`(可选属性用条件展开 `...(x !== undefined ? { x } : {})`,不得赋 `undefined`);`noUncheckedIndexedAccess`(索引访问先存局部变量判空)
- `import type` 分离类型导入;相对导入路径**必须**带 `.ts` 扩展名;禁止 `enum`/`namespace`
- 核心代码**零注释**(WHAT/WHY 靠命名与 changeset)
- Ink 组件用 `createElement as h` 风格,无 JSX;Prettier 双引号/分号/尾逗号/100 字符行宽
- 每次 commit 前运行 GitNexus `detect_changes()`(scope: uncommitted)核对影响面;commit message 末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 新增/修改类型定义后用 `/typescript-magician` skill 审查(Task 1、4、5、6 各含一步)
- 所有面向用户文案为中文;日志走 stderr(`log.*`),stdout 只留数据

---

### Task 1: 共享会话行 formatter(`session-picker-format.ts`)

**Files:**
- Create: `packages/core/src/cli/chat/session-picker-format.ts`
- Test: `packages/core/src/cli/chat/session-picker-format.test.ts`

**Interfaces:**
- Consumes: 无(纯函数,零依赖)
- Produces(后续 Task 3/4/5/6 依赖,签名逐字):
  - `interface SessionPickerThread { readonly id: string; readonly title: string | undefined; readonly updatedAt: string }`
  - `interface SessionPickerItem { readonly id: string; readonly title: string; readonly meta: string }`
  - `interface BuildSessionPickerItemsOptions { readonly currentSessionId: string; readonly countMessages: (threadId: string) => number; readonly now: Date }`
  - `function formatRelativeTime(iso: string, now: Date): string`
  - `function buildSessionPickerItems(threads: readonly SessionPickerThread[], options: BuildSessionPickerItemsOptions): SessionPickerItem[]`

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionPickerItems,
  formatRelativeTime,
  type SessionPickerThread,
} from "./session-picker-format.ts";

const NOW = new Date("2026-08-05T12:00:00.000Z");

test("formatRelativeTime renders human-friendly buckets", () => {
  assert.equal(formatRelativeTime("2026-08-05T11:59:30.000Z", NOW), "刚刚");
  assert.equal(formatRelativeTime("2026-08-05T11:15:00.000Z", NOW), "45 分钟前");
  assert.equal(formatRelativeTime("2026-08-05T07:00:00.000Z", NOW), "5 小时前");
  assert.equal(formatRelativeTime("2026-08-02T12:00:00.000Z", NOW), "3 天前");
  assert.equal(formatRelativeTime("2026-06-01T12:00:00.000Z", NOW), "2026-06-01");
  assert.equal(formatRelativeTime("2026-08-05T12:00:30.000Z", NOW), "刚刚");
  assert.equal(formatRelativeTime("not-a-date", NOW), "");
});

test("buildSessionPickerItems excludes current session and falls back title", () => {
  const threads: SessionPickerThread[] = [
    { id: "current", title: "当前", updatedAt: "2026-08-05T11:00:00.000Z" },
    { id: "t1", title: "发布计划", updatedAt: "2026-08-05T10:00:00.000Z" },
    { id: "t2", title: undefined, updatedAt: "2026-08-04T12:00:00.000Z" },
  ];
  const counts: Record<string, number> = { t1: 12, t2: 3 };
  const items = buildSessionPickerItems(threads, {
    currentSessionId: "current",
    countMessages: (threadId) => counts[threadId] ?? 0,
    now: NOW,
  });
  assert.deepEqual(items, [
    { id: "t1", title: "发布计划", meta: "2 小时前 · 12 条消息" },
    { id: "t2", title: "（无标题）", meta: "1 天前 · 3 条消息" },
  ]);
});

test("buildSessionPickerItems omits empty relative time from meta", () => {
  const items = buildSessionPickerItems([{ id: "t1", title: "a", updatedAt: "bad" }], {
    currentSessionId: "x",
    countMessages: () => 1,
    now: NOW,
  });
  const first = items[0];
  assert.ok(first);
  assert.equal(first.meta, "1 条消息");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/core/src/cli/chat/session-picker-format.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```ts
export interface SessionPickerThread {
  readonly id: string;
  readonly title: string | undefined;
  readonly updatedAt: string;
}

export interface SessionPickerItem {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
}

export interface BuildSessionPickerItemsOptions {
  readonly currentSessionId: string;
  readonly countMessages: (threadId: string) => number;
  readonly now: Date;
}

const UNTITLED = "（无标题）";

export function formatRelativeTime(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "";
  }
  const diffMs = now.getTime() - then;
  if (diffMs < 60_000) {
    return "刚刚";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${String(minutes)} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${String(days)} 天前`;
  }
  return iso.slice(0, 10);
}

export function buildSessionPickerItems(
  threads: readonly SessionPickerThread[],
  options: BuildSessionPickerItemsOptions,
): SessionPickerItem[] {
  return threads
    .filter((thread) => thread.id !== options.currentSessionId)
    .map((thread) => {
      const relative = formatRelativeTime(thread.updatedAt, options.now);
      const parts = [relative, `${String(options.countMessages(thread.id))} 条消息`];
      return {
        id: thread.id,
        title: thread.title ?? UNTITLED,
        meta: parts.filter((part) => part.length > 0).join(" · "),
      };
    });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --experimental-strip-types --test packages/core/src/cli/chat/session-picker-format.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: `/typescript-magician` 审查新类型**(接口是否够窄、是否应从他处派生;本模块刻意结构化解耦 `ThreadRecord`,属预期设计)

- [ ] **Step 6: detect_changes 后提交**

```bash
git add packages/core/src/cli/chat/session-picker-format.ts packages/core/src/cli/chat/session-picker-format.test.ts
git commit -m "feat(core): add shared session picker row formatter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `/resume` 注册进 SLASH_COMMANDS

**Files:**
- Modify: `packages/core/src/cli/chat/ink/commands.ts:33-45`(`SLASH_COMMANDS` 数组)
- Test: `packages/core/src/cli/chat/ink/commands.test.ts`

**Interfaces:**
- Produces: `SLASH_COMMANDS` 含 `{ kind: "command", name: "/resume", description: "切换到已有会话" }`(Task 4 的 runSlash 分支与 `/help` 输出依赖该项)

- [ ] **Step 1: 写失败测试**(追加到 `commands.test.ts` 末尾)

```ts
test("filterSlashEntries matches /resume", () => {
  const entries = filterSlashEntries("/res");
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["/resume"],
  );
});
```

若文件顶部未导入 `filterSlashEntries` 则补充导入(该文件已有多个 filterSlashEntries 测试,大概率已导入)。

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/core/src/cli/chat/ink/commands.test.ts`
Expected: FAIL(`/res` 无匹配)

- [ ] **Step 3: 实现**——在 `SLASH_COMMANDS` 中 `/skills` 条目之后插入:

```ts
  { kind: "command", name: "/resume", description: "切换到已有会话" },
```

- [ ] **Step 4: 运行确认通过**

Run: `node --experimental-strip-types --test packages/core/src/cli/chat/ink/commands.test.ts`
Expected: PASS(全部,含既有测试——注意若既有测试对 SLASH_COMMANDS 数量/全集断言,需同步更新)

- [ ] **Step 5: detect_changes 后提交**

```bash
git add packages/core/src/cli/chat/ink/commands.ts packages/core/src/cli/chat/ink/commands.test.ts
git commit -m "feat(core): register /resume slash command

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Ink `SessionPicker` 组件

**Files:**
- Create: `packages/core/src/cli/chat/ink/session-picker.ts`
- Test: `packages/core/src/cli/chat/ink/session-picker.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SessionPickerItem`;`./commands.ts` 的 `truncateDisplay(text, maxWidth)`;`./display-width.ts` 的 `displayWidth`
- Produces(Task 4 依赖):

```ts
export interface SessionPickerProps {
  readonly items: readonly SessionPickerItem[];
  readonly width: number;
  readonly maxRows: number;
  readonly busy: boolean;
  readonly error?: string;
  readonly onSelect: (threadId: string) => void;
  readonly onCancel: () => void;
}
export function SessionPicker(props: SessionPickerProps): ReactElement;
```

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { SessionPicker } from "./session-picker.ts";
import type { SessionPickerItem } from "../session-picker-format.ts";

function items(count: number): SessionPickerItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${String(index)}`,
    title: `会话 ${String(index)}`,
    meta: `${String(index)} 小时前 · ${String(index)} 条消息`,
  }));
}

test("SessionPicker renders rows, moves cursor and selects with Enter", async () => {
  const selected: string[] = [];
  const { stdin, lastFrame, unmount } = render(
    h(SessionPicker, {
      items: items(3),
      width: 80,
      maxRows: 10,
      busy: false,
      onSelect: (threadId: string) => selected.push(threadId),
      onCancel: () => {},
    }),
  );
  await delay(10);
  assert.match(lastFrame() ?? "", /切换会话/);
  assert.match(lastFrame() ?? "", /› 会话 0/);
  assert.match(lastFrame() ?? "", /Enter 切换/);
  stdin.write("\x1b[B");
  await delay(10);
  assert.match(lastFrame() ?? "", /› 会话 1/);
  stdin.write("\r");
  await delay(10);
  assert.deepEqual(selected, ["t1"]);
  unmount();
});

test("SessionPicker cancels with Esc and shows empty state", async () => {
  let cancelled = 0;
  const { stdin, lastFrame, unmount } = render(
    h(SessionPicker, {
      items: [],
      width: 80,
      maxRows: 10,
      busy: false,
      onSelect: () => {},
      onCancel: () => {
        cancelled += 1;
      },
    }),
  );
  await delay(10);
  assert.match(lastFrame() ?? "", /暂无其他会话/);
  stdin.write("\x1b");
  await delay(10);
  assert.equal(cancelled, 1);
  unmount();
});

test("SessionPicker windows long lists following the cursor", async () => {
  const { stdin, lastFrame, unmount } = render(
    h(SessionPicker, {
      items: items(10),
      width: 80,
      maxRows: 6,
      busy: false,
      onSelect: () => {},
      onCancel: () => {},
    }),
  );
  await delay(10);
  assert.doesNotMatch(lastFrame() ?? "", /会话 9/);
  for (let index = 0; index < 9; index += 1) {
    stdin.write("\x1b[B");
  }
  await delay(20);
  assert.match(lastFrame() ?? "", /› 会话 9/);
  assert.doesNotMatch(lastFrame() ?? "", /会话 0/);
  unmount();
});

test("SessionPicker ignores input while busy and surfaces errors", async () => {
  const selected: string[] = [];
  const first = render(
    h(SessionPicker, {
      items: items(2),
      width: 80,
      maxRows: 10,
      busy: true,
      onSelect: (threadId: string) => selected.push(threadId),
      onCancel: () => {},
    }),
  );
  await delay(10);
  assert.match(first.lastFrame() ?? "", /切换中/);
  first.stdin.write("\r");
  await delay(10);
  assert.deepEqual(selected, []);
  first.unmount();

  const second = render(
    h(SessionPicker, {
      items: items(2),
      width: 80,
      maxRows: 10,
      busy: false,
      error: "线程不存在",
      onSelect: () => {},
      onCancel: () => {},
    }),
  );
  await delay(10);
  assert.match(second.lastFrame() ?? "", /切换失败：线程不存在/);
  second.unmount();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/core/src/cli/chat/ink/session-picker.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { truncateDisplay } from "./commands.ts";
import { displayWidth } from "./display-width.ts";
import type { SessionPickerItem } from "../session-picker-format.ts";

export interface SessionPickerProps {
  readonly items: readonly SessionPickerItem[];
  readonly width: number;
  readonly maxRows: number;
  readonly busy: boolean;
  readonly error?: string;
  readonly onSelect: (threadId: string) => void;
  readonly onCancel: () => void;
}

export function SessionPicker(props: SessionPickerProps): ReactElement {
  const { items, busy, onSelect, onCancel } = props;
  const [cursor, setCursor] = useState(0);
  const boundedCursor = Math.min(cursor, Math.max(0, items.length - 1));

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (items.length === 0) {
      return;
    }
    if (key.upArrow) {
      setCursor(Math.max(0, boundedCursor - 1));
      return;
    }
    if (key.downArrow) {
      setCursor(Math.min(items.length - 1, boundedCursor + 1));
      return;
    }
    if (key.return || input.includes("\r") || input.includes("\n")) {
      const item = items[boundedCursor];
      if (item) {
        onSelect(item.id);
      }
    }
  });

  const chromeRows = 2 + (props.error === undefined ? 0 : 1);
  const visibleRows = Math.max(1, Math.floor(props.maxRows) - chromeRows);
  const windowStart = Math.min(
    Math.max(0, boundedCursor - visibleRows + 1),
    Math.max(0, items.length - visibleRows),
  );
  const visible = items.slice(windowStart, windowStart + visibleRows);
  const contentWidth = Math.max(10, props.width - 2);

  return h(
    Box,
    {
      flexDirection: "column",
      width: props.width,
      maxHeight: Math.max(3, Math.floor(props.maxRows)),
      paddingX: 1,
      flexShrink: 0,
      overflowY: "hidden",
    },
    h(Text, { bold: true }, "切换会话"),
    props.error === undefined
      ? null
      : h(Text, { color: "red" }, truncateDisplay(`切换失败：${props.error}`, contentWidth)),
    items.length === 0
      ? h(Text, { dimColor: true }, "暂无其他会话")
      : h(
          Box,
          { flexDirection: "column", flexShrink: 0 },
          ...visible.map((item, index) => {
            const active = windowStart + index === boundedCursor;
            const marker = active ? "› " : "  ";
            const title = truncateDisplay(
              item.title,
              Math.max(4, contentWidth - displayWidth(marker) - displayWidth(item.meta) - 2),
            );
            return h(
              Box,
              { key: item.id },
              h(Text, active ? { color: "green", bold: true } : {}, `${marker}${title}`),
              h(Text, { dimColor: true }, `  ${item.meta}`),
            );
          }),
        ),
    h(
      Text,
      { dimColor: true },
      busy ? "切换中…" : items.length === 0 ? "Esc 返回" : "↑↓ 选择 · Enter 切换 · Esc 取消",
    ),
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --experimental-strip-types --test packages/core/src/cli/chat/ink/session-picker.test.ts`
Expected: PASS(4 tests)。若窗口化断言因 chrome 行数与实现有出入,以"光标始终可见、超出部分裁剪"为准修实现,不放宽断言。

- [ ] **Step 5: `/typescript-magician` 审查 `SessionPickerProps`**

- [ ] **Step 6: detect_changes 后提交**

```bash
git add packages/core/src/cli/chat/ink/session-picker.ts packages/core/src/cli/chat/ink/session-picker.test.ts
git commit -m "feat(core): add ink session picker component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `ChatApp` 壳化 + `ChatSessionView` keyed remount + picker 接线

**Files:**
- Modify: `packages/core/src/cli/chat/ink/app.ts`(整体重构,原函数体迁入 `ChatSessionView`)
- Test: `packages/core/src/cli/chat/ink/app.test.ts`

**Interfaces:**
- Consumes: Task 1 `SessionPickerItem`、Task 3 `SessionPicker`、`./history-from-messages.ts` 的 `messagesToHistory`
- Produces(Task 5 依赖,签名逐字):

```ts
export interface ChatSessionSwitching {
  readonly loadItems: (currentSessionId: string) => readonly SessionPickerItem[];
  readonly resume: (threadId: string) => Promise<AgentSession>;
  readonly onRetired: (threadId: string) => void;
}
```

`ChatAppProps` 变更:新增可选 `readonly sessionSwitching?: ChatSessionSwitching`;**删除** `contextWindow` 与 `availableSkills`(改由视图从 session 派生:`session.getContextWindow()` / `session.getSkillSummaries()`)。

- [ ] **Step 1: 写失败测试**(追加到 `app.test.ts`;先读文件顶部既有 fake session/工具,新测试用下面独立的 fake 工厂,避免耦合既有 helper)

```ts
function switchableFakeSession(
  id: string,
  messages: readonly { role: string; content: string }[] = [],
): {
  readonly session: AgentSession;
  readonly sent: () => readonly string[];
  readonly isClosed: () => boolean;
} {
  let closed = false;
  const sent: string[] = [];
  const session = {
    id,
    send: (text: string) => {
      sent.push(text);
      return (async function* (): AsyncGenerator<never> {})();
    },
    compact: () => (async function* (): AsyncGenerator<never> {})(),
    cancel: () => false,
    approve: () => {},
    reject: () => {},
    close: async () => {
      closed = true;
    },
    getMessages: () => messages,
    getContextWindow: () => undefined,
    getSkillSummaries: () => [],
    setUserInputAvailable: () => {},
    resolveUserInput: () => {},
    cancelUserInput: () => {},
  } as unknown as AgentSession;
  return { session, sent: () => sent, isClosed: () => closed };
}

test("ChatApp switches sessions via /resume picker", async () => {
  const first = switchableFakeSession("s1");
  const second = switchableFakeSession("s2", [
    { role: "user", content: "旧消息" },
    { role: "assistant", content: "旧回复" },
  ]);
  const retired: string[] = [];
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: first.session,
      model: "test-model",
      onUserSubmit: () => {},
      onExit: () => {},
      sessionSwitching: {
        loadItems: () => [{ id: "t2", title: "发布计划", meta: "2 小时前 · 2 条消息" }],
        resume: async () => second.session,
        onRetired: (threadId: string) => retired.push(threadId),
      },
    }),
  );
  await delay(20);
  stdin.write("/resume");
  await delay(20);
  stdin.write("\r");
  await delay(20);
  assert.match(lastFrame() ?? "", /切换会话/);
  assert.match(lastFrame() ?? "", /发布计划/);
  stdin.write("\r");
  await delay(50);
  assert.match(lastFrame() ?? "", /旧消息/);
  assert.equal(first.isClosed(), true);
  assert.deepEqual(retired, ["s1"]);
  stdin.write("hello");
  await delay(20);
  stdin.write("\r");
  await delay(30);
  assert.deepEqual(second.sent(), ["hello"]);
  assert.deepEqual(first.sent(), []);
  unmount();
});

test("ChatApp keeps current session when resume fails", async () => {
  const first = switchableFakeSession("s1");
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: first.session,
      model: "test-model",
      onUserSubmit: () => {},
      onExit: () => {},
      sessionSwitching: {
        loadItems: () => [{ id: "t2", title: "发布计划", meta: "2 小时前 · 2 条消息" }],
        resume: async () => {
          throw new Error("线程不存在");
        },
        onRetired: () => {},
      },
    }),
  );
  await delay(20);
  stdin.write("/resume");
  await delay(20);
  stdin.write("\r");
  await delay(20);
  stdin.write("\r");
  await delay(50);
  assert.match(lastFrame() ?? "", /切换失败：线程不存在/);
  assert.equal(first.isClosed(), false);
  stdin.write("\x1b");
  await delay(20);
  stdin.write("hi");
  await delay(20);
  stdin.write("\r");
  await delay(30);
  assert.deepEqual(first.sent(), ["hi"]);
  unmount();
});

test("ChatApp reports notice when session switching is unavailable", async () => {
  const first = switchableFakeSession("s1");
  const { stdin, lastFrame, unmount } = render(
    h(ChatApp, {
      session: first.session,
      model: "test-model",
      onUserSubmit: () => {},
      onExit: () => {},
    }),
  );
  await delay(20);
  stdin.write("/resume");
  await delay(20);
  stdin.write("\r");
  await delay(30);
  assert.match(lastFrame() ?? "", /当前界面不支持会话切换/);
  unmount();
});
```

注意:`/resume` 输入后弹出 slash popup 且 `/resume` 为唯一匹配,`\r` 走 `onSlashRun` 精确命中执行。若既有测试构造 ChatApp 时传了 `contextWindow`/`availableSkills` props,本任务 Step 3 移除这两个 props 后需同步改这些调用点:删掉这两项,并给其 fake session 补 `getContextWindow: () => undefined` 与 `getSkillSummaries: () => <原 availableSkills 值>`。

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/core/src/cli/chat/ink/app.test.ts`
Expected: 新增 3 个测试 FAIL(`sessionSwitching` 属性不存在 / 无 picker 行为)

- [ ] **Step 3: 重构 app.ts**

3a. 顶部新增导入:

```ts
import { useEffect, useRef } from "react"; // 并入既有 react 导入
import { SessionPicker } from "./session-picker.ts";
import { messagesToHistory } from "./history-from-messages.ts";
import type { SessionPickerItem } from "../session-picker-format.ts";
```

3b. Props 类型:

```ts
export interface ChatSessionSwitching {
  readonly loadItems: (currentSessionId: string) => readonly SessionPickerItem[];
  readonly resume: (threadId: string) => Promise<AgentSession>;
  readonly onRetired: (threadId: string) => void;
}

export interface ChatAppProps {
  readonly session: AgentSession;
  readonly model: string;
  readonly initialHistory?: readonly HistoryItem[];
  readonly banner?: BannerInfo;
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
  readonly onUserSubmit: (text: string) => void;
  readonly onExit: () => void;
  readonly sessionSwitching?: ChatSessionSwitching;
}
```

3c. 原 `ChatApp` 函数体整体改名为内部组件 `ChatSessionView`(不导出),其 props 在 `ChatAppProps` 基础上去掉 `sessionSwitching`、加上:

```ts
interface ChatSessionViewProps extends Omit<ChatAppProps, "sessionSwitching"> {
  readonly picker: SessionPickerState | undefined;
  readonly onOpenPicker: () => boolean;
  readonly onPickerSelect: (threadId: string) => void;
  readonly onPickerCancel: () => void;
}

interface SessionPickerState {
  readonly items: readonly SessionPickerItem[];
  readonly busy: boolean;
  readonly error?: string;
}
```

`ChatSessionView` 内部修改点(其余照旧):

- `contextWindow`/`availableSkills` 改为派生:`const contextWindow = session.getContextWindow();` `const availableSkills = session.getSkillSummaries();`
- 顶层 `useInput` 第一行加 `if (props.picker !== undefined) { return; }`
- `runSlash` 在 `/exit` 分支之前加:

```ts
    if (name === "/resume") {
      if (!props.onOpenPicker()) {
        commitHistory({ kind: "notice", id: randomUUID(), text: "当前界面不支持会话切换" });
      }
      return;
    }
```

- `footer` 三元链最外层先判 picker:

```ts
  const footer =
    props.picker !== undefined
      ? h(SessionPicker, {
          items: props.picker.items,
          busy: props.picker.busy,
          ...(props.picker.error !== undefined ? { error: props.picker.error } : {}),
          width: layout.columns,
          maxRows: layout.promptRows + layout.popupRows,
          onSelect: props.onPickerSelect,
          onCancel: props.onPickerCancel,
        })
      : /* 原 confirm / userInput / TextPrompt 链不变 */
```

- `TranscriptViewport` 的 `navigationBlocked` 追加 `|| props.picker !== undefined`

3d. 新的壳 `ChatApp`:

```ts
export function ChatApp(props: ChatAppProps): ReactElement {
  const [activeSession, setActiveSession] = useState(props.session);
  const [sessionHistory, setSessionHistory] = useState<readonly HistoryItem[] | undefined>(
    props.initialHistory,
  );
  const [picker, setPicker] = useState<SessionPickerState | undefined>(undefined);
  const retiringRef = useRef<AgentSession | undefined>(undefined);
  const sessionSwitching = props.sessionSwitching;

  useEffect(() => {
    const retiring = retiringRef.current;
    if (retiring === undefined || retiring === activeSession) {
      return;
    }
    retiringRef.current = undefined;
    const finish = (): void => {
      sessionSwitching?.onRetired(retiring.id);
    };
    void retiring.close().then(finish, finish);
  }, [activeSession, sessionSwitching]);

  const openPicker = useCallback((): boolean => {
    if (sessionSwitching === undefined) {
      return false;
    }
    setPicker({ items: sessionSwitching.loadItems(activeSession.id), busy: false });
    return true;
  }, [sessionSwitching, activeSession]);

  const cancelPicker = useCallback(() => {
    setPicker(undefined);
  }, []);

  const selectSession = useCallback(
    (threadId: string) => {
      if (sessionSwitching === undefined) {
        return;
      }
      setPicker((current) =>
        current === undefined ? current : { items: current.items, busy: true },
      );
      sessionSwitching.resume(threadId).then(
        (next) => {
          retiringRef.current = activeSession;
          setSessionHistory(messagesToHistory(next.getMessages()));
          setActiveSession(next);
          setPicker(undefined);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setPicker((current) =>
            current === undefined
              ? current
              : { items: current.items, busy: false, error: message },
          );
        },
      );
    },
    [sessionSwitching, activeSession],
  );

  return h(ChatSessionView, {
    key: activeSession.id,
    session: activeSession,
    model: props.model,
    onUserSubmit: props.onUserSubmit,
    onExit: props.onExit,
    ...(sessionHistory !== undefined ? { initialHistory: sessionHistory } : {}),
    ...(props.banner !== undefined ? { banner: props.banner } : {}),
    ...(props.initialThinkingLevel !== undefined
      ? { initialThinkingLevel: props.initialThinkingLevel }
      : {}),
    ...(props.onThinkingChange !== undefined ? { onThinkingChange: props.onThinkingChange } : {}),
    picker,
    onOpenPicker: openPicker,
    onPickerSelect: selectSession,
    onPickerCancel: cancelPicker,
  });
}
```

3e. 调整 `run-ink-repl.ts` 调用点使 typecheck 过(仅删除两个已不存在的 props,`sessionSwitching` 留到 Task 5):删掉 `contextWindow: session.getContextWindow(),` 与 `availableSkills: session.getSkillSummaries(),` 两行。

- [ ] **Step 4: 运行确认通过**

Run: `node --experimental-strip-types --test packages/core/src/cli/chat/ink/app.test.ts`
Expected: PASS(全部,含按 Step 1 备注适配的既有测试)
Run: `pnpm --filter @roll-agent/core typecheck`
Expected: 通过

- [ ] **Step 5: `/typescript-magician` 审查 `ChatSessionSwitching`/`ChatSessionViewProps`(`Omit` 派生是否恰当)**

- [ ] **Step 6: detect_changes 后提交**

```bash
git add packages/core/src/cli/chat/ink/app.ts packages/core/src/cli/chat/ink/app.test.ts packages/core/src/cli/chat/ink/run-ink-repl.ts
git commit -m "feat(core): switch chat sessions in ink via keyed session view

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `runInkRepl` 活跃会话记账 + `chat.ts` Ink 接线

**Files:**
- Modify: `packages/core/src/cli/chat/ink/run-ink-repl.ts`
- Modify: `packages/core/src/cli/commands/chat.ts`(`runInkRepl` 调用点,约 :769)

**Interfaces:**
- Consumes: Task 1 `buildSessionPickerItems`、Task 4 `ChatSessionSwitching`
- Produces:
  - `InkReplStore` 新增 `listThreads(): ReadonlyArray<{ readonly id: string; readonly title: string | undefined; readonly updatedAt: string }>`
  - `RunInkReplOptions` 新增 `readonly resumeSession?: (threadId: string) => Promise<AgentSession>` 与 `readonly onActiveSessionChange?: (session: AgentSession) => void`

- [ ] **Step 1: 实现 run-ink-repl.ts**(该文件无独立测试,由 app.test + typecheck + Task 7 PTY 走查覆盖;先改代码再跑验证)

接口扩展:

```ts
export interface InkReplThreadSummary {
  readonly id: string;
  readonly title: string | undefined;
  readonly updatedAt: string;
}

export interface InkReplStore {
  updateTitle(threadId: string, title: string): void;
  countMessages(threadId: string): number;
  deleteThread(threadId: string): void;
  listThreads(): readonly InkReplThreadSummary[];
}

export interface RunInkReplOptions {
  readonly model: string;
  readonly banner?: BannerInfo;
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
  readonly onStarted?: () => void;
  readonly signal?: AbortSignal;
  readonly resumeSession?: (threadId: string) => Promise<AgentSession>;
  readonly onActiveSessionChange?: (session: AgentSession) => void;
}
```

函数体记账改造(替换现有 `submitted`/`titled` 与 `onUserSubmit`,新增 `active`):

```ts
  let active = session;
  let titled = !isNewSession;
  const initial = { id: session.id, isNew: isNewSession, submitted: false };

  const onUserSubmit = (text: string): void => {
    if (active.id === initial.id) {
      initial.submitted = true;
    }
    if (!titled) {
      store.updateTitle(active.id, titleFromMessage(text));
      titled = true;
    }
  };

  const resumeSession = options.resumeSession;
  const sessionSwitching =
    resumeSession === undefined
      ? undefined
      : {
          loadItems: (currentSessionId: string) =>
            buildSessionPickerItems(store.listThreads(), {
              currentSessionId,
              countMessages: (threadId) => store.countMessages(threadId),
              now: new Date(),
            }),
          resume: async (threadId: string) => {
            const next = await resumeSession(threadId);
            active = next;
            titled =
              store.listThreads().find((thread) => thread.id === next.id)?.title !== undefined;
            options.onActiveSessionChange?.(next);
            return next;
          },
          onRetired: (threadId: string) => {
            if (
              initial.isNew &&
              threadId === initial.id &&
              !initial.submitted &&
              store.countMessages(threadId) === 0
            ) {
              store.deleteThread(threadId);
            }
          },
        };
```

渲染处传 `...(sessionSwitching !== undefined ? { sessionSwitching } : {})`(并保留 Task 4 已做的 props 删减)。`initialHistory` 的 `priorHistory` 计算不变。

退出路径把所有 `session` 引用换成 `active`,清理条件换成 initial 记账:

```ts
  await active.close();

  if (
    initial.isNew &&
    active.id === initial.id &&
    !initial.submitted &&
    store.countMessages(active.id) === 0
  ) {
    store.deleteThread(active.id);
    process.stderr.write("本次会话无消息，未保存\n");
    return;
  }

  const messageCount = active
    .getMessages()
    .filter((message) => message.role === "user" || message.role === "assistant").length;
  process.stderr.write(
    `会话 ${active.id} · ${String(messageCount)} 条消息\n继续：roll chat --session ${active.id}\n`,
  );
```

新导入:`import { buildSessionPickerItems } from "../session-picker-format.ts";`

- [ ] **Step 2: chat.ts Ink 调用点接线**

在 `signalScope.setEngine(engine);` 之后(engine 已非空)加 `const chatEngine = engine;`,`runInkRepl(session, store, isNewSession, {...})` 的 options 增加:

```ts
              resumeSession: (threadId) => chatEngine.resumeSession(threadId),
              onActiveSessionChange: (next) => {
                sessionForCleanup = next;
              },
```

(`sessionForCleanup` 更新保证 chat.ts `finally` 段 :808 关闭的是最终活跃会话;active 会话被 runInkRepl 与 finally 双重 close 是既有行为,close 幂等。)

- [ ] **Step 3: 验证**

Run: `pnpm --filter @roll-agent/core typecheck && node --experimental-strip-types --test packages/core/src/cli/chat/ink/app.test.ts`
Expected: 均通过(`ThreadStore` 已有 `listThreads()`,结构化满足 `InkReplStore` 扩展)

- [ ] **Step 4: `/typescript-magician` 审查 `InkReplThreadSummary`/`RunInkReplOptions` 扩展**

- [ ] **Step 5: detect_changes 后提交**

```bash
git add packages/core/src/cli/chat/ink/run-ink-repl.ts packages/core/src/cli/commands/chat.ts
git commit -m "feat(core): wire ink session switching to the conversation engine

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 基础 REPL `/resume`(clack select)

**Files:**
- Create: `packages/core/src/cli/utils/clack-session-picker.ts`
- Modify: `packages/core/src/cli/commands/chat.ts`(`ReplIo` :101-107、`runRepl` :470-561、REPL 调用点 :794)
- Test: `packages/core/src/cli/commands/chat.test.ts`

**Interfaces:**
- Consumes: Task 1 `SessionPickerItem`/`buildSessionPickerItems`
- Produces:
  - `clackSessionPicker(items: readonly SessionPickerItem[]): Promise<string | undefined>`(undefined = 取消)
  - `ReplIo` 新增 `readonly resumeSession?: (threadId: string) => Promise<AgentSession>`、`readonly sessionPicker?: (items: readonly SessionPickerItem[]) => Promise<string | undefined>`、`readonly onActiveSessionChange?: (session: AgentSession) => void`

- [ ] **Step 1: 写失败测试**(追加到 `chat.test.ts`;先读该文件既有 runRepl 测试的 stream 驱动方式,fake session/store 按下方定义,输入节奏对齐既有测试的 delay 用法)

```ts
test("runRepl switches sessions via /resume", async () => {
  const first = replFakeSession("s1");
  const second = replFakeSession("s2");
  const deleted: string[] = [];
  const switched: string[] = [];
  const store = {
    listThreads: () => [
      { id: "s1", title: "当前", updatedAt: "2026-08-05T10:00:00.000Z" },
      { id: "t2", title: "发布计划", updatedAt: "2026-08-05T09:00:00.000Z" },
    ],
    countMessages: () => 2,
    getThread: (threadId: string) =>
      threadId === "s2" ? { id: "s2", title: "发布计划" } : undefined,
    updateTitle: () => {},
    deleteThread: (threadId: string) => deleted.push(threadId),
  } as unknown as ThreadStoreInstance;
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const done = runRepl(first.session, store, false, {
    input,
    output,
    sessionPicker: async (items) => {
      assert.deepEqual(
        items.map((item) => item.id),
        ["t2"],
      );
      return "t2";
    },
    resumeSession: async () => second.session,
    onActiveSessionChange: (next) => switched.push(next.id),
  });
  await delay(50);
  input.write("/resume\n");
  await delay(50);
  input.write("hi\n");
  await delay(50);
  input.write("exit\n");
  await done;
  assert.deepEqual(switched, ["s2"]);
  assert.equal(first.isClosed(), true);
  assert.deepEqual(second.sent(), ["hi"]);
  assert.deepEqual(first.sent(), []);
  assert.deepEqual(deleted, []);
});

test("runRepl keeps current session when picker cancels or resume fails", async () => {
  const first = replFakeSession("s1");
  const store = {
    listThreads: () => [{ id: "t2", title: "发布计划", updatedAt: "2026-08-05T09:00:00.000Z" }],
    countMessages: () => 2,
    getThread: () => undefined,
    updateTitle: () => {},
    deleteThread: () => {},
  } as unknown as ThreadStoreInstance;
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let call = 0;
  const done = runRepl(first.session, store, false, {
    input,
    output,
    sessionPicker: async () => {
      call += 1;
      return call === 1 ? undefined : "t2";
    },
    resumeSession: async () => {
      throw new Error("线程不存在");
    },
  });
  await delay(50);
  input.write("/resume\n");
  await delay(50);
  input.write("/resume\n");
  await delay(50);
  input.write("hi\n");
  await delay(50);
  input.write("exit\n");
  await done;
  assert.equal(first.isClosed(), false);
  assert.deepEqual(first.sent(), ["hi"]);
});
```

`replFakeSession` fake 工厂(若文件已有等价 helper 则复用并按需补方法):

```ts
function replFakeSession(id: string): {
  readonly session: AgentSession;
  readonly sent: () => readonly string[];
  readonly isClosed: () => boolean;
} {
  let closed = false;
  const sent: string[] = [];
  const session = {
    id,
    send: (text: string) => {
      sent.push(text);
      return (async function* (): AsyncGenerator<never> {})();
    },
    close: async () => {
      closed = true;
    },
    getMessages: () => [],
    getContextWindow: () => undefined,
    getSkillSummaries: () => [],
    setUserInputAvailable: () => {},
  } as unknown as AgentSession;
  return { session, sent: () => sent, isClosed: () => closed };
}
```

需要的新导入(若缺):`PassThrough` from `node:stream`、`delay` from `node:timers/promises`。

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/core/src/cli/commands/chat.test.ts`
Expected: 新增 2 个测试 FAIL(`/resume` 被当普通消息发送,`first.sent()` 含 "/resume")

- [ ] **Step 3: 实现**

3a. `clack-session-picker.ts`:

```ts
import { isCancel, select } from "@clack/prompts";
import type { SessionPickerItem } from "../chat/session-picker-format.ts";

export async function clackSessionPicker(
  items: readonly SessionPickerItem[],
): Promise<string | undefined> {
  const answer = await select<string>({
    message: "切换会话",
    options: items.map((item) => ({ value: item.id, label: item.title, hint: item.meta })),
  });
  return isCancel(answer) ? undefined : answer;
}
```

(若 `select` 泛型/Option 形状与本仓 @clack/prompts 版本不符,参照 `cli/utils/user-input-prompts.ts:150-174` 的 clackSelect 用法对齐。)

3b. `chat.ts` 的 `ReplIo` 增加三个可选字段(签名见 Interfaces);新导入:

```ts
import { buildSessionPickerItems } from "../chat/session-picker-format.ts";
import { clackSessionPicker } from "../utils/clack-session-picker.ts";
```

3c. `runRepl` 改造:`const availableSkills`/`const renderer` 改 `let`;`let titled`/`let submitted` 替换为:

```ts
  let titled = !isNewSession;
  const initial = { id: session.id, isNew: isNewSession, submitted: false };
```

原 `submitted = true;` 处改为 `if (session.id === initial.id) { initial.submitted = true; }`;`finally` 里的清理条件改为:

```ts
      if (
        initial.isNew &&
        session.id === initial.id &&
        !initial.submitted &&
        store.countMessages(session.id) === 0
      ) {
        store.deleteThread(session.id);
      }
```

在 `/skills` 分支之后加 `/resume` 分支:

```ts
      if (input === "/resume") {
        if (io.resumeSession === undefined) {
          log.info("当前模式不支持会话切换");
          continue;
        }
        const items = buildSessionPickerItems(store.listThreads(), {
          currentSessionId: session.id,
          countMessages: (threadId) => store.countMessages(threadId),
          now: new Date(),
        });
        if (items.length === 0) {
          log.info("暂无其他会话");
          continue;
        }
        rl.pause();
        const targetId = await (io.sessionPicker ?? clackSessionPicker)(items);
        if (targetId === undefined) {
          continue;
        }
        let next: AgentSession;
        try {
          next = await io.resumeSession(targetId);
        } catch (error) {
          log.error(`切换失败：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const previous = session;
        previous.setUserInputAvailable(false);
        await previous.close();
        if (
          initial.isNew &&
          previous.id === initial.id &&
          !initial.submitted &&
          store.countMessages(previous.id) === 0
        ) {
          store.deleteThread(previous.id);
        }
        session = next;
        session.setUserInputAvailable(true);
        renderer = new ChatRenderer(confirmFn, session.getContextWindow(), io.signal, userInputPrompt);
        availableSkills = session.getSkillSummaries();
        const record = store.getThread(session.id);
        titled = record?.title !== undefined;
        io.onActiveSessionChange?.(session);
        log.info(
          `已切换到会话 ${session.id}${record?.title === undefined ? "" : ` · ${record.title}`}`,
        );
        continue;
      }
```

(参数 `session` 是可变绑定,直接重赋值;`finally` 段 `session.setUserInputAvailable(false)` 自动作用于最终活跃会话。)

3d. `chat.ts` REPL 调用点(:794 `runRepl(session, store, isNewSession, {...})`)增加:

```ts
            resumeSession: (threadId) => chatEngine.resumeSession(threadId),
            onActiveSessionChange: (next) => {
              sessionForCleanup = next;
            },
```

(`chatEngine` 别名在 Task 5 已建立;若 REPL 路径在其作用域外,则在该路径同样以 `const chatEngine = engine;` 收窄。)

- [ ] **Step 4: 运行确认通过**

Run: `node --experimental-strip-types --test packages/core/src/cli/commands/chat.test.ts && pnpm --filter @roll-agent/core typecheck`
Expected: 全部 PASS(含既有 runRepl 测试)

- [ ] **Step 5: `/typescript-magician` 审查 `ReplIo` 扩展与 `clackSessionPicker` 签名**

- [ ] **Step 6: detect_changes 后提交**

```bash
git add packages/core/src/cli/utils/clack-session-picker.ts packages/core/src/cli/commands/chat.ts packages/core/src/cli/commands/chat.test.ts
git commit -m "feat(core): add /resume session switching to the basic repl

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: changeset + 全量验证 + tmux PTY 走查

**Files:**
- Create: `.changeset/chat-session-resume.md`

- [ ] **Step 1: changeset**

```md
---
"@roll-agent/core": minor
---

roll chat 新增 /resume 命令：Ink TUI 与基础 REPL 均可在对话中列出已有会话并切换。切换先恢复目标会话成功后才关闭当前会话，失败时当前会话不受影响；切走的零消息新会话自动清理；Ink 侧切换后完整重建 transcript 历史。
```

- [ ] **Step 2: 全量验证**

```bash
pnpm --filter @roll-agent/core typecheck
pnpm --filter @roll-agent/core lint
pnpm format:check   # 仅关注本轮改动文件
pnpm --filter @roll-agent/core test
```

Expected: typecheck/lint 通过;core 测试全绿(既知环境性失败 `cli/commands/ui.test.ts` 的 config-discovery 断言除外,见 PR #197-#201 记录);format:check 若报仓库既有未格式化文件,只需确认本轮文件不在列表。

- [ ] **Step 3: tmux PTY 走查**(依据 memory:Ink TUI 必须 tmux send-keys + capture-pane,不用 expect)

准备隔离环境(scratchpad 下,不碰真实 `~/.roll-agent`):

```bash
SCRATCH=<scratchpad>/resume-walkthrough
mkdir -p "$SCRATCH/threads"
cat > "$SCRATCH/roll.config.yaml" <<'EOF'
runtime:
  threads-dir: <SCRATCH 绝对路径>/threads
EOF
# 其余配置沿用仓库根 roll.config.yaml 的 provider 设置,复制后仅覆盖 threads-dir
node --experimental-strip-types -e '
import { ThreadStore } from "./packages/runtime/src/index.ts";
const store = new ThreadStore(process.argv[1]);
const a = store.createThread({ title: "发布计划讨论" });
store.appendMessages(a, [{ role: "user", content: "计划是什么" }, { role: "assistant", content: "分三步走" }]);
const b = store.createThread({ title: "线上问题排查" });
store.appendMessages(b, [{ role: "user", content: "报错日志" }]);
store.close();
' "$SCRATCH/threads"
tmux new-session -d -s resume-check -x 100 -y 30 "pnpm dev -- chat --config $SCRATCH/roll.config.yaml"
```

走查步骤(每步 `tmux send-keys -t resume-check ... ` 后 `capture-pane -p` 断言;send-keys 文本后必须补 Enter 键):

1. 输入 `/resume` + Enter → 断言 picker 出现,两个会话行含"发布计划讨论""线上问题排查"与相对时间/条数
2. ↓ + Enter 选中一个 → 断言 transcript 重建出该线程历史("计划是什么"/"分三步走"),状态栏正常,TextPrompt 恢复
3. 再 `/resume` → 断言列表**排除当前会话**,Esc → 断言回到输入框、无副作用
4. `/exit` → 断言退出摘要指向切换后的会话 id;初始空会话未被保存(store 无第三条线程)
5. `tmux kill-session -t resume-check`;基础 REPL 走查:`pnpm dev -- chat --config ... --screen-mode inline`(若该值不对,以 `CHAT_SCREEN_MODES` 实际取值为准)重复 1-3 验证 clack picker
6. 清理 `$SCRATCH`

(picker/切换全程不需要 LLM 响应,无 API key 也可走查;若 engine 构造要求 key,在 config 中放假 key,不发消息即可。)

- [ ] **Step 4: detect_changes(scope: uncommitted → 空;scope: compare base_ref main → 应仅命中 chat CLI 域符号)后提交收尾**

```bash
git add .changeset/chat-session-resume.md
git commit -m "chore: add changeset for chat session resume

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: 按需 `node .gitnexus/run.cjs analyze` 刷新索引,向用户汇报走查结果与截图/capture 摘要**

---

## Self-Review 记录

- **Spec 覆盖**:命令注册(T2)、共享 formatter/注入 now(T1)、Ink picker 占 footer 槽位(T3/T4)、keyed remount + effect-based handoff + 失败安全顺序(T4)、活跃会话追踪/空会话静默清理/titled 记账(T5)、REPL clack picker/renderer 重建/rl.pause(T6)、changeset minor + PTY 走查(T7)。spec"边界"三项(picker 过滤、/new、REPL 历史回放)均未实现,符合预期。
- **类型一致性**:`SessionPickerItem`(T1→T3/T4/T5/T6)、`ChatSessionSwitching`(T4→T5)、`resumeSession?: (threadId: string) => Promise<AgentSession>`(T5/T6 与 chat.ts 闭包)已逐字对齐。
- **已知留白(有意)**:app.test/chat.test 的既有 fake 适配以"执行时读文件"为准,新测试自带独立 fake 不耦合;clack select 泛型以仓内版本为准(给了参照位置)。
