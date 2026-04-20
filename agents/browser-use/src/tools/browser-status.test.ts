import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserStatus } from "./browser-status.ts";

describe("browser_status", () => {
  it("exposes replyAuthorityKeysLoaded and effectiveEnvSources in the output schema", () => {
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

    const missingEffectiveEnvSources = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
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
      effectiveEnvSources: {
        REPLY_AUTHORITY_KEYS_URL: {
          present: true,
          fingerprint: "0123abcd",
        },
      },
    });

    assert.equal(parsed.replyAuthorityKeysLoaded, true);
    assert.equal(parsed.effectiveEnvSources["REPLY_AUTHORITY_KEYS_URL"]?.fingerprint, "0123abcd");
  });
});
