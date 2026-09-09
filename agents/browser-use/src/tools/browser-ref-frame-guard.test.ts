import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import type { NativeCdpController } from "@roll-agent/browser";
import { createBrowserRefFrameGuard } from "./browser-ref-frame-guard.ts";

function fixture() {
  const events: string[] = [];
  let result = "clear";
  let config = BrowserRuntimeConfigSchema.parse({ security: { domainAllowlist: ["example.com"] } });
  const abort = new AbortController();
  const native = {
    getFrameTree: async () => ({
      frame: { id: "main", url: "https://example.com" },
      childFrames: [{ frame: { id: "child", url: "https://example.com/frame" } }],
    }),
    getDocument: async () => ({
      root: { children: [{ frameId: "child", contentDocument: { backendNodeId: 5 } }] },
    }),
    resolveBackendNode: async () => "document",
    callFunctionOnObject: async (input: { args: readonly unknown[] }) => {
      events.push(input.args[2] === true ? "inspect-focus" : "inspect-pointer");
      return result;
    },
    releaseObject: async () => {},
    dispatchMouseEvent: async function (input: { type: string }) {
      assert.equal(this, native);
      events.push(input.type);
    },
    dispatchKeyEvent: async function () {
      assert.equal(this, native);
      events.push("key");
    },
    insertText: async function () {
      assert.equal(this, native);
      events.push("text");
    },
    preflightAction: function () {
      assert.equal(this, native);
      events.push("preflight");
    },
  };
  const controller = createBrowserRefFrameGuard(native as unknown as NativeCdpController, {
    frameId: "child",
    runtime: { getConfig: () => config },
    signal: abort.signal,
    approvedByConfirmation: false,
  });
  return {
    controller,
    events,
    abort,
    setResult: (next: string) => {
      result = next;
    },
    setConfig: (security: unknown) => {
      config = BrowserRuntimeConfigSchema.parse({ security });
    },
  };
}

test("ref pointer guard preserves method receivers and permits animated motion before final hit", async () => {
  const f = fixture();
  f.controller.preflightAction({ action: "click", target: "@e1" });
  await f.controller.dispatchMouseEvent({ type: "mouseMoved", x: 0, y: 0 });
  await f.controller.dispatchMouseEvent({ type: "mousePressed", x: 100, y: 100 });
  assert.deepEqual(f.events, ["preflight", "mouseMoved", "inspect-pointer", "mousePressed"]);
  f.setResult("target_obscured");
  await assert.rejects(f.controller.dispatchMouseEvent({ type: "mouseReleased", x: 100, y: 100 }), {
    payload: {
      code: "target_obscured",
      message: "The frame ancestor chain cannot receive this pointer action.",
    },
  });
  assert.equal(f.events.includes("mouseReleased"), false);
});

test("ref typing checks ancestor focus again before clear keys and inserted text", async () => {
  const f = fixture();
  await f.controller.dispatchMouseEvent({ type: "mousePressed", x: 100, y: 100 });
  await f.controller.dispatchKeyEvent({ type: "keyDown", key: "a" });
  assert.equal(f.events.at(-2), "inspect-focus");
  f.setResult("focus_changed");
  await assert.rejects(
    f.controller.insertText("must not type"),
    (error: unknown) => error instanceof Error && error.message.includes("frame ancestor"),
  );
  assert.equal(f.events.includes("text"), false);
});

test("ref frame guard stops cancelled, policy-denied and domain-denied actions", async () => {
  for (const change of ["cancel", "policy", "domain"]) {
    const f = fixture();
    if (change === "cancel") f.abort.abort();
    if (change === "policy") f.setConfig({ actionPolicy: "deny" });
    if (change === "domain") f.setConfig({ domainAllowlist: ["other.example"] });
    await assert.rejects(f.controller.dispatchMouseEvent({ type: "mousePressed", x: 100, y: 100 }));
    assert.deepEqual(f.events, []);
  }
});
