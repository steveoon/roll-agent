import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zhipinReadMessages } from "./zhipin-read-messages.ts";

describe("zhipin_read_messages", () => {
  it("defaults to returning the full message list instead of unread-only", () => {
    const parsed = zhipinReadMessages.input.parse({});

    assert.equal(parsed.onlyUnread, false);
    assert.equal(parsed.sortBy, "time");
    assert.equal(parsed.autoScroll, true);
    assert.equal(parsed.maxScrolls, 4);
  });
});
