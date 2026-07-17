import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "./naming.ts";

test("ToolRegistry 编码并反查路由", () => {
  const registry = new ToolRegistry();
  const id = registry.register("browser-use-agent", "click_ref");
  assert.equal(id, "browser-use-agent__click_ref");
  assert.deepEqual(registry.resolve(id), {
    agentName: "browser-use-agent",
    toolName: "click_ref",
  });
});

test("ToolRegistry sanitize 非法字符且仍可反查", () => {
  const registry = new ToolRegistry();
  const id = registry.register("a.b", "c/d");
  assert.match(id, /^[a-zA-Z0-9_-]+$/);
  assert.deepEqual(registry.resolve(id), { agentName: "a.b", toolName: "c/d" });
});

test("ToolRegistry 命名冲突加后缀且各自反查正确", () => {
  const registry = new ToolRegistry();
  const id1 = registry.register("a__b", "c");
  const id2 = registry.register("a", "b__c");
  assert.equal(id1, "a__b__c");
  assert.equal(id2, "a__b__c_1");
  assert.deepEqual(registry.resolve(id1), { agentName: "a__b", toolName: "c" });
  assert.deepEqual(registry.resolve(id2), { agentName: "a", toolName: "b__c" });
});

test("ToolRegistry resolve 未注册返回 undefined", () => {
  const registry = new ToolRegistry();
  assert.equal(registry.resolve("nope"), undefined);
});

test("ToolRegistry 保留 Agent 来源、transport、runtime lifecycle 与 annotations", () => {
  const registry = new ToolRegistry();
  const annotations = { readOnlyHint: true, destructiveHint: false };
  const id = registry.register("browser", "inspect", {
    agentSource: "installed-package",
    transport: "streamable-http",
    runtimeOwnership: "external-managed",
    annotations,
  });

  assert.deepEqual(registry.resolve(id), {
    agentName: "browser",
    toolName: "inspect",
    agentSource: "installed-package",
    transport: "streamable-http",
    runtimeOwnership: "external-managed",
    annotations,
  });
  assert.notEqual(registry.resolve(id)?.annotations, annotations);
});
