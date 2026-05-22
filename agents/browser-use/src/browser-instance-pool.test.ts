import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StructuredToolError } from "@roll-agent/sdk";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { resetPrimaryWorkAreaCacheForTests } from "./auto-window-layout.ts";
import { BrowserInstancePool, runWithBrowserInstance } from "./browser-instance-pool.ts";

describe("BrowserInstancePool", () => {
  it("selects the default instance when configured", () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      defaultInstance: "boss-a",
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
        },
        "boss-b": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9223,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-b",
        },
      },
    });

    assert.equal(pool.getBundle().id, "boss-a");
    assert.equal(pool.getBundle("boss-b").config.cdpPort, 9223);
  });

  it("requires explicit browserInstance when multiple instances have no default", () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
        },
        "boss-b": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9223,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-b",
        },
      },
    });

    assert.throws(
      () => pool.getBundle(),
      (error) => error instanceof StructuredToolError && error.payload.code === "needs_input",
    );
  });

  it("uses AsyncLocal browser instance selection for wrapped tools", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
        },
        "boss-b": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9223,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-b",
        },
      },
    });

    const selected = await runWithBrowserInstance("boss-b", async () => pool.getBundle().id);
    assert.equal(selected, "boss-b");
  });

  it("derives profile labels and side-by-side window bounds for managed multi-instance", () => {
    process.env["ROLL_BROWSER_WORK_AREA"] = "0,0,1920,1080";
    resetPrimaryWorkAreaCacheForTests();

    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      defaultInstance: "boss-a",
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
        },
        "boss-b": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9223,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-b",
        },
        "boss-c": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9224,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-c",
        },
      },
    });

    assert.equal(pool.getBundle("boss-a").config.profileName, "boss-a");
    assert.equal(pool.getBundle("boss-a").config.instanceId, "boss-a");
    assert.deepEqual(pool.getBundle("boss-a").config.windowBounds, {
      x: 0,
      y: 0,
      width: 640,
      height: 1080,
    });
    assert.deepEqual(pool.getBundle("boss-b").config.windowBounds, {
      x: 640,
      y: 0,
      width: 640,
      height: 1080,
    });
    assert.deepEqual(pool.getBundle("boss-c").config.windowBounds, {
      x: 1280,
      y: 0,
      width: 640,
      height: 1080,
    });

    delete process.env["ROLL_BROWSER_WORK_AREA"];
    resetPrimaryWorkAreaCacheForTests();
  });

  it("keeps explicit window bounds and profile names over auto layout", () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
          profileName: "Boss Account A",
          windowBounds: {
            x: 12,
            y: 34,
            width: 900,
            height: 700,
          },
        },
        "boss-b": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9223,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-b",
        },
      },
    });

    assert.equal(pool.getBundle("boss-a").config.profileName, "Boss Account A");
    assert.deepEqual(pool.getBundle("boss-a").config.windowBounds, {
      x: 12,
      y: 34,
      width: 900,
      height: 700,
    });
  });

  it("does not cache completed lazy-start promises as running state", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      defaultInstance: "boss-a",
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
        },
      },
    });
    const runtime = pool.getBundle("boss-a").runtime;
    let running = false;
    let startCount = 0;
    runtime.isRunning = () => running;
    runtime.start = async () => {
      startCount += 1;
      running = true;
    };

    await pool.ensureBundleStarted("boss-a");
    running = false;
    await pool.ensureBundleStarted("boss-a");

    assert.equal(startCount, 2);
  });

  it("waits for in-flight lazy starts before stopping bundles", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      defaultInstance: "boss-a",
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
        },
      },
    });
    const bundle = pool.getBundle("boss-a");
    const events: string[] = [];
    let running = false;
    let resolveStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });

    bundle.runtime.isRunning = () => running;
    bundle.runtime.start = async () => {
      events.push("start");
      await startGate;
      running = true;
      events.push("started");
    };
    bundle.contextManager.closeAll = async () => {
      events.push("contexts");
    };
    bundle.runtime.stop = async () => {
      events.push("stop");
      running = false;
    };

    const startPromise = pool.ensureBundleStarted("boss-a");
    await Promise.resolve();
    const closePromise = pool.closeAll();
    await Promise.resolve();

    assert.deepEqual(events, ["start"]);

    resolveStart?.();
    await startPromise;
    await closePromise;

    assert.deepEqual(events, ["start", "started", "contexts", "stop"]);
  });
});
