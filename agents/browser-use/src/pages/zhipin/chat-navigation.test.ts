import assert from "node:assert/strict";
import { test } from "node:test";
import { selectChatCandidate } from "./chat-navigation.ts";

const candidates = [
  {
    name: "鲁伟",
    index: 0,
    hasUnread: true,
    unreadCount: 1,
    lastMessageTime: "10:00",
    messagePreview: "您好",
  },
  {
    name: "鲁杰",
    index: 1,
    hasUnread: false,
    unreadCount: 0,
    lastMessageTime: "09:30",
    messagePreview: "收到",
  },
  {
    name: "张三丰",
    index: 2,
    hasUnread: false,
    unreadCount: 0,
    lastMessageTime: "09:00",
    messagePreview: "你好",
  },
] as const;

test("selectChatCandidate matches exact candidate names first", () => {
  const selected = selectChatCandidate(candidates, {
    candidateName: "鲁伟",
    index: undefined,
  });

  assert.equal(selected?.name, "鲁伟");
  assert.equal(selected?.index, 0);
});

test("selectChatCandidate does not fuzzy-match two-character names on one shared character", () => {
  const selected = selectChatCandidate(candidates, {
    candidateName: "鲁明",
    index: undefined,
  });

  assert.equal(selected, undefined);
});

test("selectChatCandidate allows broader fuzzy matching for longer names", () => {
  const selected = selectChatCandidate(candidates, {
    candidateName: "张三",
    index: undefined,
  });

  assert.equal(selected?.name, "张三丰");
  assert.equal(selected?.index, 2);
});
