import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserStatus } from "./browser-status.ts";

describe("browser_status", () => {
  it("exposes replyAuthorityKeysLoaded, visualCursorEnabled, visualActivityEnabled and effectiveEnvSources in the output schema", () => {
    const missingField = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
    });

    if (missingField.success) {
      assert.fail("browser_status output should require replyAuthorityKeysLoaded");
    }

    assert.equal(missingField.error.issues[0]?.path[0], "replyAuthorityKeysLoaded");

    const missingVisualCursorEnabled = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
    });

    if (missingVisualCursorEnabled.success) {
      assert.fail("browser_status output should require visualCursorEnabled");
    }

    assert.equal(missingVisualCursorEnabled.error.issues[0]?.path[0], "visualCursorEnabled");

    const missingVisualActivityEnabled = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
      visualCursorEnabled: true,
    });

    if (missingVisualActivityEnabled.success) {
      assert.fail("browser_status output should require visualActivityEnabled");
    }

    assert.equal(missingVisualActivityEnabled.error.issues[0]?.path[0], "visualActivityEnabled");

    const missingEffectiveEnvSources = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
      visualCursorEnabled: false,
      visualActivityEnabled: true,
    });

    if (missingEffectiveEnvSources.success) {
      assert.fail("browser_status output should require effectiveEnvSources");
    }

    assert.equal(missingEffectiveEnvSources.error.issues[0]?.path[0], "effectiveEnvSources");

    const parsed = browserStatus.output.parse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
      visualCursorEnabled: true,
      visualActivityEnabled: true,
      effectiveEnvSources: {
        REPLY_AUTHORITY_KEYS_URL: {
          present: true,
          fingerprint: "0123abcd",
        },
        BROWSER_VISUAL_CURSOR: {
          present: true,
          fingerprint: "89abcdef",
        },
        BROWSER_VISUAL_ACTIVITY: {
          present: false,
        },
      },
    });

    assert.equal(parsed.replyAuthorityKeysLoaded, true);
    assert.equal(parsed.visualCursorEnabled, true);
    assert.equal(parsed.visualActivityEnabled, true);
    assert.equal(parsed.effectiveEnvSources["REPLY_AUTHORITY_KEYS_URL"]?.fingerprint, "0123abcd");
    assert.equal(parsed.effectiveEnvSources["BROWSER_VISUAL_CURSOR"]?.fingerprint, "89abcdef");
    assert.equal(parsed.effectiveEnvSources["BROWSER_VISUAL_ACTIVITY"]?.present, false);
  });
});
