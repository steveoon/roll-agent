import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import { SessionPicker } from "./session-picker.ts";
import type { SessionPickerItem } from "../session-picker-format.ts";
import { buildSessionPickerItems } from "../session-picker-format.ts";
import { displayWidth } from "./display-width.ts";

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
  assert.match(lastFrame() ?? "", /对话历史/);
  assert.match(lastFrame() ?? "", /❯ 会话 0\s{2,}0 小时前 · 0 条消息/);
  assert.match(lastFrame() ?? "", /共 3 个会话/);
  assert.match(lastFrame() ?? "", /Enter 切换/);
  stdin.write("\x1b[B");
  await delay(10);
  assert.match(lastFrame() ?? "", /❯ 会话 1/);
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
  assert.match(lastFrame() ?? "", /1\/10 · ↑↓/);
  for (let index = 0; index < 9; index += 1) {
    stdin.write("\x1b[B");
  }
  await delay(20);
  assert.match(lastFrame() ?? "", /❯ 会话 9/);
  assert.match(lastFrame() ?? "", /10\/10 · ↑↓/);
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

test("SessionPicker renders custom labels for other pickers", async () => {
  const { lastFrame, unmount } = render(
    h(SessionPicker, {
      items: [
        { id: "google/gemini-3.8-flash", title: "google/gemini-3.8-flash", meta: "内置默认" },
      ],
      width: 80,
      maxRows: 10,
      busy: false,
      labels: {
        title: "切换模型",
        summary: (count: number) => `共 ${String(count)} 个模型`,
        empty: "没有可切换的模型",
        select: "Enter 切换",
        busy: "切换中…",
      },
      onSelect: () => {},
      onCancel: () => {},
    }),
  );
  await delay(10);
  assert.match(lastFrame() ?? "", /切换模型/);
  assert.match(lastFrame() ?? "", /共 1 个模型/);
  unmount();
});

test("SessionPicker separates project and old history and explicitly assigns only an old row", async () => {
  const selected: Array<[string, boolean | undefined]> = [];
  const { stdin, lastFrame, unmount } = render(
    h(SessionPicker, {
      items: [
        { id: "project", title: "project-history", meta: "", group: "本项目下的对话" },
        { id: "old", title: "old-history", meta: "", group: "旧会话", canAssignToProject: true },
      ],
      width: 90,
      maxRows: 12,
      busy: false,
      onSelect: (id, assign) => selected.push([id, assign]),
      onCancel: () => {},
    }),
  );
  await delay(10);
  const frame = lastFrame() ?? "";
  assert.match(frame, /本项目下的对话[\s\S]*project-history[\s\S]*旧会话[\s\S]*old-history/u);
  stdin.write("m");
  await delay(10);
  assert.deepEqual(selected, []);
  stdin.write("\x1b[B");
  await delay(10);
  assert.match(lastFrame() ?? "", /m 归入本项目并继续/u);
  stdin.write("m");
  await delay(10);
  assert.deepEqual(selected, [["old", true]]);
  stdin.write("\r");
  await delay(10);
  assert.deepEqual(selected, [
    ["old", true],
    ["old", undefined],
  ]);
  unmount();
});

test("old-only history stays visible when the project group is empty and headers are not selectable", async () => {
  const selected: string[] = [];
  const { stdin, lastFrame, unmount } = render(
    h(SessionPicker, {
      items: [
        { id: "old", title: "old-history", meta: "", group: "旧会话", canAssignToProject: true },
      ],
      width: 80,
      maxRows: 12,
      busy: false,
      onSelect: (id) => selected.push(id),
      onCancel: () => {},
    }),
  );
  await delay(10);
  assert.match(
    lastFrame() ?? "",
    /本项目下的对话[\s\S]*暂无会话[\s\S]*旧会话[\s\S]*❯ old-history/u,
  );
  stdin.write("\x1b[A");
  stdin.write("\r");
  await delay(10);
  assert.deepEqual(selected, ["old"]);
  unmount();
});

test("group headings follow a long scrolling list without hiding the active conversation", async () => {
  const { stdin, lastFrame, unmount } = render(
    h(SessionPicker, {
      items: items(12).map((item, index) => ({
        ...item,
        group: index < 3 ? "本项目下的对话" : "旧会话",
        canAssignToProject: index >= 3,
      })),
      width: 80,
      maxRows: 7,
      busy: false,
      onSelect: () => {},
      onCancel: () => {},
    }),
  );
  await delay(10);
  for (let index = 0; index < 11; index += 1) stdin.write("\x1b[B");
  await delay(20);
  const frame = lastFrame() ?? "";
  assert.match(frame, /旧会话[\s\S]*❯ 会话 11/u);
  assert.match(frame, /12\/12/u);
  assert.ok(frame.split("\n").length <= 7, frame);
  unmount();
});

