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
      { startRuntime: false },
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
