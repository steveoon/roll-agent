import { resolve } from "node:path";
import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import type { SessionEvent } from "../types/events.ts";
import type { ToolAnnotations } from "../types/policy.ts";
import {
  CLASSIFICATION_ANNOTATIONS,
  type CommandClassification,
  type CommandClassifier,
} from "../types/command-classification.ts";
import { runBashCommand } from "../bash/exec.ts";
import { withAutoApprovedShellEnv } from "../bash/clean-env.ts";
import { formatBashResult } from "../bash/format-result.ts";
import type { ShellProfile, ShellToolName } from "../bash/profile.ts";
import { isWithinWorkdirRoot } from "../bash/workdir.ts";
import { gateToolCall, type ToolBridgeContext } from "./build-tools.ts";
import { ToolRegistry } from "./naming.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "./normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "./tool-execution-coordinator.ts";

export const BASH_TOOL_AGENT_NAME = "roll";
export const BASH_TOOL_NAME = "bash";
export const BASH_TOOL_ID = `${BASH_TOOL_AGENT_NAME}__${BASH_TOOL_NAME}`;
export const POWERSHELL_TOOL_NAME = "powershell";
export const POWERSHELL_TOOL_ID = `${BASH_TOOL_AGENT_NAME}__${POWERSHELL_TOOL_NAME}`;

const MAX_DELTA_EVENTS_PER_CALL = 256;
const MAX_DELTA_CHARS_PER_EVENT = 4_096;
const OPAQUE_SHELL_SIDE_EFFECT_RESOURCE = "shell:opaque-side-effects";

export interface SessionBashSettings {
  readonly workdir: string;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly maxModelOutputChars: number;
  readonly profile: ShellProfile;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BashToolContext extends ToolBridgeContext {
  readonly emitEvent?: (event: SessionEvent) => void;
}

export interface BashToolDeps {
  readonly classifier?: CommandClassifier;
  readonly exec?: typeof runBashCommand;
}

function capturedClassification(value: unknown): CommandClassification {
  return value === "known-safe" || value === "dangerous" ? value : "unknown";
}

const bashToolInputSchema = z.object({
  command: z.string().min(1).describe("要执行的 shell 命令（单字符串，由当前 shell 后端执行）"),
  workdir: z
    .string()
    .min(1)
    .optional()
    .describe("工作目录绝对路径，默认为 roll chat 当前目录。不要在 command 里用 cd，改用本字段"),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe(
      "超时毫秒数。默认 10000，上限受 maxTimeoutMs 与 turnTimeoutMs 约束；长脚本请显式调大",
    ),
});

export type BashToolInput = z.infer<typeof bashToolInputSchema>;

function isBashToolInput(value: unknown): value is BashToolInput {
  if (typeof value !== "object" || value === null || !("command" in value)) {
    return false;
  }
  return (
    typeof value.command === "string" &&
    (!("workdir" in value) || value.workdir === undefined || typeof value.workdir === "string") &&
    (!("timeout_ms" in value) ||
      value.timeout_ms === undefined ||
      typeof value.timeout_ms === "number")
  );
}

function makeDeltaHandler(
  ctx: BashToolContext,
  toolCallId: string,
  toolName: ShellToolName,
): ((stream: "stdout" | "stderr", delta: string) => void) | undefined {
  const emit = ctx.emitEvent;
  if (!emit) {
    return undefined;
  }
  let count = 0;
  return (stream, delta) => {
    if (count >= MAX_DELTA_EVENTS_PER_CALL) {
      return;
    }
    count += 1;
    const clipped =
      delta.length > MAX_DELTA_CHARS_PER_EVENT ? delta.slice(0, MAX_DELTA_CHARS_PER_EVENT) : delta;
    emit({
      type: "tool-output-delta",
      toolCallId,
      agentName: BASH_TOOL_AGENT_NAME,
      toolName,
      stream,
      delta: clipped,
    });
  };
}

async function gateBashCall(
  ctx: BashToolContext,
  toolName: ShellToolName,
  input: Record<string, unknown>,
  annotations: ToolAnnotations,
): Promise<NormalizedToolResult | undefined> {
  if (ctx.policy) {
    return gateToolCall(ctx, BASH_TOOL_AGENT_NAME, toolName, input, annotations);
  }
  const approval = await ctx.requestApproval({
    agentName: BASH_TOOL_AGENT_NAME,
    toolName,
    input,
    reason: "shell 命令需确认",
  });
  if (!approval.approved) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.userRejected,
      `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`,
      approval.reason ? { reason: approval.reason } : {},
    );
  }
  return undefined;
}

