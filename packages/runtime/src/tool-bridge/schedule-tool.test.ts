import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateReadableStream, type ToolExecutionOptions } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentSession } from "../engine/agent-session.ts";
import { DefaultToolPolicy } from "../policy/default-policy.ts";
import type { SessionEvent } from "../types/events.ts";
import type {
  ScheduleCreateAdmission,
  ScheduleExecutionReadiness,
  ScheduleToolPort,
} from "@roll-agent/core/scheduler-host/schedule-tool-binding";
import { ToolRegistry } from "./naming.ts";
import type { ToolBridgeContext } from "./build-tools.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";
import type { PolicyDecision, ToolPolicy } from "../types/policy.ts";
import {
  SCHEDULE_CREATE_TOOL_ID,
  SCHEDULE_LIST_TOOL_ID,
  buildScheduleToolset,
} from "./schedule-tool.ts";

const EXEC_OPTIONS = { toolCallId: "t1", messages: [] } as unknown as ToolExecutionOptions<unknown>;
const SESSION_CWD = "/workspace/demo";

const READY: ScheduleExecutionReadiness = {
  daemonRunning: false,
  serviceInstalled: false,
  automaticRunsReady: false,
  warnings: [
    {
      code: "service-not-installed",
      message: "尚未安装调度服务且 daemon 未运行：任务已登记但不会自动执行",
    },
  ],
};

function admissionFixture(): ScheduleCreateAdmission {
  return {
    ok: true,
    name: "未读巡检",
    prompt: "检查未读消息并汇总",
    cwd: SESSION_CWD,
    sessionCwd: SESSION_CWD,
    everyMs: 1_800_000,
    everyDisplay: "每 30 分钟",
    maxRunMs: undefined,
    maxRunDisplay: "1 小时",
    dataDir: "/tmp/sched-data",
    authorityDigest: "v1:abc",
    firstRunAt: "2026-08-31T10:00:00.000Z",
    readiness: READY,
  };
}

function fixedPolicy(decision: PolicyDecision): ToolPolicy {
  return { check: () => decision };
}

interface Harness {
  readonly captureCalls: unknown[];
  readonly createCalls: ScheduleCreateAdmission[];
  readonly listCalls: unknown[];
  readonly approvalRequests: Array<{
    toolName: string;
    explanation: string | undefined;
    input: Record<string, unknown>;
  }>;
  execute(toolId: string, input: unknown): Promise<NormalizedToolResult>;
}

function makeHarness(options: {
  readonly policy?: ToolPolicy;
  readonly approve?: boolean;
  readonly capture?: () => ReturnType<ScheduleToolPort["captureCreate"]>;
  readonly create?: ScheduleToolPort["create"];
  readonly list?: ScheduleToolPort["list"];
}): Harness {
  const captureCalls: unknown[] = [];
  const createCalls: ScheduleCreateAdmission[] = [];
  const listCalls: unknown[] = [];
  const approvalRequests: Array<{
    toolName: string;
    explanation: string | undefined;
    input: Record<string, unknown>;
  }> = [];
  const port: ScheduleToolPort = {
    captureCreate: (request) => {
      captureCalls.push(request);
      return options.capture ? options.capture() : admissionFixture();
    },
    create: async (admission) => {
      createCalls.push(admission);
      if (options.create) {
        return options.create(admission);
      }
      return {
        ok: true,
        created: true,
        reauthorized: false,
        schedule: {
          id: "sched-1",
          name: admission.name,
          prompt: admission.prompt,
          cwd: admission.cwd,
          status: "active",
          trigger: { everyMs: admission.everyMs, display: admission.everyDisplay },
          maxRun: { explicit: false, effectiveMs: 3_600_000, display: "1 小时" },
          nextRunAt: admission.firstRunAt,
          createdAt: "2026-08-31T09:30:00.000Z",
        },
        readiness: READY,
      };
    },
    list: async (query, sessionCwd) => {
      listCalls.push({ query, sessionCwd });
      if (options.list) {
        return options.list(query, sessionCwd);
      }
      return {
        ok: true,
        total: 1,
        offset: 0,
        hasMore: false,
        schedules: [
          {
            id: "sched-1",
            name: "未读巡检",
            status: "active",
            trigger: "每 30 分钟",
            cwd: SESSION_CWD,
            promptExcerpt: "检查未读消息并汇总",
            maxRun: "1 小时",
            nextRunAt: "2026-08-31T10:00:00.000Z",
            lastRunAt: undefined,
            lastError: undefined,
          },
        ],
        readiness: READY,
      };
    },
  };
  const ctx: ToolBridgeContext = {
    ...(options.policy ? { policy: options.policy } : {}),
    requestApproval: async (request) => {
      approvalRequests.push({
        toolName: request.toolName,
        explanation: request.explanation,
        input: request.input,
      });
      return options.approve === false
        ? { approved: false, reason: "用户取消" }
        : { approved: true };
    },
  };
  const toolset = buildScheduleToolset({ port, sessionCwd: SESSION_CWD }, new ToolRegistry(), ctx);
  const flat = { ...toolset.createTools, ...toolset.listTools };
  return {
    captureCalls,
    createCalls,
    listCalls,
    approvalRequests,
    execute: async (toolId, input) => {
      const target = flat[toolId];
      assert.ok(target?.execute, `${toolId} 未注册`);
      return (await target.execute(input, EXEC_OPTIONS)) as NormalizedToolResult;
    },
  };
}

