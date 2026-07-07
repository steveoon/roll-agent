import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatSystemPrompt } from "./system-prompt.ts";

test("buildChatSystemPrompt 无 skills 时不包含 Skills 段", () => {
  const prompt = buildChatSystemPrompt();
  assert.ok(prompt.includes("# 工具使用纪律"));
  assert.ok(prompt.includes("# 任务推进"));
  assert.ok(prompt.includes("# 输出"));
  assert.ok(!prompt.includes("# Skills"));
});

test("buildChatSystemPrompt 包含 skill 目录与工具指引", () => {
  const prompt = buildChatSystemPrompt({
    skills: [
      { name: "web-design", description: "网页设计指南" },
      { name: "long-desc", description: "长".repeat(300) },
    ],
  });
  assert.ok(prompt.includes("# Skills"));
  assert.ok(prompt.includes("- web-design: 网页设计指南"));
  assert.ok(prompt.includes("roll__skill"));
  assert.ok(prompt.includes("…"));
  assert.ok(!prompt.includes("长".repeat(300)));
});

test("buildChatSystemPrompt 支持自定义 skill 工具 id", () => {
  const prompt = buildChatSystemPrompt({
    skills: [{ name: "a", description: "b" }],
    skillToolId: "custom__id",
  });
  assert.ok(prompt.includes("custom__id"));
  assert.ok(!prompt.includes("roll__skill"));
});

test("无 bashToolId 时身份声明没有 shell，也不含 Shell 段", () => {
  const prompt = buildChatSystemPrompt();
  assert.ok(prompt.includes("没有独立的文件系统或 shell"));
  assert.ok(!prompt.includes("# Shell 工具"));
});

test("有 bashToolId 时身份改写并注入 Shell 段", () => {
  const prompt = buildChatSystemPrompt({ bashToolId: "roll__bash" });
  assert.ok(!prompt.includes("没有独立的文件系统或 shell"));
  assert.ok(prompt.includes("内建 shell 工具"));
  assert.ok(prompt.includes("# Shell 工具"));
  assert.ok(prompt.includes("roll__bash"));
  assert.ok(prompt.includes("timeout_ms"));
  assert.ok(!prompt.includes("roll__exec_command"));
});

test("有 sessionExecToolIds 时改教模型用 exec_command 跑长任务", () => {
  const prompt = buildChatSystemPrompt({
    bashToolId: "roll__bash",
    sessionExecToolIds: { command: "roll__exec_command", poll: "roll__exec_poll" },
  });
  assert.ok(prompt.includes("roll__exec_command"));
  assert.ok(prompt.includes("roll__exec_poll"));
  assert.ok(prompt.includes("session_id"));
  assert.ok(!prompt.includes("调大 timeout_ms"));
});
