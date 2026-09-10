import assert from "node:assert/strict";
import test from "node:test";
import { simulateReadableStream, type ToolExecutionOptions } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  ScheduleExtendAdmission,
  ScheduleToolPort,
} from "@roll-agent/core/scheduler-host/schedule-tool-binding";
import { AgentSession } from "../engine/agent-session.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import { buildChatSystemPromptFromManifest } from "../engine/system-prompt.ts";
import { CAPABILITY_TOOL_ROLES } from "../engine/capability-manifest.ts";
import { ToolRegistry } from "./naming.ts";
import { buildScheduleToolset } from "./schedule-tool.ts";
import { SCHEDULE_EXTEND_TOOL_ID } from "./schedule-extend-tool.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

const request = { scheduleId: "task", rounds: 30, expectedMaxRounds: 20, requestId: "request-one" };
const admission: ScheduleExtendAdmission = {
  ok: true,
  request,
  sessionCwd: "/workspace",
  dataDir: "/tmp/ledger",
  authorityDigest: "v1:test",
  schedule: {
    id: "task",
    name: "巡检",
    prompt: "检查未读消息并回复",
    cwd: "/workspace",
    trigger: { kind: "interval", everyMs: 1_800_000 },
    status: "completed",
    maxRounds: 20,
    roundsStarted: 20,
    authorityDigest: "v1:old",
    maxRunMs: undefined,
    nextRunAtMs: undefined,
    lastRunAtMs: 0,
    lastError: undefined,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
};
const readiness = {
  daemonRunning: true,
  serviceInstalled: true,
  automaticRunsReady: true,
  warnings: [],
};
function portFixture() {
  const calls: ScheduleExtendAdmission[] = [];
  const port: ScheduleToolPort = {
    captureCreate: () => ({ ok: false, code: "test", message: "test" }),
    create: async () => ({ ok: false, code: "test", message: "test" }),
    list: async () => ({ ok: true, total: 0, offset: 0, hasMore: false, schedules: [], readiness }),
    captureExtend: (input) => ({ ...admission, request: { ...input } }),
    extend: async (captured) => {
      calls.push(captured);
      return {
        ok: true,
        extended: true,
        requestId: captured.request.requestId,
        schedule: {
          id: "task",
          name: "巡检",
          prompt: "检查未读消息并回复",
          cwd: "/workspace",
          status: "active",
          rounds: { max: 50, started: 20 },
          roundsDisplay: "已触发 20/50 轮",
          trigger: { everyMs: 1_800_000, display: "每 30 分钟" },
          maxRun: { explicit: false, effectiveMs: 3_600_000, display: "1 小时" },
          nextRunAt: "2026-09-10T10:30:00Z",
          createdAt: "2026-09-10T00:00:00Z",
        },
        readiness,
      };
    },
  };
  return { port, calls };
}

test("extension confirmation includes old/new budget and authorization; denial never writes", async () => {
  for (const approve of [false, true]) {
    const { port, calls } = portFixture();
    const confirmations: Record<string, unknown>[] = [];
    const tools = buildScheduleToolset({ port, sessionCwd: "/workspace" }, new ToolRegistry(), {
      policy: new DefaultToolPolicy(),
      requestApproval: async (preview) => {
        confirmations.push(preview.input);
        return { approved: approve };
      },
    });
    const target = tools.extendTools[SCHEDULE_EXTEND_TOOL_ID];
    assert.ok(target?.execute);
    const output = (await target.execute(request, {
      toolCallId: "e1",
      messages: [],
      context: undefined,
    } satisfies ToolExecutionOptions<unknown>)) as NormalizedToolResult;
    assert.equal(output.isError, !approve);
    assert.equal(calls.length, approve ? 1 : 0);
    assert.equal(confirmations[0]?.previousMaxRounds, 20);
    assert.equal(confirmations[0]?.newMaxRounds, 50);
    assert.equal(confirmations[0]?.started, 20);
    assert.equal(confirmations[0]?.remaining, 30);
    assert.equal(confirmations[0]?.every, "每 30 分钟");
    assert.equal(confirmations[0]?.prompt, admission.schedule.prompt);
    assert.match(String(confirmations[0]?.authorization), /重新授权/u);
    if (approve) assert.match(String(output.output), /20\/50/u);
  }
});

test("extension hides in unattended toolset and legacy ports return unavailable", async () => {
  const { port } = portFixture();
  const hiddenRegistry = new ToolRegistry();
  const hidden = buildScheduleToolset(
    { port, sessionCwd: "/workspace", includeCreate: false },
    hiddenRegistry,
    {
      requestApproval: async () => {
        throw new Error("unexpected confirmation");
      },
    },
  );
  assert.deepEqual(hidden.extendTools, {});
  assert.equal(hiddenRegistry.resolve(SCHEDULE_EXTEND_TOOL_ID), undefined);
  const legacy: ScheduleToolPort = {
    captureCreate: port.captureCreate,
    create: port.create,
    list: port.list,
  };
  const tools = buildScheduleToolset(
    { port: legacy, sessionCwd: "/workspace" },
    new ToolRegistry(),
    {
      requestApproval: async () => {
        throw new Error("unexpected confirmation");
      },
    },
  );
  const target = tools.extendTools[SCHEDULE_EXTEND_TOOL_ID];
  assert.ok(target?.execute);
  const output = (await target.execute(request, {
    toolCallId: "e1",
    messages: [],
    context: undefined,
  } satisfies ToolExecutionOptions<unknown>)) as NormalizedToolResult;
  assert.equal(output.isError, true);
  assert.match(String(output.output), /未提供追加轮数/u);
});

test("AgentSession exposes extension role, schema, prompt and executes the confirmed tool", async () => {
  const { port, calls } = portFixture();
  const captured: LanguageModelV4CallOptions[] = [];
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(options);
      const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (step++ === 0) {
        chunks.push({
          type: "tool-call",
          toolCallId: "extend-one",
          toolName: SCHEDULE_EXTEND_TOOL_ID,
          input: JSON.stringify(request),
        });
      }
      chunks.push({
        type: "finish",
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        finishReason:
          step === 1
            ? { unified: "tool-calls", raw: "tool-calls" }
            : { unified: "stop", raw: "stop" },
      });
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
  const session = new AgentSession({
    id: "extend-session",
    model,
    sources: [],
    maxSteps: 3,
    policy: new DefaultToolPolicy(),
    schedules: { port, sessionCwd: "/workspace", includeCreate: true },
  });
  const manifest = session.getCapabilityManifest();
  const capability = manifest.tools.find((entry) => entry.id === SCHEDULE_EXTEND_TOOL_ID);
  assert.equal(capability?.role, CAPABILITY_TOOL_ROLES.scheduleExtend);
  assert.match(JSON.stringify(capability?.inputSchema), /expectedMaxRounds/u);
  assert.match(buildChatSystemPromptFromManifest(manifest), /重试必须复用原 requestId/u);
  for await (const event of session.send("追加 30 轮")) {
    if (event.type === "confirmation-required") session.approve(event.approvalId);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.request.requestId, "request-one");
  const system = captured[0]?.prompt.find((message) => message.role === "system");
  assert.ok(system);
  assert.match(system.content, /roll__schedule_extend/u);
  const background = new AgentSession({
    id: "background",
    maxSteps: 3,
    model,
    sources: [],
    schedules: { port, sessionCwd: "/workspace", includeCreate: false },
  });
  assert.equal(
    background
      .getCapabilityManifest()
      .tools.some((entry) => entry.role === CAPABILITY_TOOL_ROLES.scheduleExtend),
    false,
  );
});
