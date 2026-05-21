import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserStatus } from "./browser-status.ts";

describe("browser_status", () => {
  it("exposes replyAuthorityKeysLoaded, visual flags, security, tool policy and effectiveEnvSources in the output schema", () => {
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
      assert.fail("browser_status output should require security");
    }

    assert.equal(missingEffectiveEnvSources.error.issues[0]?.path[0], "security");

    const missingSecurity = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
      visualCursorEnabled: false,
      visualActivityEnabled: true,
      effectiveEnvSources: {},
    });

    if (missingSecurity.success) {
      assert.fail("browser_status output should require security before effectiveEnvSources");
    }

    assert.equal(missingSecurity.error.issues[0]?.path[0], "security");

    const missingToolPolicy = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
      visualCursorEnabled: false,
      visualActivityEnabled: true,
      security: {
        domainAllowlist: [],
        maxPageContentBytes: 102_400,
        maxSnapshotNodes: 500,
        actionPolicy: "log",
        foregroundPolicy: "when-minimized",
      },
    });

    if (missingToolPolicy.success) {
      assert.fail("browser_status output should require toolPolicy");
    }

    assert.equal(missingToolPolicy.error.issues[0]?.path[0], "toolPolicy");

    const missingPolicyWarnings = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
      visualCursorEnabled: false,
      visualActivityEnabled: true,
      security: {
        domainAllowlist: [],
        maxPageContentBytes: 102_400,
        maxSnapshotNodes: 500,
        actionPolicy: "log",
      },
      toolPolicy: {
        approvalTtlMs: 300_000,
        tools: {},
      },
    });

    if (missingPolicyWarnings.success) {
      assert.fail("browser_status output should require policyWarnings");
    }

    assert.equal(missingPolicyWarnings.error.issues[0]?.path[0], "policyWarnings");

    const missingEffectiveEnvSourcesOnly = browserStatus.output.safeParse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
      visualCursorEnabled: false,
      visualActivityEnabled: true,
      security: {
        domainAllowlist: [],
        maxPageContentBytes: 102_400,
        maxSnapshotNodes: 500,
        actionPolicy: "log",
      },
      toolPolicy: {
        approvalTtlMs: 300_000,
        tools: {},
      },
      policyWarnings: [],
    });

    if (missingEffectiveEnvSourcesOnly.success) {
      assert.fail("browser_status output should require effectiveEnvSources");
    }

    assert.equal(missingEffectiveEnvSourcesOnly.error.issues[0]?.path[0], "effectiveEnvSources");

    const parsed = browserStatus.output.parse({
      running: true,
      headless: false,
      mode: "managed-cdp",
      activeSessions: [],
      replyAuthorityKeysLoaded: true,
      visualCursorEnabled: true,
      visualActivityEnabled: true,
      security: {
        domainAllowlist: [],
        maxPageContentBytes: 102_400,
        maxSnapshotNodes: 500,
        actionPolicy: "log",
      },
      toolPolicy: {
        approvalTtlMs: 300_000,
        tools: {
          zhipin_send_prepared_reply: {
            policy: "confirm",
          },
        },
      },
      policyWarnings: [],
      effectiveEnvSources: {
        REPLY_AUTHORITY_URL: {
          present: true,
          fingerprint: "1111aaaa",
        },
        REPLY_AUTHORITY_BEARER_TOKEN: {
          present: true,
          fingerprint: "2222bbbb",
        },
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
        RECRUITMENT_EVENTS_API_BASE_URL: {
          present: true,
          fingerprint: "aaaaaaaa",
        },
        RECRUITMENT_EVENTS_API_TOKEN: {
          present: true,
          fingerprint: "bbbbbbbb",
        },
        RECRUITMENT_EVENTS_DEFAULT_AGENT_ID: {
          present: true,
          fingerprint: "cccccccc",
        },
        BROWSER_SECURITY_JSON: {
          present: false,
        },
        BROWSER_USE_POLICY_JSON: {
          present: true,
          fingerprint: "dddddddd",
        },
      },
    });

    assert.equal(parsed.replyAuthorityKeysLoaded, true);
    assert.equal(parsed.visualCursorEnabled, true);
    assert.equal(parsed.visualActivityEnabled, true);
    assert.equal(parsed.effectiveEnvSources["REPLY_AUTHORITY_URL"]?.fingerprint, "1111aaaa");
    assert.equal(
      parsed.effectiveEnvSources["REPLY_AUTHORITY_BEARER_TOKEN"]?.fingerprint,
      "2222bbbb",
    );
    assert.equal(parsed.effectiveEnvSources["REPLY_AUTHORITY_KEYS_URL"]?.fingerprint, "0123abcd");
    assert.equal(parsed.effectiveEnvSources["BROWSER_VISUAL_CURSOR"]?.fingerprint, "89abcdef");
    assert.equal(parsed.effectiveEnvSources["BROWSER_VISUAL_ACTIVITY"]?.present, false);
    assert.equal(parsed.effectiveEnvSources["BROWSER_SECURITY_JSON"]?.present, false);
    assert.equal(parsed.effectiveEnvSources["BROWSER_USE_POLICY_JSON"]?.fingerprint, "dddddddd");
    assert.equal(parsed.security.actionPolicy, "log");
    assert.equal(parsed.security.foregroundPolicy, "when-minimized");
    assert.equal(parsed.toolPolicy.tools?.["zhipin_send_prepared_reply"]?.policy, "confirm");
    assert.equal(parsed.policyWarnings.length, 0);
    assert.equal(
      parsed.effectiveEnvSources["RECRUITMENT_EVENTS_DEFAULT_AGENT_ID"]?.fingerprint,
      "cccccccc",
    );
  });
});
