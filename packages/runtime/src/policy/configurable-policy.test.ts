import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigurableToolPolicy } from "./configurable-policy.ts";
import type { ToolPolicyContext } from "../types/policy.ts";

function context(toolName: string, extra: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    agentName: "browser-use-agent",
    toolName,
    input: {},
    ...extra,
  };
}

test("ConfigurableToolPolicy 精确 confirm 覆盖 auto 默认", () => {
  const policy = new ConfigurableToolPolicy({
    defaultMode: "auto",
    overrides: { "browser-use-agent.browser_status": "confirm" },
  });

  const decision = policy.check(context("browser_status"));

  assert.equal(decision.action, "confirm");
  assert.equal(decision.reason, "配置要求确认");
});

test("ConfigurableToolPolicy 精确 auto 覆盖 guarded 确认", () => {
  const policy = new ConfigurableToolPolicy({
    defaultMode: "guarded",
    overrides: { "browser-use-agent.zhipin_send_prepared_reply": "auto" },
  });

  assert.equal(policy.check(context("zhipin_send_prepared_reply")).action, "allow");
});

test("ConfigurableToolPolicy 精确 deny 直接拒绝", () => {
  const policy = new ConfigurableToolPolicy({
    overrides: { "browser-use-agent.browser_status": "deny" },
  });

  const decision = policy.check(context("browser_status"));

  assert.equal(decision.action, "deny");
  assert.equal(decision.reason, "配置拒绝执行");
});

test("ConfigurableToolPolicy 未命中 override 时保持 guarded heuristic", () => {
  const policy = new ConfigurableToolPolicy({
    defaultMode: "guarded",
    overrides: { "browser-use-agent.browser_status": "confirm" },
  });

  assert.equal(policy.check(context("zhipin_send_prepared_reply")).action, "confirm");
  assert.equal(
    policy.check(context("browser_status", { agentName: "other-agent" })).action,
    "allow",
  );
});

test("ConfigurableToolPolicy auto 默认仍确认 destructiveHint", () => {
  const policy = new ConfigurableToolPolicy({ defaultMode: "auto" });

  assert.equal(
    policy.check(context("browser_status", { annotations: { destructiveHint: true } })).action,
    "confirm",
  );
});

test("ConfigurableToolPolicy 精确 auto 可覆盖 destructiveHint", () => {
  const policy = new ConfigurableToolPolicy({
    defaultMode: "guarded",
    overrides: { "browser-use-agent.browser_status": "auto" },
  });

  assert.equal(
    policy.check(context("browser_status", { annotations: { destructiveHint: true } })).action,
    "allow",
  );
});
