import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "@roll-agent/browser";
import { getActiveChatPanel, getSelectedChatTarget } from "./chat-target.ts";

function createPage(
  options: {
    target: { conversationId: string; candidateId: string; candidateName: string } | null;
    activePanel?: { candidateName: string } | null;
  },
): Page {
  return {
    async waitForSelector() {
      if (!options.target) {
        throw new Error("selector timeout");
      }
      return {};
    },
    async evaluate(fn: unknown) {
      const source = typeof fn === "function" ? String(fn) : "";
      if (source.includes('document.querySelector(".geek-item.selected")')) {
        return options.target;
      }
      if (source.includes('const rootSelectors = [".chat-conversation"')) {
        return options.activePanel ?? null;
      }
      return null;
    },
  } as unknown as Page;
}

test("getSelectedChatTarget returns the selected conversation target", async () => {
  const page = createPage({
    target: {
      conversationId: "685501091-0",
      candidateId: "candidate-123",
      candidateName: "鲁倩",
    },
  });

  const target = await getSelectedChatTarget(page);

  assert.deepEqual(target, {
    conversationId: "685501091-0",
    candidateId: "candidate-123",
    candidateName: "鲁倩",
  });
});

test("getSelectedChatTarget returns null when no selected item is available", async () => {
  const page = createPage({ target: null });
  const target = await getSelectedChatTarget(page);
  assert.equal(target, null);
});

test("getActiveChatPanel returns the active right-panel candidate name", async () => {
  const page = createPage({
    target: null,
    activePanel: {
      candidateName: "赵慧珍",
    },
  });

  const panel = await getActiveChatPanel(page);

  assert.deepEqual(panel, {
    candidateName: "赵慧珍",
  });
});

test("getActiveChatPanel returns null when the right panel is not ready", async () => {
  const page = createPage({
    target: null,
    activePanel: null,
  });

  const panel = await getActiveChatPanel(page);

  assert.equal(panel, null);
});