test("grouped history honors minimum height, including a failed assignment", async () => {
  for (const maxRows of [5, 6, 7]) {
    for (const error of [undefined, "assignment failed"]) {
      const { stdin, lastFrame, unmount } = render(
        h(SessionPicker, {
          items: items(8).map((item) => ({ ...item, group: "旧会话", canAssignToProject: true })),
          width: 40,
          maxRows,
          busy: false,
          ...(error === undefined ? {} : { error }),
          onSelect: () => {},
          onCancel: () => {},
        }),
      );
      await delay(10);
      for (let index = 0; index < 7; index += 1) stdin.write("\x1b[B");
      await delay(20);
      const frame = lastFrame() ?? "";
      assert.match(frame, /旧会话/u);
      assert.match(frame, /❯ 会话 7/u);
      assert.ok(frame.split("\n").length <= maxRows, frame);
      unmount();
    }
  }
});

function historyItems(): SessionPickerItem[] {
  const now = new Date("2026-11-10T07:00:00Z");
  return buildSessionPickerItems(
    [
      { id: "current", title: "A标题", workspace: "/a", updatedAt: "2026-11-10T06:41:00Z" },
      { id: "available", title: "B标题", workspace: "/a", updatedAt: "2026-11-09T07:00:00Z" },
      { id: "occupied", title: "C标题", updatedAt: "2026-11-09T07:00:00Z" },
      { id: "unknown", title: "D标题", updatedAt: "2026-11-09T07:00:00Z" },
    ],
    {
      currentSessionId: "current",
      workspace: "/a",
      now,
      countMessages: (id) => ({ current: 28, available: 178, occupied: 116, unknown: 6 })[id] ?? 0,
      occupancy: (id) =>
        id === "occupied"
          ? { status: "occupied", owner: { kind: "runtime", label: "Desktop client" } }
          : { status: id === "unknown" ? "unknown" : "available" },
    },
  );
}

test("history uses aligned columns, section counts and one action bar without default status noise", async () => {
  const { stdin, lastFrame, unmount } = render(
    h(SessionPicker, {
      items: historyItems(),
      width: 120,
      maxRows: 14,
      busy: false,
      onSelect: () => {},
      onCancel: () => {},
    }),
  );
  await delay(10);
  const frame = lastFrame() ?? "";
  assert.match(frame, /更新时间\s+消息数\s+状态/u);
  assert.match(frame, /本项目下的对话\s+2 ─/u);
  assert.match(frame, /旧会话\s+2 ─/u);
  assert.equal(frame.match(/↑↓/gu)?.length, 1);
  assert.doesNotMatch(frame, /可继续|\[当前打开\]/u);
  const lines = frame.split("\n");
  const current = lines.find((line) => line.includes("A标题")) ?? "";
  const available = lines.find((line) => line.includes("B标题")) ?? "";
  const occupied = lines.find((line) => line.includes("C标题")) ?? "";
  const end = (line: string, value: string) => {
    const index = line.indexOf(value);
    assert.ok(index >= 0, line);
    return displayWidth(line.slice(0, index + value.length));
  };
  assert.equal(end(current, "19 分钟前"), end(available, "1 天前"));
  assert.equal(end(current, "28"), end(occupied, "116"));
  assert.equal(
    end(current, "当前打开") - displayWidth("当前打开"),
    end(occupied, "占用中") - displayWidth("占用中"),
  );
  assert.doesNotMatch(occupied, /Desktop client/u);
  stdin.write("\x1b[B");
  stdin.write("\x1b[B");
  await delay(20);
  assert.match(lastFrame() ?? "", /占用：Desktop client/u);
  unmount();
});

test("history retains selection, state and controls within width and row budgets", async () => {
  for (const width of [24, 40, 60, 100]) {
    for (const maxRows of [5, 6, 8, 12]) {
      const entries = historyItems();
      const { stdin, lastFrame, unmount } = render(
        h(SessionPicker, {
          items: entries,
          width,
          maxRows,
          busy: false,
          onSelect: () => {},
          onCancel: () => {},
        }),
      );
      await delay(10);
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) {
          stdin.write("\x1b[B");
          await delay(10);
        }
        const frame = lastFrame() ?? "";
        assert.match(frame, new RegExp(`${String.fromCharCode(65 + index)}标题`));
        if (index === 0) assert.match(frame, /当前打开/u);
        if (index === 2) assert.match(frame, /占用中/u);
        if (index === 3) assert.match(frame, /状态未知/u);
        assert.match(frame, /Enter/u);
        assert.match(frame, /Esc/u);
        assert.equal(frame.match(/↑↓/gu)?.length, 1);
        const lines = frame.split("\n");
        assert.ok(lines.length <= maxRows, `${width}x${maxRows}\n${frame}`);
        for (const line of lines) {
          assert.ok(displayWidth(line) <= width, `${width}x${maxRows}\n${frame}`);
        }
      }
      unmount();
    }
  }
});
