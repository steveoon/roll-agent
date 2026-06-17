import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultToolPolicy } from "./default-policy.ts";

const policy = new DefaultToolPolicy();

test("DefaultToolPolicy 读类放行", () => {
  assert.equal(
    policy.check({ agentName: "a", toolName: "get_messages", input: {} }).action,
    "allow",
  );
  assert.equal(policy.check({ agentName: "a", toolName: "list_chats", input: {} }).action, "allow");
  assert.equal(
    policy.check({ agentName: "a", toolName: "search-jobs", input: {} }).action,
    "allow",
  );
  assert.equal(
    policy.check({ agentName: "a", toolName: "zhipin_read_messages", input: {} }).action,
    "allow",
  );
  assert.equal(
    policy.check({ agentName: "a", toolName: "browser_status", input: {} }).action,
    "allow",
  );
  assert.equal(
    policy.check({ agentName: "a", toolName: "resolve_recruiter_binding", input: {} }).action,
    "allow",
  );
});

test("DefaultToolPolicy 写/发送类确认", () => {
  assert.equal(
    policy.check({ agentName: "a", toolName: "send_message", input: {} }).action,
    "confirm",
  );
  assert.equal(
    policy.check({ agentName: "a", toolName: "delete_item", input: {} }).action,
    "confirm",
  );
  assert.equal(
    policy.check({ agentName: "a", toolName: "click_ref", input: {} }).action,
    "confirm",
  );
  assert.equal(
    policy.check({ agentName: "a", toolName: "zhipin_send_reply", input: {} }).action,
    "confirm",
  );
  assert.equal(
    policy.check({ agentName: "a", toolName: "open_platform", input: {} }).action,
    "confirm",
  );
});

test("DefaultToolPolicy 未知动词默认确认", () => {
  assert.equal(
    policy.check({ agentName: "a", toolName: "frobnicate", input: {} }).action,
    "confirm",
  );
});

test("DefaultToolPolicy 采信 readOnlyHint 放行无写动词工具", () => {
  assert.equal(
    policy.check({
      agentName: "a",
      toolName: "calculate_summary",
      input: {},
      annotations: { readOnlyHint: true },
    }).action,
    "allow",
  );
});

test("DefaultToolPolicy 不允许 readOnlyHint 覆盖明确写动词", () => {
  assert.equal(
    policy.check({
      agentName: "a",
      toolName: "send_message",
      input: {},
      annotations: { readOnlyHint: true },
    }).action,
    "confirm",
  );
});

test("DefaultToolPolicy 采信 destructiveHint 覆盖动词", () => {
  assert.equal(
    policy.check({
      agentName: "a",
      toolName: "get_x",
      input: {},
      annotations: { destructiveHint: true },
    }).action,
    "confirm",
  );
});