export function buildBashToolset(
  settings: SessionBashSettings,
  registry: ToolRegistry,
  ctx: BashToolContext,
  deps: BashToolDeps = {},
): ToolSet {
  const toolName = settings.profile.toolName;
  const id = registry.register(BASH_TOOL_AGENT_NAME, toolName);
  const classifier = deps.classifier ?? settings.profile;
  const exec = deps.exec ?? runBashCommand;
  const shellEnv = settings.env ?? process.env;
  const resolveParameters = (input: BashToolInput) => {
    const workdir = resolve(settings.workdir, input.workdir ?? ".");
    const timeoutMs = Math.min(
      input.timeout_ms ?? settings.defaultTimeoutMs,
      settings.maxTimeoutMs,
      settings.turnTimeoutMs,
    );
    return { workdir, timeoutMs };
  };
  const resolveInvocation = (
    input: BashToolInput,
    admittedClassification?: CommandClassification,
  ) => {
    const { workdir, timeoutMs } = resolveParameters(input);
    const classification = isWithinWorkdirRoot(settings.workdir, workdir)
      ? (admittedClassification ?? classifier.classify(input.command, workdir))
      : "unknown";
    return {
      workdir,
      timeoutMs,
      classification,
      annotations: CLASSIFICATION_ANNOTATIONS[classification],
    };
  };
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput, capturedState) => {
      if (!isBashToolInput(rawInput)) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          "参数校验失败: command 必须为字符串",
          { raw: rawInput },
        );
      }
      const invocation = resolveInvocation(rawInput, capturedClassification(capturedState));
      return gateBashCall(
        ctx,
        toolName,
        {
          command: rawInput.command,
          workdir: invocation.workdir,
          timeout_ms: invocation.timeoutMs,
        },
        invocation.annotations,
      );
    },
    resources: (rawInput, capturedState) => {
      if (!isBashToolInput(rawInput)) {
        return [
          { key: OPAQUE_SHELL_SIDE_EFFECT_RESOURCE, mode: TOOL_RESOURCE_ACCESS_MODES.write },
          { key: `shell:${settings.workdir}`, mode: TOOL_RESOURCE_ACCESS_MODES.write },
        ];
      }
      const invocation = resolveInvocation(rawInput, capturedClassification(capturedState));
      const readOnly =
        invocation.annotations.readOnlyHint === true &&
        invocation.annotations.destructiveHint !== true;
      const workdirResource = {
        key: `shell:${invocation.workdir}`,
        mode: readOnly ? TOOL_RESOURCE_ACCESS_MODES.read : TOOL_RESOURCE_ACCESS_MODES.write,
      };
      return readOnly
        ? [workdirResource]
        : [
            { key: OPAQUE_SHELL_SIDE_EFFECT_RESOURCE, mode: TOOL_RESOURCE_ACCESS_MODES.write },
            workdirResource,
          ];
    },
    captureExecutionState: (rawInput) =>
      isBashToolInput(rawInput) ? resolveInvocation(rawInput).classification : "unknown",
    revalidateExecution: (rawInput, capturedState) => {
      if (capturedState !== "known-safe" || !isBashToolInput(rawInput)) {
        return undefined;
      }
      return resolveInvocation(rawInput).classification === "known-safe"
        ? undefined
        : failedToolResult(
            TOOL_OUTCOME_KINDS.toolFailed,
            "shell 命令的安全条件在准入后发生变化，已在执行前阻止；请重新提交以重新确认",
          );
    },
  };
  ctx.coordinator?.register(id, plan);

  return {
    [id]: tool({
      description:
        "在当前 shell 后端中执行一条命令并返回输出。需确认的命令继承 roll 进程环境；自动批准的 known-safe 命令使用隔离的系统 PATH 与 shell 环境。总是用 workdir 参数设置工作目录，不要用 cd。",
      inputSchema: bashToolInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: async (
        input: BashToolInput,
        options: ToolExecutionOptions<unknown>,
      ): Promise<NormalizedToolResult> => {
        const { workdir, timeoutMs } = resolveParameters(input);
        return executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          async (capturedState) => {
            const onDelta = makeDeltaHandler(ctx, options.toolCallId, toolName);
            const result = await exec({
              command: input.command,
              workdir,
              timeoutMs,
              maxCaptureBytes: settings.maxCaptureBytes,
              profile: settings.profile,
              env: capturedState === "known-safe" ? withAutoApprovedShellEnv(shellEnv) : shellEnv,
              ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
              ...(onDelta ? { onDelta } : {}),
            });

            return formatBashResult({
              result,
              maxModelOutputChars: settings.maxModelOutputChars,
            });
          },
        );
      },
    }),
  };
}
