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

test("buildSessionPickerItems includes and marks current session and falls back title", () => {
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
    {
      id: "current",
      title: "当前",
      meta: "1 小时前 · 0 条消息",
      isCurrent: true,
      history: { updated: "1 小时前", messageCount: 0 },
    },
    {
      id: "t1",
      title: "发布计划",
      meta: "2 小时前 · 12 条消息",
      history: { updated: "2 小时前", messageCount: 12 },
    },
    {
      id: "t2",
      title: "（无标题）",
      meta: "1 天前 · 3 条消息",
      history: { updated: "1 天前", messageCount: 3 },
    },
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

test("project history includes unclassified conversations in a separate group", () => {
  const threads = [
    { id: "old-newest", title: "old", updatedAt: NOW.toISOString() },
    { id: "other", title: "other", updatedAt: NOW.toISOString(), workspace: "/b" },
    { id: "current", title: "current", updatedAt: NOW.toISOString(), workspace: "/a" },
    { id: "project", title: "project", updatedAt: NOW.toISOString(), workspace: "/a" },
    { id: "old-older", title: "older", updatedAt: "2026-08-04T12:00:00Z" },
  ];
  const options = {
    currentSessionId: "current",
    workspace: "/a",
    countMessages: () => 2,
    now: NOW,
  };
  const items = buildSessionPickerItems(threads, options);
  assert.deepEqual(
    items.map(({ id, group, canAssignToProject }) => ({ id, group, canAssignToProject })),
    [
      { id: "current", group: "本项目下的对话", canAssignToProject: undefined },
      { id: "project", group: "本项目下的对话", canAssignToProject: undefined },
      { id: "old-newest", group: "旧会话", canAssignToProject: true },
      { id: "old-older", group: "旧会话", canAssignToProject: true },
    ],
  );
  const all = buildSessionPickerItems(threads, { ...options, allProjects: true });
  assert.equal(all.at(-1)?.id, "other");
  assert.equal(all.at(-1)?.group, "其他项目下的对话");
  assert.equal(all.at(-1)?.canAssignToProject, undefined);
});

test("a sole empty active conversation is visible and a cross-project active conversation is retained", () => {
  const options = {
    currentSessionId: "current",
    workspace: "/a",
    countMessages: () => 0,
    now: NOW,
    occupancy: () => ({ status: "occupied" as const }),
  };
  const items = buildSessionPickerItems(
    [{ id: "current", title: undefined, updatedAt: NOW.toISOString(), workspace: "/a" }],
    options,
  );
  assert.equal(items[0]?.title, "（新会话，暂无消息）");
  assert.equal(items[0]?.isCurrent, true);
  assert.equal(items[0]?.history?.occupancy, undefined);
  const other = buildSessionPickerItems(
    [{ id: "current", title: "active elsewhere", updatedAt: NOW.toISOString(), workspace: "/b" }],
    options,
  );
  assert.equal(other[0]?.isCurrent, true);
  assert.equal(other[0]?.canAssignToProject, undefined);
});

test("history presentation keeps title and typed occupancy separate and omits default availability noise", () => {
  const threads = ["current", "available", "occupied", "unknown"].map((id) => ({
    id,
    title: id,
    updatedAt: NOW.toISOString(),
  }));
  const rows = buildSessionPickerItems(threads, {
    currentSessionId: "current",
    countMessages: () => 10,
    now: NOW,
    occupancy: (id) =>
      id === "occupied"
        ? { status: "occupied", owner: { kind: "runtime", label: "Desktop client" } }
        : { status: id === "unknown" ? "unknown" : "available" },
  });
  assert.equal(rows[0]?.title, "current");
  assert.equal(rows[0]?.isCurrent, true);
  assert.doesNotMatch(rows[1]?.meta ?? "", /可继续/u);
  assert.equal(rows[2]?.history?.occupancy?.owner?.label, "Desktop client");
  assert.match(rows[2]?.meta ?? "", /占用中/u);
  assert.match(rows[3]?.meta ?? "", /状态未知/u);
});
