import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import type {
  ScheduleCreateAdmission,
  ScheduleExecutionReadiness,
  ScheduleToolError,
  ScheduleToolPort,
} from "@roll-agent/core/scheduler-host/schedule-tool-binding";
import { buildScheduleExtendTools } from "./schedule-extend-tool.ts";
import { SCHEDULE_STATUSES } from "../scheduler/types.ts";
import { systemTimeZone } from "../scheduler/calendar.ts";
import { computeNextRunAtMs } from "../scheduler/trigger.ts";
import { scheduleCreateInputSchema, toScheduleCreateRequest } from "./schedule-create-input.ts";
import { gateToolCall, type ToolBridgeContext } from "./build-tools.ts";
import type { ToolRegistry } from "./naming.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "./normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "./tool-execution-coordinator.ts";

export const SCHEDULE_TOOL_AGENT_NAME = "roll";
export const SCHEDULE_CREATE_TOOL_NAME = "schedule_create";
export const SCHEDULE_LIST_TOOL_NAME = "schedule_list";
export const SCHEDULE_CREATE_TOOL_ID = `${SCHEDULE_TOOL_AGENT_NAME}__${SCHEDULE_CREATE_TOOL_NAME}`;
export const SCHEDULE_LIST_TOOL_ID = `${SCHEDULE_TOOL_AGENT_NAME}__${SCHEDULE_LIST_TOOL_NAME}`;

export interface ScheduleToolDeps {
  readonly port: ScheduleToolPort;
  readonly sessionCwd: string;
  readonly includeCreate?: boolean;
}

export interface ScheduleToolset {
  readonly createTools: ToolSet;
  readonly extendTools: ToolSet;
  readonly listTools: ToolSet;
}

const scheduleListInputSchema = z.object({
  status: z
    .enum(["all", ...Object.values(SCHEDULE_STATUSES)])
    .optional()
    .describe("按状态过滤，省略时返回全部"),
  offset: z.number().int().min(0).optional().describe("分页偏移，默认 0"),
  limit: z.number().int().min(1).max(100).optional().describe("最多返回条数，默认 50"),
});

const INVALID_CAPTURE = Symbol("schedule-invalid-input");

interface InvalidCapture {
  readonly kind: typeof INVALID_CAPTURE;
  readonly message: string;
}

type CreateCapture = ScheduleCreateAdmission | ScheduleToolError | InvalidCapture;

function isInvalidCapture(value: unknown): value is InvalidCapture {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as InvalidCapture).kind === INVALID_CAPTURE
  );
}

function isToolError(value: unknown): value is ScheduleToolError {
  return typeof value === "object" && value !== null && (value as ScheduleToolError).ok === false;
}

function toolErrorResult(error: ScheduleToolError): NormalizedToolResult {
  const kind =
    error.code === "invalid_input" ||
    error.code === "schedule_invalid" ||
    error.code === "schedule_trigger_invalid"
      ? TOOL_OUTCOME_KINDS.invalidInput
      : TOOL_OUTCOME_KINDS.toolFailed;
  return failedToolResult(kind, error.message, { raw: error });
}

function renderReadiness(readiness: ScheduleExecutionReadiness): string {
  if (readiness.warnings.length === 0) {
    return "";
  }
  return `\n${readiness.warnings.map((warning) => `注意：${warning.message}。`).join("\n")}`;
}

