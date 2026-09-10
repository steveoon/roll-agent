import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { describeTrigger } from "../scheduler/trigger.ts";
import type {
  ScheduleExtendAdmission,
  ScheduleToolError,
} from "@roll-agent/core/scheduler-host/schedule-tool-binding";
import { gateToolCall, type ToolBridgeContext } from "./build-tools.ts";
import type { ToolRegistry } from "./naming.ts";
import type { ScheduleToolDeps } from "./schedule-tool.ts";
import {
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  TOOL_OUTCOME_KINDS,
  type NormalizedToolResult,
} from "./normalize-result.ts";
import {
  executeCoordinatedTool,
  TOOL_RESOURCE_ACCESS_MODES,
  type ToolExecutionPlan,
} from "./tool-execution-coordinator.ts";

export const SCHEDULE_EXTEND_TOOL_NAME = "schedule_extend";
export const SCHEDULE_EXTEND_TOOL_ID = `roll__${SCHEDULE_EXTEND_TOOL_NAME}`;

const inputSchema = z.object({
  scheduleId: z.string().min(1).describe("已结束的有限定时任务 ID"),
  rounds: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("追加的自动轮数，不是新总额度"),
  expectedMaxRounds: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("读取任务时的原总额度，重试保持原值"),
  requestId: z
    .string()
    .min(1)
    .max(128)
    .describe("本次逻辑追加的唯一请求 ID；重试必须复用同一个 ID 和参数"),
});

type Capture = ScheduleExtendAdmission | ScheduleToolError;
const unavailable = (): ScheduleToolError => ({
  ok: false,
  code: "schedule_extend_unavailable",
  message: "当前宿主未提供追加轮数能力",
});
function errorResult(error: ScheduleToolError): NormalizedToolResult {
  return failedToolResult(
    error.code === "invalid_input"
      ? TOOL_OUTCOME_KINDS.invalidInput
      : TOOL_OUTCOME_KINDS.toolFailed,
    error.message,
    { raw: error },
  );
}

export function buildScheduleExtendTools(
  deps: ScheduleToolDeps,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register("roll", SCHEDULE_EXTEND_TOOL_NAME);
  const plan: ToolExecutionPlan = {
    captureExecutionState: (input): Capture => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, code: "invalid_input", message: parsed.error.message };
      }
      if (deps.port.captureExtend === undefined || deps.port.extend === undefined) {
        return unavailable();
      }
      return deps.port.captureExtend(parsed.data, deps.sessionCwd);
    },
    prepare: async (_input, state) => {
      const captured = state as Capture;
      if (!captured.ok) return errorResult(captured);
      const { request, schedule } = captured;
      return gateToolCall(
        ctx,
        "roll",
        SCHEDULE_EXTEND_TOOL_NAME,
        {
          scheduleId: request.scheduleId,
          name: schedule.name,
          prompt: schedule.prompt,
          cwd: schedule.cwd,
          every: describeTrigger(schedule.trigger),
          requestId: request.requestId,
          previousMaxRounds: request.expectedMaxRounds,
          newMaxRounds: request.expectedMaxRounds + request.rounds,
          additionalRounds: request.rounds,
          started: schedule.roundsStarted,
          remaining: Math.max(
            0,
            request.expectedMaxRounds + request.rounds - schedule.roundsStarted,
          ),
          authorization: "按当前任务工作目录的权限配置重新授权；下次运行从追加时刻加一个周期开始",
        },
        undefined,
        { explanation: `为定时任务「${schedule.name}」追加 ${String(request.rounds)} 轮` },
      );
    },
    resources: () => [{ key: "schedule-ledger", mode: TOOL_RESOURCE_ACCESS_MODES.write }],
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        "给已结束且所有运行已结算的有限任务追加自动轮数，保留任务 ID 和历史并重新授权。自带确认，不要重复口头询问。同一逻辑请求重试复用 requestId、expectedMaxRounds、rounds，避免重复增加额度。",
      inputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: async (
        input,
        options: ToolExecutionOptions<unknown>,
      ): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          async (state) => {
            const admission = state as Capture;
            if (!admission.ok) return errorResult(admission);
            if (deps.port.extend === undefined) return errorResult(unavailable());
            const outcome = await deps.port.extend(admission);
            if (!outcome.ok) return errorResult(outcome);
            const warnings = outcome.readiness.warnings
              .map((warning) => warning.message)
              .join("；");
            const next =
              outcome.schedule.nextRunAt === undefined
                ? ""
                : `下次运行 ${outcome.schedule.nextRunAt}。`;
            return successfulToolResult(
              `${outcome.extended ? "已追加轮数" : "该请求已处理，未重复追加"}：${outcome.schedule.name}，${outcome.schedule.roundsDisplay}。${next}${warnings.length === 0 ? "" : `注意：${warnings}`}`,
              { raw: outcome },
            );
          },
        ),
    }),
  };
}
