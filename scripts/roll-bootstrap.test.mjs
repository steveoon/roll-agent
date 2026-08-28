import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCommandName,
  shouldEnableSqliteForCommand,
} from "../packages/core/bin/roll-bootstrap.mjs";

test("Roll bootstrap 为所有会加载 scheduler runtime 的命令启用 node:sqlite", () => {
  for (const command of ["chat", "schedule", "doctor", "update"]) {
    assert.equal(shouldEnableSqliteForCommand(command), true, command);
  }
  for (const command of [undefined, "agent", "config", "ui"]) {
    assert.equal(shouldEnableSqliteForCommand(command), false, command);
  }
});

test("resolveCommandName 跳过全局 flags 并返回首个命令", () => {
  assert.equal(resolveCommandName(["--no-color", "doctor", "--json"]), "doctor");
  assert.equal(resolveCommandName(["update", "--check"]), "update");
  assert.equal(resolveCommandName(["--help"]), undefined);
});
