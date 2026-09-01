import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import type {
  ScheduleCreateAdmission,
  ScheduleExecutionReadiness,
  ScheduleToolError,
  ScheduleToolPort,
} from "@roll-agent/core/scheduler-host/schedule-tool-binding";
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
  readonly listTools: ToolSet;
}

const scheduleCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120).describe("任务名称（确认界面与任务列表中展示）"),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("每次触发时交给新一轮 chat 的任务描述，写清要做什么"),
  every: z
    .string()
    .trim()
    .min(1)
    .describe("触发间隔，格式 <数字><s|m|h|d>，如 30m、2h、1d（最短 60s，最长 365d）"),
  cwd: z
    .string()
    .optional()
    .describe("任务运行的工作目录；省略时使用当前会话工作目录，相对路径相对会话目录解析"),
  maxRun: z
    .string()
    .optional()
    .describe("单次运行时长上限，格式同 every（60s..24h；省略时默认 1 小时）"),
});

const scheduleListInputSchema = z.object({
  status: z.enum(["all", "active", "paused"]).optional().describe("按状态过滤，省略时返回全部"),
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
  return {
    name: admission.name,
    prompt: admission.prompt,
    every: admission.everyDisplay,
    cwd: admission.cwd,
    maxRun: admission.maxRunDisplay,
    firstRunAt: formatLocalTime(admission.firstRunAt),
    lifecycle: "会持续运行，直到暂停或删除；创建时记录当前权限边界",
    ...(admission.readiness.warnings.length > 0
      ? {
          serviceStatus: admission.readiness.warnings.map((warning) => warning.message).join("；"),
        }
      : {}),
  };
}

function formatLocalTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString();
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
        message: `参数校验失败: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }
    return deps.port.captureCreate(parsed.data, deps.sessionCwd);
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
              "登记一个按固定间隔重复运行的定时任务：到点后由 roll 调度器发起新一轮无人值守 chat 执行 prompt。创建前会向用户展示完整参数并请求确认，不要在调用前重复询问。仅支持固定间隔（every），不支持一次性时间点、cron 表达式或时区。",
            inputSchema: scheduleCreateInputSchema,
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
                  const header = outcome.created
                    ? `已登记定时任务 "${schedule.name}"（${schedule.trigger.display}，单次上限 ${schedule.maxRun.display}）。`
                    : outcome.reauthorized
                      ? `已存在相同定义的任务 "${schedule.name}"（id ${schedule.id}），未重复创建；已按当前权限边界重新授权。`
                      : `已存在相同定义的任务 "${schedule.name}"（id ${schedule.id}），未重复创建。`;
                  const nextNote =
                    schedule.nextRunAt === undefined
                      ? ""
                      : `下次运行约 ${formatLocalTime(schedule.nextRunAt)}。`;
                  const readinessNote =
                    renderReadiness(outcome.readiness) ||
                    (outcome.readiness.automaticRunsReady
                      ? ""
                      : "\n注意：调度服务未就绪，任务不会自动执行。");
                  return successfulToolResult(`${header}${nextNote}${readinessNote}`, {
                    raw: outcome,
                  });
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
                  ? `，下次 ${formatLocalTime(item.nextRunAt)}`
                  : "";
              const errorNote = item.lastError === undefined ? "" : `，最近错误：${item.lastError}`;
              return `- ${item.name}（${item.status}，${item.trigger}${nextNote}）id=${item.id}\n  内容：${item.promptExcerpt}${errorNote}`;
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
  return { createTools, listTools };
}
