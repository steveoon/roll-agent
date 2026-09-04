import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionApprovalMemory } from "../approval/approval-memory.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  buildAgentToolset,
  gateToolCall,
  type ApprovalRequest,
  type ToolBridgeContext,
} from "./build-tools.ts";

function confirmPolicyCtx(
  memory: SessionApprovalMemory | undefined,
  decisions: Array<{ approved: boolean; scope?: "once" | "session" }>,
) {
  const approvals: ApprovalRequest[] = [];
  const ctx: ToolBridgeContext = {
    policy: { check: () => ({ action: "confirm", reason: "测试" }) },
    requestApproval: (request) => {
      approvals.push(request);
      const next = decisions.shift();
      return Promise.resolve(next ?? { approved: false });
    },
    ...(memory ? { approvalMemory: memory } : {}),
  };
  return { ctx, approvals };
}

test("记忆命中时跳过 requestApproval", async () => {
  const memory = new SessionApprovalMemory();
  memory.grant("edit_file:workdir");
  const { ctx, approvals } = confirmPolicyCtx(memory, []);
  const result = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(result, undefined);
  assert.equal(approvals.length, 0);
});

test("scope=session 的批准写入记忆，后续调用免确认", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx, approvals } = confirmPolicyCtx(memory, [{ approved: true, scope: "session" }]);
  const first = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(first, undefined);
  assert.equal(approvals.length, 1);
  const second = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(second, undefined);
  assert.equal(approvals.length, 1);
});

test("scope 缺省的批准不写记忆，下次仍确认", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx, approvals } = confirmPolicyCtx(memory, [{ approved: true }, { approved: true }]);
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  assert.equal(approvals.length, 2);
});

test("无 memoryKey 或无 memory 时行为与既有一致", async () => {
  const { ctx, approvals } = confirmPolicyCtx(undefined, [{ approved: true, scope: "session" }]);
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {});
  assert.equal(approvals.length, 1);
});

test("有 memoryKey 且提供 sessionGrantLabel 时写入 ApprovalRequest", async () => {
  const { ctx, approvals } = confirmPolicyCtx(new SessionApprovalMemory(), [
    { approved: true, scope: "session" },
  ]);
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
    sessionGrantLabel: "本会话内不再询问：修改工作目录内的文件",
  });
  assert.equal(approvals[0]?.sessionGrantLabel, "本会话内不再询问：修改工作目录内的文件");
});

test("无 memoryKey 时不带 sessionGrantLabel", async () => {
  const { ctx, approvals } = confirmPolicyCtx(undefined, [{ approved: true }]);
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    sessionGrantLabel: "不应出现",
  });
  assert.equal(approvals[0]?.sessionGrantLabel, undefined);
});

test("拒绝不写记忆", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx } = confirmPolicyCtx(memory, [{ approved: false, scope: "session" }]);
  const result = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  assert.ok(result !== undefined);
  assert.equal(memory.isGranted("k"), false);
});

test("display.diff 原样透传进 ApprovalRequest，缺席时不带 diff 键", async () => {
  const { ctx, approvals } = confirmPolicyCtx(undefined, [{ approved: true }, { approved: true }]);
  const diff = {
    path: "a.txt",
    change: "modify",
    added: 1,
    removed: 1,
    hunks: 1,
    unified: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n",
    truncated: false,
  } as const;
  const gated = await gateToolCall(ctx, "roll", "edit_file", { file_path: "a.txt" }, undefined, {
    explanation: "修改 a.txt：1 处编辑",
    diff,
  });
  assert.equal(gated, undefined);
  assert.deepEqual(approvals[0]?.diff, diff);
  await gateToolCall(ctx, "roll", "edit_file", { file_path: "a.txt" }, undefined, {
    explanation: "无 diff",
  });
  assert.equal(Object.hasOwn(approvals[1] ?? {}, "diff"), false);
});

test("buildAgentToolset inlines local $ref defensively even when a source bypassed normalizeListedTools", () => {
  const { ctx } = confirmPolicyCtx(undefined, []);
  const built = buildAgentToolset(
    [
      {
        agentName: "raw-agent",
        client: { callTool: async () => ({ content: [] }) } as unknown as Client,
        tools: [
          {
            tool: {
              name: "filter",
              inputSchema: {
                type: "object",
                properties: {
                  city: { type: "string" },
                  district: { $ref: "#/properties/city", description: "区" },
                },
              },
            },
            annotations: undefined,
          },
        ],
      },
    ],
    ctx,
  );
  const id = Object.keys(built.tools).find((key) => key.endsWith("filter"));
  assert.ok(id);
  const tool = built.tools[id];
  assert.ok(tool);
  const schema = (
    tool.inputSchema as { readonly jsonSchema: { readonly properties: Record<string, unknown> } }
  ).jsonSchema;
  assert.deepEqual(schema.properties.district, { type: "string", description: "区" });
});
