import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserRuntimeConfigSchema } from "../types/index.ts";
import {
  probeBrowserRuntimeCdpHealth,
  resolveBrowserRuntimeCdpEndpoint,
  type FetchCdpHealth,
} from "./cdp-health.ts";

test("resolveBrowserRuntimeCdpEndpoint derives managed-cdp endpoint and port", () => {
  const target = resolveBrowserRuntimeCdpEndpoint(
    BrowserRuntimeConfigSchema.parse({
      mode: "managed-cdp",
      cdpHost: "127.0.0.1",
      cdpPort: 9333,
    }),
  );

  assert.deepEqual(target, {
    endpoint: "http://127.0.0.1:9333",
    port: 9333,
  });
});

test("probeBrowserRuntimeCdpHealth checks native HTTP CDP endpoints without Playwright attach", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchCdpHealth = async (input) => {
    calls.push(String(input));
    return new Response("{}", { status: String(input).endsWith("/json/list") ? 500 : 200 });
  };

  const health = await probeBrowserRuntimeCdpHealth(
    BrowserRuntimeConfigSchema.parse({
      mode: "managed-cdp",
      cdpPort: 9444,
    }),
    { fetch: fetchImpl },
  );

  assert.deepEqual(calls, [
    "http://127.0.0.1:9444/json/version",
    "http://127.0.0.1:9444/json/list",
  ]);
  assert.equal(health.versionReachable, true);
  assert.equal(health.listReachable, false);
});
