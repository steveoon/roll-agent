import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserRuntimeConfigSchema } from "./index.ts";

test("BrowserRuntimeConfigSchema defaults to managed-cdp", () => {
  const config = BrowserRuntimeConfigSchema.parse({});

  assert.equal(config.mode, "managed-cdp");
  assert.equal(config.headless, false);
  assert.equal(config.cdpHost, "127.0.0.1");
  assert.equal(config.cdpPort, 9222);
  assert.equal(config.channel, "chrome");
});

test("BrowserRuntimeConfigSchema requires cdpUrl in remote-cdp mode", () => {
  assert.throws(() => BrowserRuntimeConfigSchema.parse({ mode: "remote-cdp" }), /cdpUrl/);
});

test("BrowserRuntimeConfigSchema requires cdpUrl in existing-session mode", () => {
  assert.throws(() => BrowserRuntimeConfigSchema.parse({ mode: "existing-session" }), /cdpUrl/);
});
