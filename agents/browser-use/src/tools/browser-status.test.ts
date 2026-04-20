import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserStatus } from "./browser-status.ts";

describe("browser_status", () => {
  it("exposes replyAuthorityKeysLoaded in the output schema", () => {
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

    const parsed = browserStatus.output.parse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
    });

    assert.equal(parsed.replyAuthorityKeysLoaded, true);
  });
});
