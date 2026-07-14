import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENV_REFERENCE_TEMPLATE,
  isCompleteEnvReference,
  validateEnvironmentReference,
  validateAgentScalarInput,
  validateJsonText,
  validateNumberInput,
} from "./input-validation.ts";

function envReference(name: string): string {
  return ENV_REFERENCE_TEMPLATE.replace("ENV_VAR", name);
}

describe("Roll UI input validation", () => {
  it("validates inclusive, exclusive and integer number constraints", () => {
    const constraints = {
      minimum: 0,
      maximum: 10,
      exclusiveMinimum: true,
      exclusiveMaximum: false,
      integer: true,
    } as const;

    assert.equal(validateNumberInput("", constraints), undefined);
    assert.equal(validateNumberInput("0", constraints), "必须大于 0");
    assert.equal(validateNumberInput("1.5", constraints), "请输入整数");
    assert.equal(validateNumberInput("11", constraints), "不能大于 10");
    assert.equal(validateNumberInput("10", constraints), undefined);
  });

  it("accepts only complete environment references", () => {
    assert.equal(isCompleteEnvReference(ENV_REFERENCE_TEMPLATE), true);
    assert.equal(isCompleteEnvReference(`prefix-${ENV_REFERENCE_TEMPLATE}`), false);
    assert.equal(validateEnvironmentReference(envReference("ROLL_MODE")), undefined);
    assert.match(validateEnvironmentReference("ROLL_MODE") ?? "", /完整/u);
  });

  it("allows Agent scalar literals or a complete environment reference only", () => {
    assert.equal(validateAgentScalarInput("boolean", "true"), undefined);
    assert.equal(validateAgentScalarInput("number", "30000"), undefined);
    assert.equal(validateAgentScalarInput("boolean", envReference("FEATURE_ENABLED")), undefined);
    assert.equal(validateAgentScalarInput("number", envReference("TIMEOUT_MS")), undefined);
    assert.match(validateAgentScalarInput("boolean", "FEATURE_ENABLED") ?? "", /完整/u);
    assert.match(
      validateAgentScalarInput("number", envReference("TIMEOUT_MS").slice(0, -1)) ?? "",
      /完整/u,
    );
  });

  it("validates JSON while allowing an unset field", () => {
    assert.equal(validateJsonText("", false), undefined);
    assert.equal(validateJsonText('{"enabled":true}', true), undefined);
    assert.equal(validateJsonText('{"enabled":', true), "请输入有效 JSON");
  });
});
