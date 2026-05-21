import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { StructuredToolError } from "@roll-agent/sdk";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { BrowserInstancePool } from "../browser-instance-pool.ts";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import { assertBrowserInstancePlatform } from "./browser-instance-platform.ts";

afterEach(() => {
  setRuntimeStateForTests({});
});

describe("browser instance platform guard", () => {
  it("rejects platform mismatches against configured browser instance platform", () => {
    const instancePool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
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
    setRuntimeStateForTests({ instancePool });

    assert.throws(
      () => assertBrowserInstancePlatform("yupao"),
      (error) => error instanceof StructuredToolError && error.payload.code === "platform_mismatch",
    );
  });

  it("allows matching platform values", () => {
    const instancePool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
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
    setRuntimeStateForTests({ instancePool });

    assert.doesNotThrow(() => assertBrowserInstancePlatform("zhipin"));
  });
});
