import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BrowserSecurityConfigSchema } from "@roll-agent/browser";
import { StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import {
  assertBrowserUseToolAllowed,
  collectBrowserUsePolicyWarnings,
  loadBrowserUsePolicyFromEnv,
  resetBrowserUsePolicyForTests,
  setBrowserUsePolicy,
} from "./browser-use-policy.ts";
import { resetToolActionApprovalsForTests } from "./tool-action-approval.ts";

function createTestContext(): AgentContext {
  return {
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
}

function readApprovalIdFromError(error: unknown): string {
  assert.ok(error instanceof StructuredToolError);
  const approvalRequest = error.payload.details?.["approvalRequest"];
  assert.equal(typeof approvalRequest, "object");
  assert.notEqual(approvalRequest, null);
  assert.equal(typeof (approvalRequest as Record<string, unknown>)["id"], "string");
  return (approvalRequest as { id: string }).id;
}

describe("browser-use tool policy", () => {
  afterEach(() => {
    resetBrowserUsePolicyForTests();
    resetToolActionApprovalsForTests();
  });

  it("loads the compatible default policy from an empty env", () => {
    assert.deepEqual(loadBrowserUsePolicyFromEnv({}), {
      approvalTtlMs: 300_000,
      tools: {},
    });
  });

  it("loads normalized tool policy from BROWSER_USE_POLICY_JSON", () => {
    assert.deepEqual(
      loadBrowserUsePolicyFromEnv({
        BROWSER_USE_POLICY_JSON: JSON.stringify({
          approvalTtlMs: 12_000,
          tools: {
            zhipin_send_prepared_reply: {
              policy: "confirm",
            },
          },
        }),
      }),
      {
        approvalTtlMs: 12_000,
        tools: {
          zhipin_send_prepared_reply: {
            policy: "confirm",
          },
        },
      },
    );
  });

  it("reports invalid BROWSER_USE_POLICY_JSON clearly", () => {
    assert.throws(
      () => loadBrowserUsePolicyFromEnv({ BROWSER_USE_POLICY_JSON: "{" }),
      /BROWSER_USE_POLICY_JSON must be valid JSON/,
    );
    assert.throws(
      () =>
        loadBrowserUsePolicyFromEnv({
          BROWSER_USE_POLICY_JSON: '{"tools":{"zhipin_send_prepared_reply":{"policy":"prompt"}}}',
        }),
      /BROWSER_USE_POLICY_JSON is invalid:.*policy/s,
    );
    assert.throws(
      () => loadBrowserUsePolicyFromEnv({ BROWSER_USE_POLICY_JSON: '{"approvalTtlMs":0}' }),
      /BROWSER_USE_POLICY_JSON is invalid:.*approvalTtlMs/s,
    );
  });

  it("warns about unknown tools and double confirmation policy combinations", () => {
    const warnings = collectBrowserUsePolicyWarnings({
      browserSecurity: BrowserSecurityConfigSchema.parse({ actionPolicy: "confirm" }),
      toolPolicy: {
        approvalTtlMs: 300_000,
        tools: {
          unknown_tool: { policy: "deny" },
          zhipin_send_prepared_reply: { policy: "confirm" },
        },
      },
    });

    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ["unknown_tool_policy", "double_confirmation", "browser_action_policy_not_recommended"],
    );
  });

  it("requires and consumes a matching tool action approval for confirm policies", () => {
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    const subject = {
      tool: "zhipin_send_prepared_reply",
      target: "prep_1",
      summary: "发送预备回复: 你好",
      digest: "sha256:abc",
    };
    let approvalId = "";

    assert.throws(
      () => {
        assertBrowserUseToolAllowed(createTestContext(), { subject });
      },
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );

    assert.doesNotThrow(() => {
      assertBrowserUseToolAllowed(createTestContext(), {
        subject,
        approval: { id: approvalId },
      });
    });
    assert.throws(
      () => {
        assertBrowserUseToolAllowed(createTestContext(), {
          subject,
          approval: { id: approvalId },
        });
      },
      (error) => {
        assert.equal((error as StructuredToolError).payload.code, "needs_confirmation");
        return true;
      },
    );
  });

  it("rejects mismatched approval subjects", () => {
    setBrowserUsePolicy({
      approvalTtlMs: 300_000,
      tools: {
        zhipin_send_prepared_reply: { policy: "confirm" },
      },
    });
    const subject = {
      tool: "zhipin_send_prepared_reply",
      target: "prep_1",
      digest: "sha256:abc",
    };
    let approvalId = "";

    assert.throws(
      () => {
        assertBrowserUseToolAllowed(createTestContext(), { subject });
      },
      (error) => {
        approvalId = readApprovalIdFromError(error);
        return true;
      },
    );

    assert.throws(
      () => {
        assertBrowserUseToolAllowed(createTestContext(), {
          subject: { ...subject, target: "prep_2" },
          approval: { id: approvalId },
        });
      },
      (error) => {
        assert.equal((error as StructuredToolError).payload.code, "needs_confirmation");
        return true;
      },
    );
  });
});
