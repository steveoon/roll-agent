import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { defineTool, StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { BrowserInstancePool } from "../browser-instance-pool.ts";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import { withBrowserInstanceInput } from "./browser-instance-input.ts";

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

describe("browser instance input wrapper", () => {
  it("does not start a browser runtime for diagnostic-only tools", async () => {
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
    let startCount = 0;
    for (const bundle of pool.listBundles()) {
      bundle.runtime.start = async () => {
        startCount += 1;
      };
    }
    setRuntimeStateForTests({ instancePool: pool });

    const diagnosticTool = withBrowserInstanceInput(
      defineTool({
        name: "browser_status",
        description: "test diagnostic",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      }),
      // 与 index.ts 生产接线一致：诊断工具不启动 runtime、不进互斥队列
      { startRuntime: false, serializePageOps: false },
    );

    const result = await diagnosticTool.execute({} as never, testContext);

    assert.deepEqual(result, { ok: true });
    assert.equal(startCount, 0);
  });

  it("validates explicit browserInstance for diagnostic-only tools without starting runtime", async () => {
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
    let startCount = 0;
    pool.getBundle("boss-a").runtime.start = async () => {
      startCount += 1;
    };
    setRuntimeStateForTests({ instancePool: pool });

    const diagnosticTool = withBrowserInstanceInput(
      defineTool({
        name: "browser_status",
        description: "test diagnostic",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      }),
      { startRuntime: false },
    );

    await assert.rejects(
      async () =>
        await diagnosticTool.execute({ browserInstance: "missing-instance" } as never, testContext),
      (error) =>
        error instanceof StructuredToolError && error.payload.code === "browser_instance_not_found",
    );
    assert.equal(startCount, 0);
  });

  it("rejects platform-prefixed tools before starting the wrong browser instance", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      defaultInstance: "boss-a",
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
          platform: "zhipin",
        },
      },
    });
    const runtime = pool.getBundle("boss-a").runtime;
    let startCount = 0;
    runtime.start = async () => {
      startCount += 1;
    };
    setRuntimeStateForTests({ instancePool: pool });

    const yupaoTool = withBrowserInstanceInput(
      defineTool({
        name: "yupao_read_messages",
        description: "test platform tool",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      }),
    );

    await assert.rejects(
      async () => await yupaoTool.execute({} as never, testContext),
      (error) => error instanceof StructuredToolError && error.payload.code === "platform_mismatch",
    );
    assert.equal(startCount, 0);
  });

  it("serializes concurrent executes on the same browser instance", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "serialize-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/serialize-a",
        },
      },
    });
    setRuntimeStateForTests({ instancePool: pool });

    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;

    const pageTool = withBrowserInstanceInput(
      defineTool({
        name: "test_page_tool",
        description: "test page tool",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async () => {
          callCount += 1;
          const id = callCount;
          events.push(`run-${id}:start`);
          if (id === 1) {
            await firstGate;
          }
          events.push(`run-${id}:end`);
          return { ok: true };
        },
      }),
      { startRuntime: false },
    );

    const first = pageTool.execute({ browserInstance: "serialize-a" } as never, testContext);
    const second = pageTool.execute({ browserInstance: "serialize-a" } as never, testContext);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["run-1:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["run-1:start", "run-1:end", "run-2:start", "run-2:end"]);
  });

  it("does not queue tools with serializePageOps disabled", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "diag-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/diag-a",
        },
      },
    });
    setRuntimeStateForTests({ instancePool: pool });

    let releaseBlocked!: () => void;
    const blockedGate = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });

    const blockingTool = withBrowserInstanceInput(
      defineTool({
        name: "test_blocking_tool",
        description: "test blocking page tool",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async () => {
          await blockedGate;
          return { ok: true };
        },
      }),
      { startRuntime: false },
    );
    const diagnosticTool = withBrowserInstanceInput(
      defineTool({
        name: "test_diag_tool",
        description: "test diagnostic tool",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      }),
      { startRuntime: false, serializePageOps: false },
    );

    const blocked = blockingTool.execute({ browserInstance: "diag-a" } as never, testContext);
    // 诊断工具不进锁：即使同实例有长操作在执行也应立即返回
    const result = await diagnosticTool.execute(
      { browserInstance: "diag-a" } as never,
      testContext,
    );
    assert.deepEqual(result, { ok: true });

    releaseBlocked();
    await blocked;
  });

  it("discards queued execution when the request signal is cancelled", async () => {
    const pool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "cancel-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/cancel-a",
        },
      },
    });
    setRuntimeStateForTests({ instancePool: pool });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let queuedExecuted = false;

    const pageTool = withBrowserInstanceInput(
      defineTool({
        name: "test_cancel_tool",
        description: "test cancellable page tool",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async (input) => {
          if ((input as { readonly probe?: string }).probe === "queued") {
            queuedExecuted = true;
          } else {
            await firstGate;
          }
          return { ok: true };
        },
      }),
      { startRuntime: false },
    );

    const controller = new AbortController();
    const cancellableContext: AgentContext = { ...testContext, signal: controller.signal };

    const first = pageTool.execute({ browserInstance: "cancel-a" } as never, testContext);
    const queued = pageTool.execute(
      { browserInstance: "cancel-a", probe: "queued" } as never,
      cancellableContext,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await assert.rejects(
      queued,
      (error) =>
        error instanceof StructuredToolError && error.payload.code === "cancelled_while_queued",
    );
    assert.equal(queuedExecuted, false);

    releaseFirst();
    await first;
  });

  it("adds browserInstance to refined object schemas without dropping refinements", async () => {
    const refinedTool = withBrowserInstanceInput(
      defineTool({
        name: "test_refined_tool",
        description: "test refined schema",
        input: z
          .object({
            ageMin: z.number().int().optional(),
            ageMax: z.number().int().optional(),
          })
          .refine(
            (input) =>
              input.ageMin === undefined ||
              input.ageMax === undefined ||
              input.ageMin <= input.ageMax,
            {
              path: ["ageMax"],
              message: "ageMax must be greater than or equal to ageMin",
            },
          ),
        output: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      }),
      { startRuntime: false },
    );

    const parsed = refinedTool.input.parse({
      ageMin: 20,
      ageMax: 40,
      browserInstance: "boss-a",
    }) as { readonly browserInstance?: string };

    assert.equal(parsed.browserInstance, "boss-a");
    assert.throws(
      () => refinedTool.input.parse({ ageMin: 40, ageMax: 20, browserInstance: "boss-a" }),
      /ageMax must be greater than or equal to ageMin/,
    );
  });
});
