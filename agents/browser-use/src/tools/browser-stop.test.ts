import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import { BrowserInstancePool } from "../browser-instance-pool.ts";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import { browserStop, resolveBrowserStopTargets } from "./browser-stop.ts";

const testContext: AgentContext = {
  llm: {
    generateText: async () => "",
  },
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

afterEach(() => {
  setRuntimeStateForTests({});
});

describe("browser_stop tool", () => {
  it("stops one browser instance", async () => {
    const pool = createPool(["boss-a", "boss-b"]);
    const events = markInstancesRunning(pool);
    setRuntimeStateForTests({ instancePool: pool });

    const result = await browserStop.execute(
      { browserInstance: "boss-a", all: false },
      testContext,
    );

    assert.deepEqual(result, {
      ok: true,
      stopped: 1,
      results: [
        {
          browserInstance: "boss-a",
          status: "stopped",
          mode: "managed-cdp",
        },
      ],
    });
    assert.deepEqual(events, ["contexts:boss-a", "stop:boss-a"]);
  });

  it("stops multiple browser instances", async () => {
    const pool = createPool(["boss-a", "boss-b"]);
    const events = markInstancesRunning(pool);
    setRuntimeStateForTests({ instancePool: pool });

    const result = await browserStop.execute(
      { browserInstances: ["boss-a", "boss-b"], all: false },
      testContext,
    );

    assert.equal(result.ok, true);
    assert.equal(result.stopped, 2);
    assert.deepEqual(
      result.results.map((item) => item.browserInstance),
      ["boss-a", "boss-b"],
    );
    assert.deepEqual([...events].sort(), [
      "contexts:boss-a",
      "contexts:boss-b",
      "stop:boss-a",
      "stop:boss-b",
    ]);
  });

  it("stops all configured browser instances", async () => {
    const pool = createPool(["boss-a", "boss-b"]);
    markInstancesRunning(pool);
    setRuntimeStateForTests({ instancePool: pool });

    const result = await browserStop.execute({ all: true }, testContext);

    assert.equal(result.ok, true);
    assert.equal(result.stopped, 2);
    assert.deepEqual(
      result.results.map((item) => item.browserInstance),
      ["boss-a", "boss-b"],
    );
  });

  it("returns needs_input when no target is provided", () => {
    assert.throws(
      () => resolveBrowserStopTargets({ all: false }, ["boss-a"]),
      (error) => error instanceof StructuredToolError && error.payload.code === "needs_input",
    );
  });

  it("rejects all combined with explicit instances", () => {
    assert.throws(
      () => browserStop.input.parse({ all: true, browserInstance: "boss-a" }),
      /all cannot be combined/,
    );
    assert.throws(
      () => browserStop.input.parse({ all: true, browserInstances: ["boss-a"] }),
      /all cannot be combined/,
    );
  });

  it("reports missing instances as a failed command result", async () => {
    const pool = createPool(["boss-a"]);
    setRuntimeStateForTests({ instancePool: pool });

    const result = await browserStop.execute(
      { browserInstances: ["boss-a", "missing"], all: false },
      testContext,
    );

    assert.equal(result.ok, false);
    assert.equal(result.stopped, 0);
    assert.deepEqual(result.results, [
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
});

function createPool(instanceIds: readonly string[]): BrowserInstancePool {
  return new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
    instances: Object.fromEntries(
      instanceIds.map((id, index) => [
        id,
        {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222 + index,
          channel: "chrome",
          userDataDir: `/tmp/roll-browser/${id}`,
        },
      ]),
    ),
  });
}

function markInstancesRunning(pool: BrowserInstancePool): string[] {
  const running = new Map(pool.listBundles().map((bundle) => [bundle.id, true]));
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
  return events;
}
