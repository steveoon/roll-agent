import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatGptAuthError } from "../auth/chatgpt/errors.ts";
import { ChatGptConnection } from "./chatgpt-connection.ts";
import type { ChatGptAuth } from "./chatgpt-resolution.ts";

function fixture() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const auth: ChatGptAuth = {
    status: async () => ({ accounts: [], usageUrl: "https://chatgpt.com/settings/usage" }),
    models: async () => {
      await gate;
      return [{ slug: "fixture", displayName: "Fixture" }];
    },
    getAccessToken: async () => "synthetic",
  };
  return { connection: new ChatGptConnection(auth, "fixture", []), release };
}

test("connection snapshots are stable and distinguish normal, failed and disabled states", async () => {
  const { connection, release } = fixture();
  const transitions: string[] = [];
  const unsubscribe = connection.subscribe(() => transitions.push(connection.getSnapshot().state));
  try {
    assert.deepEqual(connection.getSnapshot(), { state: "idle" });
    assert.equal(connection.getSnapshot(), connection.getSnapshot());
    const pending = connection.ensure();
    assert.deepEqual(connection.getSnapshot(), { state: "connecting" });
    assert.equal(connection.getSnapshot(), connection.getSnapshot());
    release();
    await pending;
    const connected = connection.getSnapshot();
    assert.deepEqual(connected, { state: "connected" });
    connection.setEnabled(false);
    assert.deepEqual(connection.getSnapshot(), { state: "disabled" });
    assert.equal(connection.getSnapshot(), connection.getSnapshot());
    connection.setEnabled(true);
    assert.equal(connection.getSnapshot(), connected);
    connection.failed(new ChatGptAuthError("network_error", "网络中断"));
    const failed = connection.getSnapshot();
    assert.equal(failed.state, "failed");
    assert.ok(failed.state === "failed");
    assert.match(failed.message, /网络中断.*reconnect/);
    await connection.retry();
    assert.deepEqual(connection.getSnapshot(), { state: "connected" });
    assert.deepEqual(transitions, [
      "connecting",
      "connected",
      "disabled",
      "connected",
      "failed",
      "connecting",
      "connected",
    ]);
  } finally {
    release();
    unsubscribe();
    connection.dispose();
  }
});

test("failed snapshots never display arbitrary request errors and retain login guidance", () => {
  const { connection } = fixture();
  try {
    connection.failed(new Error("private-token-detail"));
    const unknown = connection.getSnapshot();
    assert.ok(unknown.state === "failed");
    assert.doesNotMatch(unknown.message, /private-token-detail/);
    assert.match(unknown.message, /请求失败|响应异常/);
    assert.doesNotMatch(unknown.message, /reconnect|检查网络/);
    connection.failed(new ChatGptAuthError("login_required", "请运行 roll auth chatgpt login。"));
    const login = connection.getSnapshot();
    assert.ok(login.state === "failed");
    assert.match(login.message, /roll auth chatgpt login/);
  } finally {
    connection.dispose();
  }
});
