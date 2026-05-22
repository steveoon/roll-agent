import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectBrowserConfigWarnings } from "./browser-inspection.ts";

describe("browser config inspection", () => {
  it("warns when multiple instances are declared without defaultInstance", () => {
    const warnings = collectBrowserConfigWarnings(
      {
        instances: {
          "boss-a": {
            mode: "managed-cdp",
            cdpHost: "127.0.0.1",
            cdpPort: 9222,
            channel: "chrome",
            userDataDir: "/tmp/boss-a",
          },
          "boss-b": {
            mode: "managed-cdp",
            cdpHost: "127.0.0.1",
            cdpPort: 9223,
            channel: "chrome",
            userDataDir: "/tmp/boss-b",
          },
        },
      },
      undefined,
      {},
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /default-instance/);
  });

  it("warns when legacy browser identity env keys coexist with browser.instances", () => {
    const warnings = collectBrowserConfigWarnings(
      {
        defaultInstance: "boss-a",
        instances: {
          "boss-a": {
            mode: "managed-cdp",
            cdpHost: "127.0.0.1",
            cdpPort: 9222,
            channel: "chrome",
            userDataDir: "/tmp/boss-a",
          },
        },
      },
      {
        BROWSER_CDP_PORT: "9222",
        BROWSER_USER_DATA_DIR: "/tmp/legacy",
        BROWSER_PROFILE_COLOR: "#2563EB",
      },
      {},
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /BROWSER_CDP_PORT/);
    assert.match(warnings[0] ?? "", /BROWSER_PROFILE_COLOR/);
    assert.match(warnings[0] ?? "", /会被忽略/);
  });

  it("warns when legacy browser identity env keys are inherited from shell env", () => {
    const warnings = collectBrowserConfigWarnings(
      {
        defaultInstance: "boss-a",
        instances: {
          "boss-a": {
            mode: "managed-cdp",
            cdpHost: "127.0.0.1",
            cdpPort: 9222,
            channel: "chrome",
            userDataDir: "/tmp/boss-a",
          },
        },
      },
      undefined,
      {
        BROWSER_CDP_URL: "http://127.0.0.1:9222",
      },
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /shell/);
    assert.match(warnings[0] ?? "", /BROWSER_CDP_URL/);
  });
});
