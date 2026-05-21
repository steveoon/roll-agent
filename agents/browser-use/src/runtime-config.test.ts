import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadRuntimeConfigFromEnv } from "./runtime-config.ts";

describe("browser-use runtime config", () => {
  it("loads normalized browser security config from BROWSER_SECURITY_JSON", () => {
    const config = loadRuntimeConfigFromEnv({
      BROWSER_SECURITY_JSON: JSON.stringify({
        domainAllowlist: [" ZHIPIN.COM "],
        maxPageContentBytes: 1_024,
        maxSnapshotNodes: 42,
        actionPolicy: "confirm",
        foregroundPolicy: "never",
      }),
    });

    assert.deepEqual(config.security, {
      domainAllowlist: ["zhipin.com"],
      maxPageContentBytes: 1_024,
      maxSnapshotNodes: 42,
      actionPolicy: "confirm",
      foregroundPolicy: "never",
    });
  });

  it("reports invalid BROWSER_SECURITY_JSON clearly", () => {
    assert.throws(
      () => loadRuntimeConfigFromEnv({ BROWSER_SECURITY_JSON: "{" }),
      /BROWSER_SECURITY_JSON must be valid JSON/,
    );

    assert.throws(
      () => loadRuntimeConfigFromEnv({ BROWSER_SECURITY_JSON: '{"actionPolicy":"prompt"}' }),
      /actionPolicy/,
    );
  });
});