function buildCreateConfirmationDetails(
  admission: ScheduleCreateAdmission,
): Record<string, unknown> {
  const timeZone =
    admission.trigger.kind === "calendar"
      ? admission.trigger.calendar.timeZone
      : (admission.trigger.timeZone ?? systemTimeZone());
  return {
    name: admission.name,
    prompt: admission.prompt,
    every: admission.everyDisplay,
    recurrence: admission.everyDisplay,
    cwd: admission.cwd,
    maxRun: admission.maxRunDisplay,
    firstRunAt: formatLocalTime(admission.firstRunAt, timeZone),
    firstRunAtIso: admission.firstRunAt,
    timeZone,
    ...(admission.maxRounds === 1
      ? {}
      : {
          nextRunAtEstimate: formatLocalTime(
            new Date(
              computeNextRunAtMs(admission.trigger, Date.parse(admission.firstRunAt)),
            ).toISOString(),
            timeZone,
          ),
        }),
    timingSemantics:
      admission.trigger.kind === "interval"
        ? "第二轮时间仅为预计；按每轮实际领取时间加间隔计算，延迟领取时顺延，不固定每天执行"
        : "按保存的时区和日历规则匹配；跳时日期跳过，重复钟点仅执行较早一次",
    rounds:
      admission.maxRounds === undefined
        ? "不限轮数"
        : `最多自动执行 ${String(admission.maxRounds)} 轮`,
    lifecycle:
      admission.maxRounds === undefined
        ? "会持续运行，直到暂停或删除；创建时记录当前权限边界"
        : "达到轮数上限后，最后一轮执行、重试及清场结算完毕自动结束；创建时记录当前权限边界",
    ...(admission.readiness.warnings.length > 0
      ? {
          serviceStatus: admission.readiness.warnings.map((warning) => warning.message).join("；"),
        }
      : {}),
  };
}

function formatLocalTime(iso: string, timeZone = systemTimeZone()): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime())
    ? iso
    : time.toLocaleString("zh-CN", { timeZone, hour12: false });
}