test("schedule 工具注册 create/list 两个 id", () => {
  const registry = new ToolRegistry();
  buildScheduleToolset(
    {
      port: {
        captureCreate: () => admissionFixture(),
        create: async () => ({ ok: false, code: "x", message: "x" }),
        list: async () => ({ ok: false, code: "x", message: "x" }),
      },
      sessionCwd: SESSION_CWD,
    },
    registry,
    { requestApproval: async () => ({ approved: true }) },
  );
  assert.deepEqual(registry.resolve(SCHEDULE_CREATE_TOOL_ID), {
    agentName: "roll",
    toolName: "schedule_create",
  });
  assert.deepEqual(registry.resolve(SCHEDULE_LIST_TOOL_ID), {
    agentName: "roll",
    toolName: "schedule_list",
  });
});

test("includeCreate:false 时只注册 list（无人值守轮次）", () => {
  const registry = new ToolRegistry();
  const toolset = buildScheduleToolset(
    {
      port: {
        captureCreate: () => admissionFixture(),
        create: async () => ({ ok: false, code: "x", message: "x" }),
        list: async () => ({ ok: false, code: "x", message: "x" }),
      },
      sessionCwd: SESSION_CWD,
      includeCreate: false,
    },
    registry,
    { requestApproval: async () => ({ approved: true }) },
  );
  assert.deepEqual(Object.keys(toolset.createTools), []);
  assert.deepEqual(Object.keys(toolset.listTools), [SCHEDULE_LIST_TOOL_ID]);
  assert.equal(registry.resolve(SCHEDULE_CREATE_TOOL_ID), undefined);
});

test("create 在 confirm 策略下展示完整预览并在批准后创建", async () => {
  const harness = makeHarness({
    policy: fixedPolicy({ action: "confirm", reason: "写/发送类操作" }),
    approve: true,
  });
  const result = await harness.execute(SCHEDULE_CREATE_TOOL_ID, {
    name: "未读巡检",
    prompt: "检查未读消息并汇总",
    every: "30m",
  });
  assert.equal(result.isError, false);
  assert.equal(harness.approvalRequests.length, 1);
  const request = harness.approvalRequests[0];
  assert.ok(request);
  assert.match(request.explanation ?? "", /未读巡检/u);
  assert.ok((request.explanation ?? "").length <= 100);
  assert.equal(request.input.name, "未读巡检");
  assert.equal(request.input.every, "每 30 分钟");
  assert.equal(request.input.cwd, SESSION_CWD);
  assert.equal(request.input.maxRun, "1 小时");
  assert.match(String(request.input.firstRunAt), /2026/u);
  assert.match(String(request.input.lifecycle), /持续运行/u);
  assert.match(String(request.input.serviceStatus), /不会自动执行/u);
  assert.equal(harness.createCalls.length, 1);
  assert.equal(harness.createCalls[0]?.authorityDigest, "v1:abc");
  assert.match(String(result.output), /已登记定时任务/u);
  assert.match(String(result.output), /不会自动执行/u);
});

