import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadBrowserInstancesConfigFromEnv, loadRuntimeConfigFromEnv } from "./runtime-config.ts";

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

  it("loads browser instances from BROWSER_INSTANCES_JSON", () => {
    const config = loadBrowserInstancesConfigFromEnv({
      BROWSER_INSTANCES_JSON: JSON.stringify({
        defaultInstance: "boss-a",
        instances: {
          "boss-a": {
            platform: "zhipin",
            cdpPort: 9222,
            userDataDir: "/tmp/roll-browser/boss-a",
            profileName: "Boss A",
            windowBounds: {
              x: 0,
              y: 24,
              width: 680,
              height: 1000,
            },
            trackingAgentId: "zhipin-boss-a",
          },
        },
      }),
    });

    assert.equal(config?.defaultInstance, "boss-a");
    assert.equal(config?.instances["boss-a"]?.mode, "managed-cdp");
    assert.equal(config?.instances["boss-a"]?.cdpPort, 9222);
    assert.equal(config?.instances["boss-a"]?.profileName, "Boss A");
    assert.deepEqual(config?.instances["boss-a"]?.windowBounds, {
      x: 0,
      y: 24,
      width: 680,
      height: 1000,
    });
    assert.equal(config?.instances["boss-a"]?.trackingAgentId, "zhipin-boss-a");
  });

  it("reports invalid BROWSER_INSTANCES_JSON clearly", () => {
    assert.throws(
      () => loadBrowserInstancesConfigFromEnv({ BROWSER_INSTANCES_JSON: "{" }),
      /BROWSER_INSTANCES_JSON must be valid JSON/,
    );
  });

  it("rejects invalid browser instance declarations from BROWSER_INSTANCES_JSON", () => {
    assert.throws(
      () =>
        loadBrowserInstancesConfigFromEnv({
          BROWSER_INSTANCES_JSON: JSON.stringify({
            defaultInstance: "missing",
            instances: {
              "boss-a": {
                cdpPort: 9222,
                userDataDir: "/tmp/roll-browser/boss-a",
              },
            },
          }),
        }),
      /defaultInstance.*missing.*not declared/s,
    );

    assert.throws(
      () =>
        loadBrowserInstancesConfigFromEnv({
          BROWSER_INSTANCES_JSON: JSON.stringify({
            instances: {
              "boss-a": {
                userDataDir: "/tmp/roll-browser/boss-a",
              },
            },
          }),
        }),
      /managed-cdp browser instance requires cdpPort/,
    );

    assert.throws(
      () =>
        loadBrowserInstancesConfigFromEnv({
          BROWSER_INSTANCES_JSON: JSON.stringify({
            instances: {
              "boss-a": {
                cdpPort: 9222,
                userDataDir: "/tmp/roll-browser/boss",
              },
              "boss-b": {
                cdpPort: 9222,
                userDataDir: "/tmp/roll-browser/boss",
              },
            },
          }),
        }),
      /cdpPort 9222.*userDataDir/s,
    );
  });
});
