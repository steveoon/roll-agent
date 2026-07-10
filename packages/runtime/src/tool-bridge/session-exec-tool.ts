import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import type { SessionEvent } from "../types/events.ts";
import type { ToolAnnotations } from "../types/policy.ts";
import {
  CLASSIFICATION_ANNOTATIONS,
  unknownCommandClassifier,
  type CommandClassifier,
} from "../types/command-classification.ts";
import { isWithinWorkdirRoot } from "../bash/workdir.ts";
import { SessionCapError, type SessionManager } from "../bash/session/session-manager.ts";
import { pollUntilDeadline } from "../bash/session/yield-loop.ts";
import type { ManagedSession, SessionPollResult } from "../bash/session/types.ts";
import { gateToolCall } from "./build-tools.ts";
import type { BashToolContext } from "./bash-tool.ts";
import { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";

export const EXEC_AGENT_NAME = "roll";
export const EXEC_COMMAND_NAME = "exec_command";
export const EXEC_POLL_NAME = "exec_poll";
export const EXEC_COMMAND_ID = `${EXEC_AGENT_NAME}__${EXEC_COMMAND_NAME}`;
export const EXEC_POLL_ID = `${EXEC_AGENT_NAME}__${EXEC_POLL_NAME}`;

const INTERRUPT = String.fromCharCode(3);
const MIN_EXEC_YIELD_MS = 250;
const MAX_EXEC_YIELD_MS = 30_000;
const MIN_POLL_YIELD_MS = 5_000;
const MAX_POLL_YIELD_MS = 300_000;
const MAX_SESSION_DELTA_EVENTS = 8_192;
const MAX_DELTA_CHARS_PER_EVENT = 4_096;
const CHARS_PER_TOKEN = 4;

export interface SessionExecSettings {
  readonly workdir: string;
  readonly defaultYieldMs: number;
  readonly maxOutputTokens: number;
}

export interface SessionExecDeps {
  readonly classifier?: CommandClassifier;
}

const execCommandInputSchema = z.object({
  command: z.string().min(1).describe("要在后台会话中执行的 shell 命令（单字符串）"),
  workdir: z
    .string()
    .min(1)
    .optional()
    .describe("工作目录绝对路径，默认 roll chat 当前目录，不要用 cd"),
  yield_time_ms: z
    .number()
    .int()
    .min(MIN_EXEC_YIELD_MS)
    .max(MAX_EXEC_YIELD_MS)
    .optional()
    .describe(
      "本次等待输出的毫秒数（默认 10000，范围 250-30000）；未结束会返回 session_id 供 exec_poll 续查",
    ),
  max_output_tokens: z
    .number()
    .int()
    .min(256)
    .max(50_000)
    .optional()
    .describe("本次返回输出的 token 预算"),
});

const execPollInputSchema = z.object({
  session_id: z.number().int().describe("exec_command 返回的会话 id"),
  chars: z
    .string()
    .default("")
    .describe('留空表示纯轮询进度；"\\u0003"(Ctrl-C) 表示中断该会话；不支持其它交互输入'),
  yield_time_ms: z
    .number()
    .int()
    .min(MIN_POLL_YIELD_MS)
    .max(MAX_POLL_YIELD_MS)
    .optional()
    .describe("空轮询等待的毫秒数（默认 10000，范围 5000-300000）"),
});

export type ExecCommandInput = z.infer<typeof execCommandInputSchema>;
export type ExecPollInput = z.infer<typeof execPollInputSchema>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function makeSessionDeltaHandler(
  ctx: BashToolContext,
  toolCallId: string,
  toolName: string,
): ((stream: "stdout" | "stderr", delta: string) => void) | undefined {
  const emit = ctx.emitEvent;
  if (!emit) {
    return undefined;
  }
  let count = 0;
  return (stream, delta) => {
    if (count >= MAX_SESSION_DELTA_EVENTS) {
      return;
    }
    count += 1;
    const clipped =
      delta.length > MAX_DELTA_CHARS_PER_EVENT ? delta.slice(0, MAX_DELTA_CHARS_PER_EVENT) : delta;
    const event: SessionEvent = {
      type: "tool-output-delta",
      toolCallId,
      agentName: EXEC_AGENT_NAME,
      toolName,
      stream,
      delta: clipped,
    };
    emit(event);
  };
}

async function gateExecCommand(
  ctx: BashToolContext,
  input: Record<string, unknown>,
  annotations: ToolAnnotations,
): Promise<NormalizedToolResult | undefined> {
  if (ctx.policy) {
    return gateToolCall(ctx, EXEC_AGENT_NAME, EXEC_COMMAND_NAME, input, annotations);
  }
  const approval = await ctx.requestApproval({
    agentName: EXEC_AGENT_NAME,
    toolName: EXEC_COMMAND_NAME,
    input,
    reason: "shell 命令需确认",
  });
  if (!approval.approved) {
    return { output: `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`, isError: true };
  }
  return undefined;
}

function formatPollResult(result: SessionPollResult): NormalizedToolResult {
  const header =
    result.kind === "running"
      ? `Session: ${String(result.sessionId)} (running)`
      : `Exit code: ${String(result.exitCode)}`;
  const lines = [header, `Wall time: ${(result.wallTimeMs / 1_000).toFixed(1)} s`];
  if (result.omitted > 0) {
    lines.push(`（省略中间 ${String(result.omitted)} 字符）`);
  }
  const body = result.output.length > 0 ? `\n\n${result.output}` : "";
  return {
    output: lines.join("\n") + body,
    isError: result.kind === "exited" && result.exitCode !== 0,
  };
}

export function buildSessionExecToolset(
  settings: SessionExecSettings,
  manager: SessionManager,
  registry: ToolRegistry,
  ctx: BashToolContext,
  deps: SessionExecDeps = {},
): ToolSet {
  const execCommandId = registry.register(EXEC_AGENT_NAME, EXEC_COMMAND_NAME);
  const execPollId = registry.register(EXEC_AGENT_NAME, EXEC_POLL_NAME);
  const classifier = deps.classifier ?? unknownCommandClassifier;

  return {
    [execCommandId]: tool({
      description:
        "在后台会话中执行一条命令，等待一段时间后返回输出。若命令未结束会返回 session_id，用 exec_poll 续查进度、读取退出码。适合运行时间超过单轮预算的长脚本。命令继承 roll 进程的环境变量。",
      inputSchema: execCommandInputSchema,
      execute: async (
        input: ExecCommandInput,
        options: ToolExecutionOptions<unknown>,
      ): Promise<NormalizedToolResult> => {
        const workdir = resolve(settings.workdir, input.workdir ?? ".");
        if (!existsSync(workdir)) {
          return { output: `工作目录不存在: ${workdir}`, isError: true };
        }
        const yieldMs = clamp(
          input.yield_time_ms ?? settings.defaultYieldMs,
          MIN_EXEC_YIELD_MS,
          MAX_EXEC_YIELD_MS,
        );
        const classification = isWithinWorkdirRoot(settings.workdir, workdir)
          ? classifier.classify(input.command, workdir)
          : "unknown";
        const annotations = CLASSIFICATION_ANNOTATIONS[classification];
        const approvalInput = { command: input.command, workdir, yield_time_ms: yieldMs };
        const blocked = await gateExecCommand(ctx, approvalInput, annotations);
        if (blocked) {
          return blocked;
        }
        const maxChars = (input.max_output_tokens ?? settings.maxOutputTokens) * CHARS_PER_TOKEN;
        const onDelta = makeSessionDeltaHandler(ctx, options.toolCallId, EXEC_COMMAND_NAME);
        let session: ManagedSession;
        try {
          session = manager.spawn({
            command: input.command,
            workdir,
            ...(onDelta ? { onDelta } : {}),
          });
        } catch (error) {
          return {
            output:
              error instanceof SessionCapError ? error.message : `无法启动会话: ${String(error)}`,
            isError: true,
          };
        }
        const result = await pollUntilDeadline(session, performance.now() + yieldMs, maxChars);
        if (result.kind === "exited") {
          manager.delete(session.id);
        }
        return formatPollResult(result);
      },
    }),
    [execPollId]: tool({
      description:
        '轮询或中断一个 exec_command 会话。session_id 为 exec_command 返回的 id；chars 留空表示纯轮询进度，"\\u0003" 表示发送 Ctrl-C 中断。返回最新输出，进程结束时返回退出码。',
      inputSchema: execPollInputSchema,
      execute: async (
        input: ExecPollInput,
        options: ToolExecutionOptions<unknown>,
      ): Promise<NormalizedToolResult> => {
        const session = manager.get(input.session_id);
        if (!session) {
          return { output: `会话 ${String(input.session_id)} 不存在或已结束`, isError: true };
        }
        if (input.chars === INTERRUPT) {
          session.profile.killTree(session.child.pid, "interrupt").catch(() => {});
        } else if (input.chars !== "") {
          return {
            output: "pipe 会话不支持交互输入（仅支持空 chars 轮询或 Ctrl-C \\u0003 中断）",
            isError: true,
          };
        }
        const onDelta = makeSessionDeltaHandler(ctx, options.toolCallId, EXEC_POLL_NAME);
        if (onDelta) {
          session.onDelta = onDelta;
        }
        const yieldMs = clamp(
          input.yield_time_ms ?? Math.max(settings.defaultYieldMs, MIN_POLL_YIELD_MS),
          MIN_POLL_YIELD_MS,
          MAX_POLL_YIELD_MS,
        );
        const maxChars = settings.maxOutputTokens * CHARS_PER_TOKEN;
        const result = await pollUntilDeadline(session, performance.now() + yieldMs, maxChars);
        if (result.kind === "exited") {
          manager.delete(input.session_id);
        }
        return formatPollResult(result);
      },
    }),
  };
}
