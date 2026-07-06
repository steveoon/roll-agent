import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { SkillLibrary } from "@roll-agent/core/skills/library";
import { AgentSession } from "../engine/agent-session.ts";
import type { SessionEvent } from "../types/events.ts";
import { buildSkillToolset, executeSkillTool, type SkillToolInput } from "./skill-tool.ts";
import { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

function stubLibrary(): SkillLibrary {
  return {
    list: () => [{ name: "demo", description: "演示 skill", source: "user" }],
    load: (name) =>
      name === "demo"
        ? {
            summary: { name: "demo", description: "演示 skill", source: "user" },
            content: "# Demo\n\n按流程操作。",
            referencePaths: ["references/guide.md"],
          }
        : undefined,
    loadReference: (name, referencePath) =>
      name === "demo" && referencePath === "references/guide.md" ? "指南正文" : undefined,
  };
}

function runSkillTool(input: SkillToolInput): NormalizedToolResult {
  return executeSkillTool(stubLibrary(), input);
}

test("skill 工具注册为 roll__skill 且路由到 roll.skill", () => {
  const registry = new ToolRegistry();
  buildSkillToolset(stubLibrary(), registry);
  assert.deepEqual(registry.resolve("roll__skill"), { agentName: "roll", toolName: "skill" });
});

test("加载 skill 返回正文与 references 列表", () => {
  const result = runSkillTool({ name: "demo" });
  assert.equal(result.isError, false);
  assert.ok(String(result.output).includes("按流程操作"));
  assert.ok(String(result.output).includes("references/guide.md"));
});

test("加载 reference 返回文件内容", () => {
  const result = runSkillTool({ name: "demo", reference: "references/guide.md" });
  assert.equal(result.isError, false);
  assert.equal(result.output, "指南正文");
});

test("未知 skill 与未知 reference 返回错误并列出可用项", () => {
  const missing = runSkillTool({ name: "nope" });
  assert.equal(missing.isError, true);
  assert.ok(String(missing.output).includes("demo"));

  const missingRef = runSkillTool({ name: "demo", reference: "references/nope.md" });
  assert.equal(missingRef.isError, true);
});

test("AgentSession 集成：模型调用 roll__skill 并收到 skill 内容", async () => {
  const captured: LanguageModelV4CallOptions[] = [];
  let step = 0;
  const steps: LanguageModelV4StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "roll__skill",
        input: JSON.stringify({ name: "demo" }),
      },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
      },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "已读取" },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        finishReason: { unified: "stop", raw: "stop" },
      },
    ],
  ];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(options);
      const chunks = steps[step] ?? [];
      step += 1;
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });

  const session = new AgentSession({
    id: "s1",
    model,
    sources: [],
    maxSteps: 5,
    skillLibrary: stubLibrary(),
    systemPrompt: "PROMPT-WITH-SKILLS",
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("加载 demo skill")) {
    events.push(event);
  }

  const toolCall = events.find((event) => event.type === "tool-call");
  assert.equal(toolCall?.type, "tool-call");
  assert.equal(toolCall.agentName, "roll");
  assert.equal(toolCall.toolName, "skill");

  const toolResult = events.find((event) => event.type === "tool-result");
  assert.equal(toolResult?.type, "tool-result");
  assert.equal(toolResult.isError, false);
  assert.ok(JSON.stringify(toolResult.output).includes("按流程操作"));

  const system = captured[0]?.prompt.find((message) => message.role === "system");
  assert.ok(system);
  assert.equal(system.content, "PROMPT-WITH-SKILLS");
});
