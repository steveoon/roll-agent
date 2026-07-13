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
  assert.ok(prompt.includes("SKILL_ROOT"));
  assert.ok(prompt.includes("不要再搜索"));
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

test("有 shellToolId 时注入 profile-specific shell hints", () => {
  const prompt = buildChatSystemPrompt({
    shellToolId: "roll__powershell",
    shellHints: [
      "当前 shell 后端是 PowerShell 7；请使用 PowerShell 语法。",
      "过滤和预览输出时优先使用 Select-String、Select-Object -First、Get-Content -TotalCount。",
    ],
  });
  assert.ok(prompt.includes("roll__powershell"));
  assert.ok(prompt.includes("PowerShell 7"));
  assert.ok(prompt.includes("PowerShell 语法"));
  assert.ok(prompt.includes("Select-String"));
  assert.ok(!prompt.includes("grep/head"));
});

test("有 sessionExecToolIds 时改教模型用 exec_command 跑长任务", () => {
  const prompt = buildChatSystemPrompt({
    bashToolId: "roll__bash",
    sessionExecToolIds: {
      command: "roll__exec_command",
      poll: "roll__exec_poll",
      list: "roll__exec_list",
    },
  });
  assert.ok(prompt.includes("roll__exec_command"));
  assert.ok(prompt.includes("roll__exec_poll"));
  assert.ok(prompt.includes("roll__exec_list"));
  assert.ok(prompt.includes("session_id"));
  assert.ok(prompt.includes("一轮因超时"));
  assert.ok(prompt.includes("用户取消会中断本轮触达的会话"));
  assert.ok(!prompt.includes("调大 timeout_ms"));
});

test("agentCount 为 0 且提供 onboarding 信息时注入 Agent 安装段", () => {
  const prompt = buildChatSystemPrompt({
    agentCount: 0,
    agentOnboarding: {
      installToolId: "roll__agent_install",
      catalog: [
        { name: "browser-use", description: "浏览器操控 Agent" },
        { name: "smart-reply", description: "智能回复 Agent" },
      ].map((entry) => ({ shortName: entry.name, description: entry.description })),
    },
  });
  assert.ok(prompt.includes("# Agent 安装"));
  assert.ok(prompt.includes("roll__agent_install"));
  assert.ok(prompt.includes("- browser-use: 浏览器操控 Agent"));
  assert.ok(prompt.includes("绝不在用户未明确同意的情况下自行安装"));
});

test("agentCount 大于 0 时不注入 Agent 安装段", () => {
  const prompt = buildChatSystemPrompt({
    agentCount: 2,
    agentOnboarding: {
      installToolId: "roll__agent_install",
      catalog: [{ shortName: "browser-use", description: "浏览器操控 Agent" }],
    },
  });
  assert.ok(!prompt.includes("# Agent 安装"));
});

test("缺少 onboarding 信息或 catalog 为空时不注入 Agent 安装段", () => {
  assert.ok(!buildChatSystemPrompt({ agentCount: 0 }).includes("# Agent 安装"));
  assert.ok(
    !buildChatSystemPrompt({
      agentCount: 0,
      agentOnboarding: { installToolId: "roll__agent_install", catalog: [] },
    }).includes("# Agent 安装"),
  );
});