test("create 即使 automaticRunsReady 为 true 也保留 readiness warnings", async () => {
  const harness = makeHarness({
    create: async (admission) => ({
      ok: true,
      created: true,
      reauthorized: false,
      schedule: {
        id: "sched-ready-warning",
        name: admission.name,
        prompt: admission.prompt,
        cwd: admission.cwd,
        status: "active",
        trigger: { everyMs: admission.everyMs, display: admission.everyDisplay },
        maxRun: { explicit: false, effectiveMs: 3_600_000, display: "1 小时" },
        nextRunAt: admission.firstRunAt,
        createdAt: "2026-08-31T09:30:00.000Z",
      },
      readiness: {
        daemonRunning: true,
        serviceInstalled: true,
        automaticRunsReady: true,
        warnings: [
          {
            code: "unresolved-placeholders",
            message: `配置占位符 \${DASHSCOPE_API_KEY} 无法解析`,
          },
        ],
      },
    }),
  });

  const result = await harness.execute(SCHEDULE_CREATE_TOOL_ID, {
    name: "巡检",
    prompt: "检查未读消息",
    every: "30m",
  });

  assert.equal(result.isError, false);
  assert.match(String(result.output), /DASHSCOPE_API_KEY/u);
});

test("create 在 policy deny 时不请求确认也不创建", async () => {
  const harness = makeHarness({ policy: fixedPolicy({ action: "deny", reason: "禁止" }) });
  const result = await harness.execute(SCHEDULE_CREATE_TOOL_ID, {
    name: "x",
    prompt: "y",
    every: "30m",
  });
  assert.equal(result.isError, true);
  assert.equal(harness.approvalRequests.length, 0);
  assert.equal(harness.createCalls.length, 0);
});

test("create 在用户拒绝后不创建", async () => {
  const harness = makeHarness({
    policy: fixedPolicy({ action: "confirm" }),
    approve: false,
  });
  const result = await harness.execute(SCHEDULE_CREATE_TOOL_ID, {
    name: "x",
    prompt: "y",
    every: "30m",
  });
  assert.equal(result.isError, true);
  assert.match(String(result.output), /已取消执行/u);
  assert.equal(harness.createCalls.length, 0);
});

test("create 的 capture 错误直接结构化返回，不触发确认", async () => {
  const harness = makeHarness({
    policy: fixedPolicy({ action: "confirm" }),
    capture: () => ({ ok: false, code: "schedule_trigger_invalid", message: "格式不对" }),
  });
  const result = await harness.execute(SCHEDULE_CREATE_TOOL_ID, {
    name: "x",
    prompt: "y",
    every: "bogus",
  });
  assert.equal(result.isError, true);
  assert.match(String(result.output), /格式不对/u);
  assert.equal(harness.approvalRequests.length, 0);
  assert.equal(harness.createCalls.length, 0);
});

test("create 重复定义时提示已存在而不是失败", async () => {
  const harness = makeHarness({
    policy: fixedPolicy({ action: "confirm" }),
    approve: true,
    create: async (admission) => ({
      ok: true,
      created: false,
      reauthorized: false,
      schedule: {
        id: "sched-1",
        name: admission.name,
        prompt: admission.prompt,
        cwd: admission.cwd,
        status: "active",
        trigger: { everyMs: admission.everyMs, display: admission.everyDisplay },
        maxRun: { explicit: false, effectiveMs: 3_600_000, display: "1 小时" },
        nextRunAt: admission.firstRunAt,
        createdAt: "2026-08-31T09:00:00.000Z",
      },
      readiness: READY,
    }),
  });
  const result = await harness.execute(SCHEDULE_CREATE_TOOL_ID, {
    name: "未读巡检",
    prompt: "检查未读消息并汇总",
    every: "30m",
  });
  assert.equal(result.isError, false);
  assert.match(String(result.output), /已存在相同定义/u);
});

