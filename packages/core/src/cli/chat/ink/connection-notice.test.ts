import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { cleanup, render } from "ink-testing-library";
import type { ChatConnectionSnapshot } from "../../../runtime-host/chatgpt-connection.ts";
import { ConnectionNotice } from "./connection-notice.ts";

afterEach(() => cleanup());

test("connection notice is silent for normal states and replaces rather than retains failures", async () => {
  const props = (snapshot: ChatConnectionSnapshot | undefined) => ({ snapshot, width: 80 });
  const view = render(h(ConnectionNotice, props({ state: "idle" })));
  try {
    for (const state of ["idle", "connecting", "connected", "disabled"] as const) {
      view.rerender(h(ConnectionNotice, props({ state })));
      await delay(20);
      assert.equal(view.lastFrame(), "");
    }
    const failed = { state: "failed", message: "网络中断；/reconnect 重试连接。" } as const;
    view.rerender(h(ConnectionNotice, props(failed)));
    await delay(20);
    assert.match(view.lastFrame() ?? "", /网络中断/);
    view.rerender(h(ConnectionNotice, props(failed)));
    await delay(20);
    assert.equal((view.lastFrame() ?? "").split("网络中断").length - 1, 1);
    view.rerender(h(ConnectionNotice, props({ state: "failed", message: "请重新登录" })));
    await delay(20);
    assert.match(view.lastFrame() ?? "", /请重新登录/);
    assert.doesNotMatch(view.lastFrame() ?? "", /网络中断/);
    for (const state of ["connecting", "connected", "disabled"] as const) {
      view.rerender(h(ConnectionNotice, props({ state })));
      await delay(20);
      assert.equal(view.lastFrame(), "");
    }
    view.rerender(
      h(
        ConnectionNotice,
        props({ state: "failed", message: "already reported", reportedInTurn: true }),
      ),
    );
    await delay(20);
    assert.equal(view.lastFrame(), "");
    view.rerender(h(ConnectionNotice, props(undefined)));
    await delay(20);
    assert.equal(view.lastFrame(), "");
  } finally {
    view.unmount();
  }
});
