import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool } from "../types/agent.ts";
import { formatValidationIssuesMessage } from "./messages.ts";
import { getInputValidationIssues, preflightToolCall } from "./preflight.ts";

const generateReplyTool: AgentTool = {
  name: "generate_reply",
  description: "Generate reply for candidate",
  inputSchema: {
    type: "object",
    properties: {
      candidateMessage: {
        type: "string",
        description: "候选人的原始消息",
      },
      conversationHistory: {
        type: "array",
        items: {
          type: "string",
        },
      },
      channel: {
        type: "string",
        enum: ["boss", "wechat"],
      },
    },
    required: ["candidateMessage"],
    additionalProperties: false,
  },
};

describe("tool-runtime preflight", () => {
  it("detects missing required tool inputs", () => {
    const issues = getInputValidationIssues(generateReplyTool, {});
    assert.deepEqual(issues, [
      {
        path: "candidateMessage",
        code: "missing_required",
        message: "candidateMessage 为必填字段",
        description: "候选人的原始消息",
      },
    ]);
  });

  it("does not flag required input when it is present", () => {
    const issues = getInputValidationIssues(generateReplyTool, {
      candidateMessage: "你好，请问还招人吗？",
    });
    assert.deepEqual(issues, []);
  });

  it("detects invalid primitive and enum types", () => {
    const issues = getInputValidationIssues(generateReplyTool, {
      candidateMessage: 123,
      channel: "email",
    });
    assert.deepEqual(issues, [
      {
        path: "candidateMessage",
        code: "invalid_type",
        message: "candidateMessage 应为 string，当前是 number",
        description: "候选人的原始消息",
        expected: "string",
        actual: "number",
      },
      {
        path: "channel",
        code: "invalid_enum",
        message: 'channel 必须是以下值之一："boss"、"wechat"',
        expected: '"boss" | "wechat"',
        actual: '"email"',
      },
    ]);
  });

  it("detects unexpected and nested invalid fields", () => {
    const issues = getInputValidationIssues(generateReplyTool, {
      candidateMessage: "你好",
      conversationHistory: ["ok", 2],
      extraField: true,
    });
    assert.deepEqual(issues, [
      {
        path: "conversationHistory[1]",
        code: "invalid_type",
        message: "conversationHistory[1] 应为 string，当前是 number",
        expected: "string",
        actual: "number",
      },
      {
        path: "extraField",
        code: "unexpected_property",
        message: "extraField 不是允许的参数",
      },
    ]);
  });

  it("returns a structured success result when preflight passes", () => {
    const result = preflightToolCall(generateReplyTool, {
      candidateMessage: "你好，请问还招人吗？",
      channel: "boss",
    });
    assert.deepEqual(result, { ok: true });
  });

  it("returns a structured failure result when preflight fails", () => {
    const result = preflightToolCall(generateReplyTool, {});
    assert.deepEqual(result, {
      ok: false,
      issues: [
        {
          path: "candidateMessage",
          code: "missing_required",
          message: "candidateMessage 为必填字段",
          description: "候选人的原始消息",
        },
      ],
    });
  });

  it("formats a human-readable validation message", () => {
    const message = formatValidationIssuesMessage("smart-reply-agent", "generate_reply", [
      {
        path: "candidateMessage",
        code: "missing_required",
        message: "candidateMessage 为必填字段",
        description: "候选人的原始消息",
      },
    ]);
    assert.match(message, /smart-reply-agent\.generate_reply/);
    assert.match(message, /candidateMessage/);
  });
});
