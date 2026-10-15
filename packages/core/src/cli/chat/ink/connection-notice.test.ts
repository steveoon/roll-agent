import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { cleanup, render } from "ink-testing-library";
import type { ChatConnection } from "../../../runtime-host/chatgpt-connection.ts";
import { ConnectionNotice } from "./connection-notice.ts";

afterEach(() => cleanup());

test("connection notices enter history once per transition and never occupy the footer", async () => {
  let message = "ChatGPT 已连接；可继续发送消息，/model 查看可用模型。";
  const listeners = new Set<() => void>();
  let starts = 0;
  const connection: ChatConnection = {
    getSnapshot: () => message,
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
  const notices: string[] = [];
  const props = () => ({
    connection,
    onNotice: (text: string) => {
      notices.push(text);
    },
  });
  const view = render(h(ConnectionNotice, props()));
  try {
    await delay(30);
    assert.deepEqual(notices, [message]);
    assert.equal(view.lastFrame(), "");
    view.rerender(h(ConnectionNotice, props()));
    for (const listener of listeners) listener();
    await delay(30);
    assert.equal(notices.length, 1);
    assert.equal(starts, 1);

    message = "网络中断；/reconnect 重试连接。";
    for (const listener of listeners) listener();
    await delay(30);
    assert.equal(notices.at(-1), message);
    assert.equal(notices.length, 2);
    assert.equal(view.lastFrame(), "");

    message = "";
    for (const listener of listeners) listener();
    await delay(30);
    assert.equal(notices.length, 2);
    message = "ChatGPT 已连接；可继续发送消息，/model 查看可用模型。";
    for (const listener of listeners) listener();
    await delay(30);
    assert.equal(notices.length, 3);
    assert.equal(notices.at(-1), message);
  } finally {
    view.unmount();
  }
  assert.equal(listeners.size, 0);
});
