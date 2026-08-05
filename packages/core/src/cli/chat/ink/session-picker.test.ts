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
  await delay(30);
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
