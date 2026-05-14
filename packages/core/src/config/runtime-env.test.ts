import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { inspectAgentEnvRequirements } from "./helpers.ts";
import {
  AgentRuntimeEnvDiagnosticPayloadSchema,
  type AgentRuntimeEnvDiagnosticPayload,
  formatAgentEnvRuntimeStatus,
  inspectAgentRuntimeEnvRequirements,
  shouldSkipRuntimeReadinessForTool,
  summarizeAgentRuntimeEnvReport,
  type AgentRuntimeEnvInspection,
} from "./runtime-env.ts";

describe("config/runtime-env", () => {
  it("accepts browser security diagnostics as optional browser_status payload", () => {
    const parsed = AgentRuntimeEnvDiagnosticPayloadSchema.parse({
      effectiveEnvSources: {},
      security: {
        domainAllowlist: ["zhipin.com"],
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
      policyWarnings: [
        {
          code: "double_confirmation",
          message: "double confirmation",
        },
      ],
    });

    assert.equal(parsed.security?.actionPolicy, "log");
    assert.deepEqual(parsed.security?.domainAllowlist, ["zhipin.com"]);
    assert.equal(parsed.toolPolicy?.tools["zhipin_send_prepared_reply"]?.policy, "confirm");
    assert.equal(parsed.policyWarnings?.[0]?.code, "double_confirmation");
  });

  it("marks matching runtime env as stable", () => {
    const declarationReport = inspectAgentEnvRequirements(
      "browser-use-agent",
      {
        required: [{ name: "REPLY_AUTHORITY_KEYS_URL" }],
      },
      {
        "browser-use-agent": {
          REPLY_AUTHORITY_KEYS_URL: "https://reply-authority.example.com/keys",
        },
      },
    );

    if (!declarationReport) {
      assert.fail("expected declaration report");
    }

    const runtimeReport = inspectAgentRuntimeEnvRequirements(
      declarationReport,
      {
        REPLY_AUTHORITY_KEYS_URL: "https://reply-authority.example.com/keys",
      },
      {
        status: "verified",
        toolName: "browser_status",
        payload: {
          effectiveEnvSources: {
            REPLY_AUTHORITY_KEYS_URL: {
              present: true,
              fingerprint: fingerprint("https://reply-authority.example.com/keys"),
            },
          },
        },
      },
    );

    assert.equal(runtimeReport.missingRequired.length, 0);
    assert.equal(runtimeReport.ephemeralItems.length, 0);
    assert.equal(
      formatAgentEnvRuntimeStatus(runtimeReport.items[0] ?? fail("missing runtime item")),
      "✓ from yaml (stable)",
    );
    assert.deepEqual(summarizeAgentRuntimeEnvReport(runtimeReport), {
      status: "ok",
      message: "声明的必填项已在运行态生效（browser_status）",
    });
  });

  it("marks mismatched runtime env as ephemeral", () => {
    const declarationReport = inspectAgentEnvRequirements(
      "smart-reply-agent",
      {
        required: [{ name: "REPLY_AUTHORITY_BEARER_TOKEN" }],
      },
      {
        "smart-reply-agent": {
          REPLY_AUTHORITY_BEARER_TOKEN: "yaml-token",
        },
      },
      { REPLY_AUTHORITY_BEARER_TOKEN: "shell-token" },
    );

    if (!declarationReport) {
      assert.fail("expected declaration report");
    }

    const runtimeReport = inspectAgentRuntimeEnvRequirements(
      declarationReport,
      {
        REPLY_AUTHORITY_BEARER_TOKEN: "yaml-token",
      },
      verifiedInspection({
        REPLY_AUTHORITY_BEARER_TOKEN: {
          present: true,
          fingerprint: fingerprint("shell-token"),
        },
      }),
    );

    assert.equal(runtimeReport.ephemeralItems.length, 1);
    assert.equal(
      formatAgentEnvRuntimeStatus(runtimeReport.items[0] ?? fail("missing runtime item")),
      "⚠ differs from yaml (ephemeral)",
    );
    assert.deepEqual(summarizeAgentRuntimeEnvReport(runtimeReport), {
      status: "warn",
      message: "运行态漂移: REPLY_AUTHORITY_BEARER_TOKEN",
    });
  });

  it("marks required yaml env missing from runtime as fail", () => {
    const declarationReport = inspectAgentEnvRequirements(
      "browser-use-agent",
      {
        required: [{ name: "REPLY_AUTHORITY_KEYS_URL" }],
      },
      {
        "browser-use-agent": {
          REPLY_AUTHORITY_KEYS_URL: "https://reply-authority.example.com/keys",
        },
      },
    );

    if (!declarationReport) {
      assert.fail("expected declaration report");
    }

    const runtimeReport = inspectAgentRuntimeEnvRequirements(
      declarationReport,
      {
        REPLY_AUTHORITY_KEYS_URL: "https://reply-authority.example.com/keys",
      },
      verifiedInspection({
        REPLY_AUTHORITY_KEYS_URL: {
          present: false,
        },
      }),
    );

    assert.equal(runtimeReport.missingRequired.length, 1);
    assert.deepEqual(summarizeAgentRuntimeEnvReport(runtimeReport), {
      status: "fail",
      message: "运行态缺失: REPLY_AUTHORITY_KEYS_URL",
    });
  });

  it("falls back to declaration-only summary when diagnostics are unavailable", () => {
    const declarationReport = inspectAgentEnvRequirements(
      "legacy-agent",
      {
        required: [{ name: "REQUIRED_TOKEN" }],
      },
      {},
      { REQUIRED_TOKEN: "shell-token" },
    );

    if (!declarationReport) {
      assert.fail("expected declaration report");
    }

    const runtimeReport = inspectAgentRuntimeEnvRequirements(declarationReport, undefined, {
      status: "unverified",
      reason: "diagnostic-tool-unavailable",
      message: "agent 未暴露 diagnostic_status / browser_status.effectiveEnvSources",
    });

    assert.equal(runtimeReport.missingRequired.length, 0);
    assert.deepEqual(summarizeAgentRuntimeEnvReport(runtimeReport), {
      status: "warn",
      message:
        "依赖当前 shell 环境: REQUIRED_TOKEN；agent 未暴露 diagnostic_status / browser_status.effectiveEnvSources",
    });
  });

  it("keeps runtime fingerprint optional instead of coercing it to an empty string sentinel", () => {
    const declarationReport = inspectAgentEnvRequirements(
      "browser-use-agent",
      {
        required: [{ name: "REPLY_AUTHORITY_KEYS_URL" }],
      },
      {
        "browser-use-agent": {
          REPLY_AUTHORITY_KEYS_URL: "https://reply-authority.example.com/keys",
        },
      },
    );

    if (!declarationReport) {
      assert.fail("expected declaration report");
    }

    const runtimeReport = inspectAgentRuntimeEnvRequirements(
      declarationReport,
      {
        REPLY_AUTHORITY_KEYS_URL: "https://reply-authority.example.com/keys",
      },
      verifiedInspection({
        REPLY_AUTHORITY_KEYS_URL: {
          present: true,
        },
      }),
    );

    const runtimeItem = runtimeReport.items[0] ?? fail("missing runtime item");
    if (!runtimeItem.runtime.verified || !runtimeItem.runtime.present) {
      assert.fail("expected a verified present runtime item");
    }

    assert.equal(runtimeItem.runtime.fingerprint, undefined);
    assert.equal(runtimeItem.runtime.matchesAgentsEnv, false);
    assert.equal(formatAgentEnvRuntimeStatus(runtimeItem), "⚠ differs from yaml (ephemeral)");
  });

  it("skips runtime readiness checks only for diagnostic tools", () => {
    assert.equal(shouldSkipRuntimeReadinessForTool("diagnostic_status"), true);
    assert.equal(shouldSkipRuntimeReadinessForTool("browser_status"), true);
    assert.equal(shouldSkipRuntimeReadinessForTool("generate_reply"), false);
  });
});

function verifiedInspection(
  effectiveEnvSources: AgentRuntimeEnvDiagnosticPayload["effectiveEnvSources"],
): AgentRuntimeEnvInspection {
  return {
    status: "verified",
    toolName: "diagnostic_status",
    payload: { effectiveEnvSources },
  };
}

function fail(message: string): never {
  assert.fail(message);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
