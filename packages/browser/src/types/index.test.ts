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
  assert.deepEqual(config.security, {
    domainAllowlist: [],
    maxPageContentBytes: 102_400,
    maxSnapshotNodes: 500,
    actionPolicy: "log",
    foregroundPolicy: "when-minimized",
  });
});

test("BrowserRuntimeConfigSchema normalizes security config", () => {
  const config = BrowserRuntimeConfigSchema.parse({
    security: {
      domainAllowlist: [" ZHIPIN.COM ", "liepin.com"],
      maxPageContentBytes: 512,
      maxSnapshotNodes: 10,
      actionPolicy: "confirm",
      foregroundPolicy: "never",
    },
  });

  assert.deepEqual(config.security.domainAllowlist, ["zhipin.com", "liepin.com"]);
  assert.equal(config.security.maxPageContentBytes, 512);
  assert.equal(config.security.maxSnapshotNodes, 10);
  assert.equal(config.security.actionPolicy, "confirm");
  assert.equal(config.security.foregroundPolicy, "never");
});

test("BrowserRuntimeConfigSchema accepts instance display, color, and window bounds config", () => {
  const config = BrowserRuntimeConfigSchema.parse({
    instanceId: "boss-a",
    profileName: "Boss A",
    profileColor: "#dc2626",
    windowBounds: {
      x: 0,
      y: 24,
      width: 680,
      height: 1000,
    },
  });

  assert.equal(config.instanceId, "boss-a");
  assert.equal(config.profileName, "Boss A");
  assert.equal(config.profileColor, "#DC2626");
  assert.deepEqual(config.windowBounds, {
    x: 0,
    y: 24,
    width: 680,
    height: 1000,
  });
});

test("BrowserRuntimeConfigSchema rejects invalid profile colors", () => {
  assert.throws(() => BrowserRuntimeConfigSchema.parse({ profileColor: "blue" }), /profileColor/);
});

test("BrowserRuntimeConfigSchema requires cdpUrl in remote-cdp mode", () => {
  assert.throws(() => BrowserRuntimeConfigSchema.parse({ mode: "remote-cdp" }), /cdpUrl/);
});

test("BrowserRuntimeConfigSchema requires cdpUrl in existing-session mode", () => {
  assert.throws(() => BrowserRuntimeConfigSchema.parse({ mode: "existing-session" }), /cdpUrl/);
});
