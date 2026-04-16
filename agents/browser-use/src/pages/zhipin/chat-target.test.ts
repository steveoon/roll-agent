import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "@roll-agent/browser";
import { getSelectedChatTarget } from "./chat-target.ts";

function createPage(
  target: { conversationId: string; candidateId: string; candidateName: string } | null,
): Page {
  return {
    async waitForSelector() {
      if (!target) {
        throw new Error("selector timeout");
      }
      return {};
    },
    async evaluate() {
      return target;
    },
  } as unknown as Page;
}

test("getSelectedChatTarget returns the selected conversation target", async () => {
  const page = createPage({
    conversationId: "685501091-0",
    candidateId: "candidate-123",
    candidateName: "鲁倩",
  });

  const target = await getSelectedChatTarget(page);

  assert.deepEqual(target, {
    conversationId: "685501091-0",
    candidateId: "candidate-123",
    candidateName: "鲁倩",
  });
});

test("getSelectedChatTarget returns null when no selected item is available", async () => {
  const page = createPage(null);
  const target = await getSelectedChatTarget(page);
  assert.equal(target, null);
});
