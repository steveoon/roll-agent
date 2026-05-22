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
    assert.equal(pool.getBundle("boss-a").config.profileColor, "#2563EB");
    assert.equal(pool.getBundle("boss-b").config.profileColor, "#DC2626");
    assert.equal(pool.getBundle("boss-c").config.profileColor, "#16A34A");
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
          profileColor: "#0ea5e9",
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
    assert.equal(pool.getBundle("boss-a").config.profileColor, "#0EA5E9");
    assert.equal(pool.getBundle("boss-b").config.profileColor, "#DC2626");
    assert.deepEqual(pool.getBundle("boss-a").config.windowBounds, {
      x: 12,
      y: 34,
      width: 900,
      height: 700,
    });
  });

  it("generates unique automatic profile colors beyond the base palette", () => {
    const instances = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => {
        const id = `boss-${String(index + 1)}`;
        return [
          id,
          {
            mode: "managed-cdp" as const,
            cdpHost: "127.0.0.1",
            cdpPort: 9222 + index,
            channel: "chrome" as const,
            userDataDir: `/tmp/roll-browser/${id}`,
          },
        ];
      }),
    );
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances,
    });

    const colors = Object.keys(instances).map((id) => pool.getBundle(id).config.profileColor);
    assert.equal(new Set(colors).size, colors.length);
    for (const color of colors) {
      assert.match(color ?? "", /^#[\dA-F]{6}$/);
    }
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

  it("stops only selected browser instances", async () => {
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
    const running = new Map([
      ["boss-a", true],
      ["boss-b", true],
    ]);
    const events: string[] = [];
    for (const bundle of pool.listBundles()) {
      bundle.runtime.isRunning = () => running.get(bundle.id) === true;
      bundle.contextManager.closeAll = async () => {
        events.push(`contexts:${bundle.id}`);
      };
      bundle.runtime.stop = async () => {
        events.push(`stop:${bundle.id}`);
        running.set(bundle.id, false);
      };
    }

    const results = await pool.closeInstances(["boss-a"]);

    assert.deepEqual(results, [
      {
        browserInstance: "boss-a",
        status: "stopped",
        mode: "managed-cdp",
      },
    ]);
    assert.deepEqual(events, ["contexts:boss-a", "stop:boss-a"]);
    assert.equal(running.get("boss-a"), false);
    assert.equal(running.get("boss-b"), true);
  });

  it("reports not running and missing browser instances without failing the batch", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
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
    bundle.runtime.isRunning = () => false;

    const results = await pool.closeInstances(["boss-a", "missing"]);

    assert.deepEqual(results, [
      {
        browserInstance: "boss-a",
        status: "not_running",
        mode: "managed-cdp",
      },
      {
        browserInstance: "missing",
        status: "not_found",
        message: 'Browser instance "missing" was not found.',
      },
    ]);
  });

  it("disconnects remote browser instances instead of stopping external browsers", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "remote-a": {
          mode: "remote-cdp",
          cdpUrl: "http://127.0.0.1:9333",
          cdpHost: "127.0.0.1",
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/remote-a",
        },
      },
    });
    const bundle = pool.getBundle("remote-a");
    const events: string[] = [];
    bundle.runtime.isRunning = () => true;
    bundle.contextManager.closeAll = async () => {
      events.push("contexts");
    };
    bundle.runtime.disconnect = async () => {
      events.push("disconnect");
    };
    bundle.runtime.stop = async () => {
      events.push("stop");
    };

    const results = await pool.closeInstances(["remote-a"]);

    assert.deepEqual(results, [
      {
        browserInstance: "remote-a",
        status: "stopped",
        mode: "remote-cdp",
      },
    ]);
    assert.deepEqual(events, ["contexts", "disconnect"]);
  });

  it("still stops the runtime when context cleanup fails", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
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
    bundle.runtime.isRunning = () => true;
    bundle.contextManager.closeAll = async () => {
      events.push("contexts");
      throw new Error("context close failed");
    };
    bundle.runtime.stop = async () => {
      events.push("stop");
    };

    const results = await pool.closeInstances(["boss-a"]);

    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.message ?? "", /Failed to close browser contexts/);
    assert.deepEqual(events, ["contexts", "stop"]);
  });

  it("still stops the runtime after an in-flight lazy start fails", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
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
    let rejectStart: ((error: Error) => void) | undefined;
    const startGate = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });

    bundle.runtime.isRunning = () => running;
    bundle.runtime.start = async () => {
      events.push("start");
      await startGate;
    };
    bundle.contextManager.closeAll = async () => {
      events.push("contexts");
    };
    bundle.runtime.stop = async () => {
      events.push("stop");
    };

    const startPromise = pool.ensureBundleStarted("boss-a").catch(() => undefined);
    await Promise.resolve();
    const closePromise = pool.closeInstances(["boss-a"]);
    await Promise.resolve();
    running = true;
    rejectStart?.(new Error("start failed"));

    await startPromise;
    const results = await closePromise;

    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.message ?? "", /Failed to finish browser startup/);
    assert.deepEqual(events, ["start", "contexts", "stop"]);
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
