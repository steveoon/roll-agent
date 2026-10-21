import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createElement as h } from "react";
import { cleanup, render } from "ink-testing-library";
import { AgentSession } from "@roll-agent/runtime";
import { rollConfigSchema } from "../../../config/schema.ts";
import {
  resolveInteractiveChatLlm,
  type ChatGptAuth,
} from "../../../runtime-host/chatgpt-resolution.ts";
import { ChatGptAuthError } from "../../../auth/chatgpt/service.ts";
import { ChatApp } from "./app.ts";
import { useSession } from "./use-session.ts";

afterEach(() => cleanup());

test("cancelling connection preparation restores the draft and attachment restoration callback without sending", async () => {
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/tmp/unused-cancel-preparation" },
    llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
    runtime: { provider: "chatgpt", model: "fixture" },
  });
  const selected = await resolveInteractiveChatLlm(config, {
    deferConnection: true,
    auth: {
      status: async () => ({ accounts: [], usageUrl: "https://chatgpt.com/settings/usage" }),
      models: async () => {
        throw new Error("must not send");
      },
      getAccessToken: async () => {
        throw new Error("must not send");
      },
    },
  });
  const session = new AgentSession({
    id: "cancel-preparation",
    model: selected.model,
    sources: [],
    maxSteps: 1,
  });
  let current: ReturnType<typeof useSession> | undefined;
  let restored = 0;
  function Harness() {
    current = useSession(session, {
      model: "fixture",
      contextWindow: undefined,
      beforeSend: async (signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      onPreparationCancelled: () => {
        restored++;
      },
    });
    return null;
  }
  const view = render(h(Harness));
  try {
    assert.ok(current);
    current.submit("retained during cancellation", [
      { name: "image.png", data: "synthetic", mediaType: "image/png" },
    ]);
    await delay(20);
    current.cancel();
    await until(() => assert.equal(current?.state.draft, "retained during cancellation"));
    assert.equal(restored, 1);
    assert.equal(session.getMessages().length, 0);
  } finally {
    view.unmount();
    selected.connection?.dispose();
  }
});
async function until(check: () => void) {
  let error: unknown;
  for (let i = 0; i < 150; i++) {
    try {
      check();
      return;
    } catch (reason) {
      error = reason;
      await delay(10);
    }
  }
  throw error;
}

test("Ink keeps draft during failed background auth, /reconnect recovers without sending a turn", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let online = false;
  let modelRequests = 0;
  const auth: ChatGptAuth = {
    status: async () => ({
      currentAccountId: "00000000-0000-4000-8000-000000000001",
      accounts: [],
      usageUrl: "https://chatgpt.com/settings/usage",
    }),
    models: async () => {
      modelRequests++;
      await gate;
      if (!online) throw new ChatGptAuthError("network_error", "网络中断");
      return [{ slug: "fixture", displayName: "Fixture" }];
    },
    getAccessToken: async () => {
      throw new Error("reconnect must not send inference");
    },
  };
  const config = rollConfigSchema.parse({
    ask: {},
    agents: { dataDir: "/tmp/unused-ink-offline" },
    llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
    runtime: { provider: "chatgpt", model: "fixture" },
  });
  const selected = await resolveInteractiveChatLlm(config, { auth, deferConnection: true });
  assert.ok(selected.connection);
  const session = new AgentSession({
    id: "ink-offline",
    model: selected.model,
    sources: [],
    maxSteps: 1,
  });
  let exits = 0;
  let submits = 0;
  const view = render(
    h(ChatApp, {
      session,
      model: "fixture",
      connection: selected.connection,
      onUserSubmit: () => {
        submits++;
      },
      onExit: () => {
        exits++;
      },
    }),
  );
  const frame = () => view.lastFrame() ?? "";
  try {
    await until(() => assert.equal(selected.connection?.getSnapshot().state, "connecting"));
    assert.match(frame(), /ChatGPT/);
    assert.doesNotMatch(frame(), /⚠|正在连接|尚未连接|本地会话可用/);
    view.stdin.write("keep-this-draft");
    await until(() => assert.match(frame(), /keep-this-draft/));
    release();
    await until(() => assert.match(frame(), /网络中断/));
    assert.match(frame(), /keep-this-draft/);
    assert.equal(frame().split("网络中断").length - 1, 1);
    selected.connection.setEnabled(false);
    await until(() => assert.doesNotMatch(frame(), /ChatGPT|网络中断/));
    selected.connection.setEnabled(true);
    await until(() => assert.match(frame(), /网络中断/));
    assert.equal(exits, 0);
    assert.equal(submits, 0);
    // Clear the edit buffer, then explicitly reconnect; no old user turn is replayed.
    for (let i = 0; i < "keep-this-draft".length; i++) {
      view.stdin.write("\u007f");
      await delay(5);
    }
    await until(() => assert.doesNotMatch(frame(), /keep-this-draft/));
    online = true;
    view.stdin.write("/reconnect");
    await delay(20);
    view.stdin.write("\r");
    await until(() => assert.match(frame(), /ChatGPT ✓/));
    assert.doesNotMatch(frame(), /网络中断|已连接|可继续发送消息|⚠/);
    assert.equal(modelRequests, 2);
    assert.equal(submits, 0);
    assert.equal(session.getMessages().length, 0);
  } finally {
    release();
    view.unmount();
    selected.connection.dispose();
    await session.close();
  }
});
