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
import { pollUntilDeadline, throwIfSessionExecAborted } from "../bash/session/yield-loop.ts";
import {
  SESSION_STATES,
  type ManagedSession,
  type SessionPollResult,
  type SessionSummary,
} from "../bash/session/types.ts";
import { gateToolCall } from "./build-tools.ts";
import type { BashToolContext } from "./bash-tool.ts";
import { ToolRegistry } from "./naming.ts";
import type { NormalizedToolResult } from "./normalize-result.ts";
import { isUserCancellationSignal } from "../types/cancellation.ts";

export const EXEC_AGENT_NAME = "roll";
export const EXEC_COMMAND_NAME = "exec_command";
export const EXEC_POLL_NAME = "exec_poll";
export const EXEC_LIST_NAME = "exec_list";
export const EXEC_COMMAND_ID = `${EXEC_AGENT_NAME}__${EXEC_COMMAND_NAME}`;
export const EXEC_POLL_ID = `${EXEC_AGENT_NAME}__${EXEC_POLL_NAME}`;
export const EXEC_LIST_ID = `${EXEC_AGENT_NAME}__${EXEC_LIST_NAME}`;

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
  readonly onSessionTouched?: (sessionId: number) => void;
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

const execListInputSchema = z.object({});

export type ExecCommandInput = z.infer<typeof execCommandInputSchema>;
export type ExecPollInput = z.infer<typeof execPollInputSchema>;
export type ExecListInput = z.infer<typeof execListInputSchema>;

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
  if (result.kind === "exited" && result.terminationCause) {
    lines.push(`Termination: ${result.terminationCause}`);
  }
  if (result.kind === "exited" && result.cleanupError) {
    lines.push(`Cleanup error: ${result.cleanupError}`);
  }
  const body = result.output.length > 0 ? `\n\n${result.output}` : "";
  return {
    output: lines.join("\n") + body,
    isError:
      result.kind === "exited" &&
      (result.exitCode !== 0 ||
        result.state === SESSION_STATES.cleanupFailed ||
        result.terminationCause !== undefined),
  };
}

function formatSessionList(sessions: readonly SessionSummary[]): NormalizedToolResult {
  if (sessions.length === 0) {
    return { output: "当前没有可恢复的后台会话", isError: false };
  }
  return {
    output: JSON.stringify(
      {
        sessions: sessions.map((session) => ({
          session_id: session.sessionId,
          state: session.state,
          command: session.commandPreview,
          workdir: session.workdir,
          wall_time_s: Number((session.wallTimeMs / 1_000).toFixed(1)),
          ...(session.exitCode !== undefined ? { exit_code: session.exitCode } : {}),
          ...(session.terminationCause ? { termination_cause: session.terminationCause } : {}),
          ...(session.cleanupError ? { cleanup_error: session.cleanupError } : {}),
        })),
      },
      null,
      2,
    ),
    isError: false,
  };
}

function bindUserCancellation(
  signal: AbortSignal | undefined,
  session: ManagedSession,
  manager: SessionManager,
): () => void {
  if (signal === undefined) {
    return () => {};
  }
  const onAbort = (): void => {
    if (!isUserCancellationSignal(signal) || manager.get(session.id) !== session) {
      return;
    }
    manager.interrupt(session.id).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return () => signal.removeEventListener("abort", onAbort);
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
  const execListId = registry.register(EXEC_AGENT_NAME, EXEC_LIST_NAME);
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
        throwIfSessionExecAborted(options.abortSignal);
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
        throwIfSessionExecAborted(options.abortSignal);
        let session: ManagedSession;
        try {
          session = manager.spawn({
            command: input.command,
            workdir,
            ...(onDelta ? { onDelta } : {}),
          });
          deps.onSessionTouched?.(session.id);
        } catch (error) {
          return {
            output:
              error instanceof SessionCapError ? error.message : `无法启动会话: ${String(error)}`,
            isError: true,
          };
        }
        const unbindCancellation = bindUserCancellation(options.abortSignal, session, manager);
        const result = await pollUntilDeadline(session, performance.now() + yieldMs, maxChars, {
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
          ...(onDelta ? { onDelta } : {}),
        }).finally(unbindCancellation);
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
        throwIfSessionExecAborted(options.abortSignal);
        const session = manager.get(input.session_id);
        if (!session) {
          return { output: `会话 ${String(input.session_id)} 不存在或已结束`, isError: true };
        }
        throwIfSessionExecAborted(options.abortSignal);
        if (input.chars !== "" && input.chars !== INTERRUPT) {
          return {
            output: "pipe 会话不支持交互输入（仅支持空 chars 轮询或 Ctrl-C \\u0003 中断）",
            isError: true,
          };
        }
        deps.onSessionTouched?.(session.id);
        if (input.chars === INTERRUPT) {
          await manager.interrupt(session.id);
        }
        const onDelta = makeSessionDeltaHandler(ctx, options.toolCallId, EXEC_POLL_NAME);
        const yieldMs = clamp(
          input.yield_time_ms ?? Math.max(settings.defaultYieldMs, MIN_POLL_YIELD_MS),
          MIN_POLL_YIELD_MS,
          MAX_POLL_YIELD_MS,
        );
        const maxChars = settings.maxOutputTokens * CHARS_PER_TOKEN;
        const unbindCancellation = bindUserCancellation(options.abortSignal, session, manager);
        const result = await pollUntilDeadline(session, performance.now() + yieldMs, maxChars, {
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
          ...(onDelta ? { onDelta } : {}),
        }).finally(unbindCancellation);
        if (result.kind === "exited") {
          manager.delete(input.session_id);
        }
        return formatPollResult(result);
      },
    }),
    [execListId]: tool({
      description:
        "列出当前 roll chat 进程中的有界近期后台命令会话，包括仍在运行的会话和尚未领取最终结果的已结束会话。用于在轮超时或丢失 session_id 后恢复轮询，不是永久历史。",
      inputSchema: execListInputSchema,
      execute: async (_input: ExecListInput): Promise<NormalizedToolResult> =>
        formatSessionList(manager.list()),
    }),
  };
}
