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

const ingestionTool: AgentTool = {
  name: "sync_config",
  description: "Sync structured config",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "配置名称",
      },
      metadata: {
        type: "object",
        description: "开放对象配置，需显式提供 JSON",
      },
    },
    required: ["name", "metadata"],
    additionalProperties: false,
  },
};

const nestedTargetTool: AgentTool = {
  name: "generate_reply",
  description: "Generate reply for boss recruiter",
  inputSchema: {
    type: "object",
    properties: {
      field: {
        type: "string",
        description: "候选人的原始消息",
      },
      target: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            description: "目标平台",
          },
          recruiterUsername: {
            type: "string",
            description: "招聘者用户名",
          },
        },
        required: ["platform", "recruiterUsername"],
      },
    },
    required: ["field", "target"],
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
      runtimeIssues: [],
    });
  });

  it("flags required open-ended object fields as requiring explicit input", () => {
    const issues = getInputValidationIssues(ingestionTool, {
      name: "demo",
    });
    assert.deepEqual(issues, [
      {
        path: "metadata",
        code: "requires_explicit_input",
        message: "metadata 无法从自然语言可靠提取，需要显式提供",
        description: "开放对象配置，需显式提供 JSON",
      },
    ]);
  });

  it("expands missing nested object inputs into leaf required fields in one pass", () => {
    const issues = getInputValidationIssues(nestedTargetTool, {});
    assert.deepEqual(issues, [
      {
        path: "field",
        code: "missing_required",
        message: "field 为必填字段",
        description: "候选人的原始消息",
      },
      {
        path: "target.platform",
        code: "missing_required",
        message: "target.platform 为必填字段",
        description: "目标平台",
      },
      {
        path: "target.recruiterUsername",
        code: "missing_required",
        message: "target.recruiterUsername 为必填字段",
        description: "招聘者用户名",
      },
    ]);
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
    assert.match(message, /A\. 输入缺失 \/ 参数校验/);
    assert.match(message, /candidateMessage 为必填字段/);
  });

  it("formats explicit-input guidance separately from missing required fields", () => {
    const message = formatValidationIssuesMessage("smart-reply-agent", "sync_config", [
      {
        path: "candidateMessage",
        code: "missing_required",
        message: "candidateMessage 为必填字段",
        description: "候选人的原始消息",
      },
      {
        path: "metadata",
        code: "requires_explicit_input",
        message: "metadata 无法从自然语言可靠提取，需要显式提供",
        description: "开放对象配置，需显式提供 JSON",
      },
    ]);

    assert.match(message, /A\. 输入缺失 \/ 参数校验/);
    assert.match(message, /candidateMessage 为必填字段/);
    assert.match(message, /metadata 无法从自然语言可靠提取/);
    assert.match(message, /--input-json/);
  });

  it("formats runtime requirements in a separate section", () => {
    const message = formatValidationIssuesMessage(
      "smart-reply-agent",
      "generate_reply",
      [
        {
          path: "candidateMessage",
          code: "missing_required",
          message: "candidateMessage 为必填字段",
          description: "候选人的原始消息",
        },
      ],
      [
        {
          category: "env",
          code: "missing_required_env",
          name: "REPLY_AUTHORITY_BEARER_TOKEN",
          message: "必填环境变量 REPLY_AUTHORITY_BEARER_TOKEN 未配置",
          purpose: "Reply Authority bearer token",
        },
      ],
    );

    assert.match(message, /A\. 输入缺失 \/ 参数校验/);
    assert.match(message, /B\. 运行条件缺失/);
    assert.match(message, /REPLY_AUTHORITY_BEARER_TOKEN/);
    assert.match(message, /agents\.env\.smart-reply-agent/);
  });

  it("returns runtime issues alongside input validation failures", () => {
    const result = preflightToolCall(
      generateReplyTool,
      {},
      {
        runtimeIssues: [
          {
            category: "env",
            code: "missing_required_env",
            name: "REPLY_AUTHORITY_BEARER_TOKEN",
            message: "必填环境变量 REPLY_AUTHORITY_BEARER_TOKEN 未配置",
            purpose: "Reply Authority bearer token",
          },
        ],
      },
    );

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
      runtimeIssues: [
        {
          category: "env",
          code: "missing_required_env",
          name: "REPLY_AUTHORITY_BEARER_TOKEN",
          message: "必填环境变量 REPLY_AUTHORITY_BEARER_TOKEN 未配置",
          purpose: "Reply Authority bearer token",
        },
      ],
    });
  });
});