export function buildScheduleToolset(
  deps: ScheduleToolDeps,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ScheduleToolset {
  const includeCreate = deps.includeCreate ?? true;
  const createId = includeCreate
    ? registry.register(SCHEDULE_TOOL_AGENT_NAME, SCHEDULE_CREATE_TOOL_NAME)
    : undefined;
  const listId = registry.register(SCHEDULE_TOOL_AGENT_NAME, SCHEDULE_LIST_TOOL_NAME);

  const capture = (rawInput: unknown): CreateCapture => {
    const parsed = scheduleCreateInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        kind: INVALID_CAPTURE,
        message: `参数校验失败: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}。使用唯一 recurrence 分支；今天/明天某时填写 startAt，缺少两轮间隔先询问用户。缺省字段填写 null。不要原样重试相同参数。`,
      };
    }
    return deps.port.captureCreate(toScheduleCreateRequest(parsed.data), deps.sessionCwd);
  };

  const createPlan: ToolExecutionPlan = {
    captureExecutionState: capture,
    prepare: async (_rawInput, capturedState) => {
      if (isInvalidCapture(capturedState)) {
        return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, capturedState.message);
      }
      if (isToolError(capturedState)) {
        return toolErrorResult(capturedState);
      }
      const admission = capturedState as ScheduleCreateAdmission;
      return gateToolCall(
        ctx,
        SCHEDULE_TOOL_AGENT_NAME,
        SCHEDULE_CREATE_TOOL_NAME,
        buildCreateConfirmationDetails(admission),
        undefined,
        { explanation: `将登记定时任务「${admission.name}」（${admission.everyDisplay}）` },
      );
    },
    resources: () => [{ key: "schedule-ledger", mode: TOOL_RESOURCE_ACCESS_MODES.write }],
  };
  if (createId !== undefined) {
    ctx.coordinator?.register(createId, createPlan);
  }

  const listPlan: ToolExecutionPlan = {
    prepare: async (rawInput) =>
      gateToolCall(
        ctx,
        SCHEDULE_TOOL_AGENT_NAME,
        SCHEDULE_LIST_TOOL_NAME,
        (rawInput ?? {}) as Record<string, unknown>,
        { readOnlyHint: true },
      ),
    resources: () => [{ key: "schedule-ledger", mode: TOOL_RESOURCE_ACCESS_MODES.read }],
  };
  ctx.coordinator?.register(listId, listPlan);

  const createTools: ToolSet =
    createId === undefined
      ? {}
      : {
          [createId]: tool({
            description:
              "登记定时任务，每轮无人值守 chat 执行 prompt。startAt=开始时间，recurrence=重复规则，rounds=总轮数，三个维度独立。今天/明天某时不是 daily；缺少两轮间隔先澄清，不能猜成每天一次。信息齐全后只做工具自带的完整参数确认，不重复口头确认。可选值用 null 表示缺省。不支持 cron 或每天开启一组多轮循环。",
            inputSchema: scheduleCreateInputSchema,
            strict: true,
            toModelOutput: ({ output }) => toolResultToModelOutput(output),
            execute: async (
              input,
              options: ToolExecutionOptions<unknown>,
            ): Promise<NormalizedToolResult> =>
              executeCoordinatedTool(
                ctx.coordinator,
                createPlan,
                createId,
                options.toolCallId,
                input,
                options.abortSignal,
                async (capturedState) => {
                  if (isInvalidCapture(capturedState)) {
                    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, capturedState.message);
                  }
                  if (isToolError(capturedState)) {
                    return toolErrorResult(capturedState);
                  }
                  const admission = capturedState as ScheduleCreateAdmission;
                  const outcome = await deps.port.create(admission);
                  if (isToolError(outcome)) {
                    return toolErrorResult(outcome);
                  }
                  const schedule = outcome.schedule;
                  const timeZone =
                    schedule.trigger.spec?.kind === "calendar"
                      ? schedule.trigger.spec.calendar.timeZone
                      : (schedule.trigger.spec?.timeZone ?? systemTimeZone());
                  const header = outcome.created
                    ? `已登记定时任务 "${schedule.name}"（${schedule.trigger.display}，单次上限 ${schedule.maxRun.display}）。`
                    : outcome.reauthorized
                      ? `已存在相同定义的任务 "${schedule.name}"（id ${schedule.id}），未重复创建；已按当前权限边界重新授权。`
                      : `已存在相同定义的任务 "${schedule.name}"（id ${schedule.id}），未重复创建。`;
                  const nextNote =
                    schedule.nextRunAt === undefined
                      ? ""
                      : `下次运行约 ${formatLocalTime(schedule.nextRunAt, timeZone)}（${timeZone}）。`;
                  const readinessNote =
                    renderReadiness(outcome.readiness) ||
                    (outcome.readiness.automaticRunsReady
                      ? ""
                      : "\n注意：调度服务未就绪，任务不会自动执行。");
                  return successfulToolResult(
                    `${header}${schedule.rounds.max === null ? "" : `最多自动执行 ${String(schedule.rounds.max)} 轮。`}${schedule.roundsDisplay}。${nextNote}${readinessNote}`,
                    {
                      raw: outcome,
                    },
                  );
                },
              ),
          }),
        };

  const listTools: ToolSet = {
    [listId]: tool({
      description:
        "列出当前配置下已登记的定时任务（含状态、频率、下次运行时间与最近错误摘要）。创建前可用它确认是否已有同类任务。",
      inputSchema: scheduleListInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: async (
        input,
        options: ToolExecutionOptions<unknown>,
      ): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          listPlan,
          listId,
          options.toolCallId,
          input,
          options.abortSignal,
          async () => {
            const parsed = scheduleListInputSchema.safeParse(input ?? {});
            if (!parsed.success) {
              return failedToolResult(
                TOOL_OUTCOME_KINDS.invalidInput,
                `参数校验失败: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
              );
            }
            const outcome = await deps.port.list(parsed.data, deps.sessionCwd);
            if (isToolError(outcome)) {
              return toolErrorResult(outcome);
            }
            if (outcome.total === 0) {
              return successfulToolResult(
                `暂无定时任务。${renderReadiness(outcome.readiness)}`.trim(),
                { raw: outcome },
              );
            }
            const rows = outcome.schedules.map((item) => {
              const nextNote =
                item.status === "active" && item.nextRunAt !== undefined
                  ? `，下次 ${formatLocalTime(item.nextRunAt, item.timeZone)}（${item.timeZone ?? systemTimeZone()}）`
                  : "";
              const errorNote = item.lastError === undefined ? "" : `，最近错误：${item.lastError}`;
              return `- ${item.name}（${item.status}，${item.trigger}，${item.roundsDisplay}${nextNote}）id=${item.id}\n  内容：${item.promptExcerpt}${errorNote}`;
            });
            const pagingNote = outcome.hasMore
              ? `\n共 ${String(outcome.total)} 个，仅显示 ${String(outcome.schedules.length)} 个；用 offset/limit 翻页。`
              : "";
            return successfulToolResult(
              `${rows.join("\n")}${pagingNote}${renderReadiness(outcome.readiness)}`,
              { raw: outcome },
            );
          },
        ),
    }),
  };
  const extendTools = includeCreate ? buildScheduleExtendTools(deps, registry, ctx) : {};
  return { createTools, extendTools, listTools };
}