test("create 幂等命中且重新授权时在结果中明示", async () => {
  const harness = makeHarness({
    policy: fixedPolicy({ action: "confirm" }),
    approve: true,
    create: async (admission) => ({
      ok: true,
      created: false,
      reauthorized: true,
      schedule: {
        id: "sched-1",
        name: admission.name,
        prompt: admission.prompt,
        cwd: admission.cwd,
        status: "active",
        trigger: { everyMs: admission.everyMs, display: admission.everyDisplay },
        maxRun: { explicit: false, effectiveMs: 3_600_000, display: "1 小时" },
        nextRunAt: admission.firstRunAt,
        createdAt: "2026-08-31T09:00:00.000Z",
      },
      readiness: READY,
    }),
  });
  const result = await harness.execute(SCHEDULE_CREATE_TOOL_ID, {
    name: "未读巡检",
    prompt: "检查未读消息并汇总",
    every: "30m",
  });
  assert.equal(result.isError, false);
  assert.match(String(result.output), /重新授权/u);
});

test("list 默认放行并输出任务清单", async () => {
  const harness = makeHarness({ policy: fixedPolicy({ action: "allow" }) });
  const result = await harness.execute(SCHEDULE_LIST_TOOL_ID, {});
  assert.equal(result.isError, false);
  assert.match(String(result.output), /未读巡检/u);
  assert.match(String(result.output), /每 30 分钟/u);
  assert.equal(harness.listCalls.length, 1);
});

test("list 尊重 deny override", async () => {
  const harness = makeHarness({ policy: fixedPolicy({ action: "deny", reason: "禁读" }) });
  const result = await harness.execute(SCHEDULE_LIST_TOOL_ID, {});
  assert.equal(result.isError, true);
  assert.equal(harness.listCalls.length, 0);
});

test("list 的账本错误结构化返回", async () => {
  const harness = makeHarness({
    list: async () => ({ ok: false, code: "migration_required", message: "账本需迁移" }),
  });
  const result = await harness.execute(SCHEDULE_LIST_TOOL_ID, {});
  assert.equal(result.isError, true);
  assert.match(String(result.output), /账本需迁移/u);
});

test("AgentSession 集成：create 触发确认，批准后写入并注入 # 定时任务 段", async () => {
  const captured: LanguageModelV4CallOptions[] = [];
  let step = 0;
  const steps: LanguageModelV4StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: SCHEDULE_CREATE_TOOL_ID,
        input: JSON.stringify({ name: "未读巡检", prompt: "检查未读消息并汇总", every: "30m" }),
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
      { type: "text-delta", id: "t", delta: "已创建" },
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

  const createCalls: ScheduleCreateAdmission[] = [];
  const port: ScheduleToolPort = {
    captureCreate: () => admissionFixture(),
    create: async (admission) => {
      createCalls.push(admission);
      return {
        ok: true,
        created: true,
        reauthorized: false,
        schedule: {
          id: "sched-1",
          name: admission.name,
          prompt: admission.prompt,
          cwd: admission.cwd,
          status: "active",
          trigger: { everyMs: admission.everyMs, display: admission.everyDisplay },
          maxRun: { explicit: false, effectiveMs: 3_600_000, display: "1 小时" },
          nextRunAt: admission.firstRunAt,
          createdAt: "2026-08-31T09:30:00.000Z",
        },
        readiness: READY,
      };
    },
    list: async () => ({
      ok: true,
      total: 0,
      offset: 0,
      hasMore: false,
      schedules: [],
      readiness: READY,
    }),
  };

  const session = new AgentSession({
    id: "s-sched",
    model,
    sources: [],
    maxSteps: 5,
    policy: new DefaultToolPolicy(),
    schedules: { port, sessionCwd: SESSION_CWD, includeCreate: true },
  });

  const events: SessionEvent[] = [];
  for await (const event of session.send("帮我每隔 30 分钟检查未读消息")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId);
    }
  }

  const confirmation = events.find((event) => event.type === "confirmation-required");
  assert.equal(confirmation?.type, "confirmation-required");
  assert.equal(confirmation.toolName, "schedule_create");

  const toolResult = events.find((event) => event.type === "tool-result");
  assert.equal(toolResult?.type, "tool-result");
  assert.equal(toolResult.isError, false);
  assert.equal(createCalls.length, 1);

  const system = captured[0]?.prompt.find((message) => message.role === "system");
  assert.ok(system);
  assert.match(system.content, /# 定时任务/u);
  assert.match(system.content, new RegExp(SCHEDULE_CREATE_TOOL_ID, "u"));
  assert.match(system.content, new RegExp(SCHEDULE_LIST_TOOL_ID, "u"));
});
