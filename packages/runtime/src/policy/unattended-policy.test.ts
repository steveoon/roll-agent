import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigurableToolPolicy } from "./configurable-policy.ts";
import {
  UNATTENDED_CONFIRMATION_DENIED_REASON,
  UnattendedToolPolicy,
} from "./unattended-policy.ts";
import type { ToolPolicyContext } from "../types/policy.ts";

function context(toolName: string, extra: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return { agentName: "browser-use-agent", toolName, input: {}, ...extra };
}

test("UnattendedToolPolicy 把 confirm 转成 deny 并记录", () => {
  const policy = new UnattendedToolPolicy(new ConfigurableToolPolicy({ defaultMode: "auto" }));
  const decision = policy.check(
    context("browser_click", { annotations: { destructiveHint: true } }),
  );
  assert.equal(decision.action, "deny");
  assert.equal(decision.reason, UNATTENDED_CONFIRMATION_DENIED_REASON);
  assert.deepEqual(policy.deniedConfirmations, [
    { agentName: "browser-use-agent", toolName: "browser_click", reason: "破坏性操作" },
  ]);
});

test("UnattendedToolPolicy 透传 allow 与 deny", () => {
  const policy = new UnattendedToolPolicy(
    new ConfigurableToolPolicy({
      defaultMode: "auto",
      overrides: { "browser-use-agent.browser_status": "deny" },
    }),
  );
  assert.equal(policy.check(context("browser_read")).action, "allow");
  assert.equal(policy.check(context("browser_status")).action, "deny");
  assert.equal(policy.check(context("browser_status")).reason, "配置拒绝执行");
  assert.deepEqual(policy.deniedConfirmations, []);
});

test("deniedConfirmations 返回副本", () => {
  const policy = new UnattendedToolPolicy(new ConfigurableToolPolicy({ defaultMode: "guarded" }));
  policy.check(context("send_message"));
  const first = policy.deniedConfirmations;
  policy.check(context("delete_item"));
  assert.equal(first.length, 1);
  assert.equal(policy.deniedConfirmations.length, 2);
});
