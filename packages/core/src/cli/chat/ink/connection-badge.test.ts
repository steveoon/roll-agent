import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { cleanup, render } from "ink-testing-library";
import { ConnectionBadge, connectionBadgeText } from "./connection-badge.ts";
import { useChatConnection } from "./use-chat-connection.ts";
import type {
  ChatConnection,
  ChatConnectionSnapshot,
} from "../../../runtime-host/chatgpt-connection.ts";

afterEach(() => cleanup());

test("normal badges use muted text with distinct markers and errors alone use warning color", () => {
  for (const state of ["idle", "connected"] as const) {
    const snapshot = { state };
    const badge = ConnectionBadge({ snapshot });
    assert.deepEqual(badge?.props, { dimColor: true, children: connectionBadgeText(snapshot) });
    assert.doesNotMatch(connectionBadgeText(snapshot), /⚠|连接|!|reconnect/);
  }
  assert.notEqual(
    connectionBadgeText({ state: "idle" }),
    connectionBadgeText({ state: "connected" }),
  );
  const failed = { state: "failed", message: "offline" } as const;
  assert.deepEqual(ConnectionBadge({ snapshot: failed })?.props, {
    color: "yellow",
    children: "ChatGPT !",
  });
  assert.equal(ConnectionBadge({ snapshot: { state: "disabled" } }), null);
  assert.equal(ConnectionBadge({ snapshot: undefined }), null);
});

test("connection subscription starts once, updates in place and cleans up when removed", async () => {
  let snapshot: ChatConnectionSnapshot = { state: "idle" };
  let starts = 0;
  const listeners = new Set<() => void>();
  const connection: ChatConnection = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      starts++;
    },
    retry: async () => {},
  };
  function Harness({ source }: { readonly source: ChatConnection | undefined }) {
    return h(ConnectionBadge, { snapshot: useChatConnection(source) });
  }
  const view = render(h(Harness, { source: connection }));
  try {
    await delay(20);
    assert.equal(starts, 1);
    assert.equal(listeners.size, 1);
    for (const state of ["connecting", "connected", "disabled"] as const) {
      snapshot = { state };
      for (const listener of listeners) listener();
      view.rerender(h(Harness, { source: connection }));
      await delay(20);
      assert.equal(starts, 1);
      assert.equal(listeners.size, 1);
      if (state === "disabled") assert.equal(view.lastFrame(), "");
      else assert.match(view.lastFrame() ?? "", /ChatGPT/);
    }
    view.rerender(h(Harness, { source: undefined }));
    await delay(20);
    assert.equal(listeners.size, 0);
    assert.equal(view.lastFrame(), "");
    view.rerender(h(Harness, { source: connection }));
    await delay(20);
    assert.equal(starts, 2);
  } finally {
    view.unmount();
  }
  await delay(20);
  assert.equal(listeners.size, 0);
});
