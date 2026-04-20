import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAgentEnv,
  getAgentEnvFromAgentsConfig,
  getMissingAgentEnvRuntimeIssues,
  inspectAgentEnvRequirements,
} from "./helpers.ts";
import { validateConfigText } from "./loader.ts";

describe("config/helpers", () => {
  it("should ignore unresolved agents.env placeholders during readiness inspection", () => {
    const report = inspectAgentEnvRequirements(
      "placeholder-agent",
      {
        required: [{ name: "API_KEY" }],
        optional: [{ name: "MODEL_ID", default: "provider/default-model" }],
      },
      {
        placeholderAgent: {
          API_KEY: String.raw`\${MISSING_API_KEY}`,
        },
      },
    );

    if (!report) {
      assert.fail("expected readiness report");
    }
    assert.equal(report.items[0]?.source, "missing");
    assert.equal(report.items[1]?.source, "default");
    assert.deepEqual(
      report.missingRequired.map((item) => item.name),
      ["API_KEY"],
    );
  });

  it("should fall back to process.env when agents.env contains an unresolved placeholder", () => {
    const report = inspectAgentEnvRequirements(
      "placeholder-agent",
      {
        required: [{ name: "API_KEY" }],
      },
      {
        placeholderAgent: {
          API_KEY: String.raw`\${MISSING_API_KEY}`,
        },
      },
      { API_KEY: "shell-key" },
    );

    if (!report) {
      assert.fail("expected readiness report");
    }
    assert.equal(report.items[0]?.source, "process.env");
    assert.deepEqual(
      report.processEnvOnlyRequired.map((item) => item.name),
      ["API_KEY"],
    );
  });

  it("should not inject unresolved agents.env placeholders into runtime env", () => {
    const config = validateConfigText(
      `llm:
  default-provider: anthropic
  default-model: test
  providers: {}
agents:
  data-dir: /tmp/test
  env:
    placeholder-agent:
      API_KEY: \${MISSING_API_KEY}
      API_URL: https://example.com
`,
      "/tmp/roll.config.yaml",
    );

    assert.deepEqual(getAgentEnv(config, "placeholder-agent"), {
      API_URL: "https://example.com",
    });
  });

  it("should expose filtered runtime env from agents config only", () => {
    const config = validateConfigText(
      `llm:
  default-provider: anthropic
  default-model: test
  providers: {}
agents:
  data-dir: /tmp/test
  env:
    placeholder-agent:
      API_KEY: \${MISSING_API_KEY}
      API_URL: https://example.com
`,
      "/tmp/roll.config.yaml",
    );

    assert.deepEqual(getAgentEnvFromAgentsConfig(config.agents, "placeholder-agent"), {
      API_URL: "https://example.com",
    });
  });

  it("should convert missing required env items into runtime issues", () => {
    const report = inspectAgentEnvRequirements(
      "placeholder-agent",
      {
        required: [
          {
            name: "API_KEY",
            purpose: "Provider API key",
          },
        ],
      },
      {},
    );

    assert.deepEqual(getMissingAgentEnvRuntimeIssues(report), [
      {
        category: "env",
        code: "missing_required_env",
        name: "API_KEY",
        message: "必填环境变量 API_KEY 未配置",
        purpose: "Provider API key",
      },
    ]);
  });
});
