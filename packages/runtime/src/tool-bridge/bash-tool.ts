import { resolve } from "node:path";
import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import type { SessionEvent } from "../types/events.ts";
import type { ToolAnnotations } from "../types/policy.ts";
import {
  CLASSIFICATION_ANNOTATIONS,
  type CommandClassifier,
} from "../types/command-classification.ts";
import { runBashCommand } from "../bash/exec.ts";
import { formatBashResult } from "../bash/format-result.ts";
import type { ShellProfile, ShellToolName } from "../bash/profile.ts";
import { isWithinWorkdirRoot } from "../bash/workdir.ts";
import { gateToolCall, type ToolBridgeContext } from "./build-tools.ts";
import { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

export const BASH_TOOL_AGENT_NAME = "roll";
export const BASH_TOOL_NAME = "bash";
export const BASH_TOOL_ID = `${BASH_TOOL_AGENT_NAME}__${BASH_TOOL_NAME}`;
export const POWERSHELL_TOOL_NAME = "powershell";
export const POWERSHELL_TOOL_ID = `${BASH_TOOL_AGENT_NAME}__${POWERSHELL_TOOL_NAME}`;

const MAX_DELTA_EVENTS_PER_CALL = 256;
const MAX_DELTA_CHARS_PER_EVENT = 4_096;

export interface SessionBashSettings {
  readonly workdir: string;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly maxModelOutputChars: number;
  readonly profile: ShellProfile;
}

export interface BashToolContext extends ToolBridgeContext {
  readonly emitEvent?: (event: SessionEvent) => void;
}

export interface BashToolDeps {
  readonly classifier?: CommandClassifier;
  readonly exec?: typeof runBashCommand;
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
    return { output: `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`, isError: true };
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

  return {
    [id]: tool({
      description:
        "在当前 shell 后端中执行一条命令并返回输出。命令继承 roll 进程的全部环境变量。总是用 workdir 参数设置工作目录，不要用 cd。",
      inputSchema: bashToolInputSchema,
      execute: async (
        input: BashToolInput,
        options: ToolExecutionOptions<unknown>,
      ): Promise<NormalizedToolResult> => {
        const workdir = resolve(settings.workdir, input.workdir ?? ".");
        const timeoutMs = Math.min(
          input.timeout_ms ?? settings.defaultTimeoutMs,
          settings.maxTimeoutMs,
          settings.turnTimeoutMs,
        );

        const classification = isWithinWorkdirRoot(settings.workdir, workdir)
          ? classifier.classify(input.command, workdir)
          : "unknown";
        const annotations = CLASSIFICATION_ANNOTATIONS[classification];
        const approvalInput = { command: input.command, workdir, timeout_ms: timeoutMs };

        const blocked = await gateBashCall(ctx, toolName, approvalInput, annotations);
        if (blocked) {
          return blocked;
        }

        const onDelta = makeDeltaHandler(ctx, options.toolCallId, toolName);
        const result = await exec({
          command: input.command,
          workdir,
          timeoutMs,
          maxCaptureBytes: settings.maxCaptureBytes,
          profile: settings.profile,
          env: process.env,
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
          ...(onDelta ? { onDelta } : {}),
        });

        return formatBashResult({ result, maxModelOutputChars: settings.maxModelOutputChars });
      },
    }),
  };
}
