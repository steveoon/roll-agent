import { existsSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ModelMessage } from "ai";
import type {
  ScheduleRunHistoryEntry,
  ScheduleThreadReference,
  ThreadSnapshot,
} from "@roll-agent/runtime";
import type { RollConfig } from "../config/schema.ts";
import { loadConfig } from "../config/loader.ts";
import { log } from "../cli/utils/output.ts";
import type {
  RuntimeModule,
  ConversationEngineInstance,
  ThreadStoreInstance,
} from "../runtime-host/engine-factory.ts";
import {
  STATUS_UNAVAILABLE_REASONS,
  type ScheduleBrowserPort,
  type ScheduleRunDetail,
} from "../cli/chat/schedule-browser.ts";

function display(text: string): string {
  return stripVTControlCharacters(text).replaceAll("\r", "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseScheduleAttempt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const attempt = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("--attempt 必须是正整数");
  }
  return attempt;
}

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!/^\d+$/u.test(cursor) || !Number.isSafeInteger(offset)) {
    throw new Error("无效的运行分页位置");
  }
  return offset;
}

function requireReadable(status: string): void {
  if (status === "migration-required") {
    throw new Error("定时任务账本版本需要迁移，请先运行 roll schedule list");
  }
}

interface HistoryInput {
  readonly config: RollConfig;
  readonly runtime: RuntimeModule;
  readonly engine?: ConversationEngineInstance;
  readonly cwd?: string;
}

function loadRun(input: HistoryInput, invocationId: string): ScheduleRunHistoryEntry {
  const result = input.runtime.readScheduleRun(input.config.scheduler.dataDir, invocationId);
  requireReadable(result.status);
  if (result.run === undefined) throw new Error(`运行 ${invocationId} 不存在或没有保留记录`);
  return result.run;
}

function originFor(input: HistoryInput, ref: ScheduleThreadReference) {
  return {
    kind: "scheduled" as const,
    scheduleId: ref.scheduleId,
    invocationId: ref.invocationId,
    attempt: ref.attempt,
    name: ref.name,
    cwd: ref.cwd,
    scheduledFor: new Date(ref.scheduledForMs).toISOString(),
    ledgerDir: resolve(input.runtime.expandTilde(input.config.scheduler.dataDir)),
  };
}

function knownThreadDirs(input: HistoryInput, cwd: string | undefined): readonly string[] {
  const dirs = [
    resolve(input.cwd ?? process.cwd(), input.runtime.expandTilde(input.config.runtime.threadsDir)),
  ];
  if (cwd !== undefined && existsSync(cwd)) {
    try {
      dirs.push(
        resolve(cwd, input.runtime.expandTilde(loadConfig({ cwd }).config.runtime.threadsDir)),
      );
    } catch {
      /* Current store remains a verified candidate. */
    }
  }
  return [...new Set(dirs)];
}

/** Only uses an exact ledger thread ID, in configured stores; never guesses from titles. */
function legacyReference(
  input: HistoryInput,
  run: ScheduleRunHistoryEntry,
): ScheduleThreadReference | undefined {
  const invocation = run.invocation;
  if (invocation?.threadId === undefined) return undefined;
  const history = input.runtime.readScheduleHistory(input.config.scheduler.dataDir);
  requireReadable(history.status);
  const task = history.tasks.find((item) => item.scheduleId === run.scheduleId);
  if (task === undefined) return undefined;
  for (const dir of knownThreadDirs(input, task.cwd)) {
    if (!existsSync(join(dir, "threads.db"))) continue;
    let source: ThreadStoreInstance | undefined;
    try {
      source = new input.runtime.ThreadStore(dir, { readOnly: true });
      if (!source.hasThread(invocation.threadId)) continue;
      return {
        invocationId: run.invocationId,
        attempt: invocation.attempt,
        scheduleId: run.scheduleId,
        threadId: invocation.threadId,
        threadsDir: realpathSync(dir),
        name: task.name,
        cwd: task.cwd,
        scheduledForMs: run.scheduledForMs,
        mode: run.mode,
        createdAtMs: invocation.createdAtMs,
      };
    } catch {
      /* Another known configured store may own this exact ID. */
    } finally {
      source?.close();
    }
  }
  return undefined;
}

function resolveReference(
  input: HistoryInput,
  run: ScheduleRunHistoryEntry,
  attempt?: number,
): ScheduleThreadReference | undefined {
  const refs =
    run.references.length > 0
      ? run.references
      : [legacyReference(input, run)].filter((ref) => ref !== undefined);
  return attempt === undefined ? refs.at(-1) : refs.find((ref) => ref.attempt === attempt);
}

function withSource<T>(
  input: HistoryInput,
  ref: ScheduleThreadReference,
  read: (source: ThreadStoreInstance) => T,
): T {
  const dir = resolve(input.runtime.expandTilde(ref.threadsDir));
  if (!existsSync(join(dir, "threads.db"))) {
    throw new Error("执行会话文件不存在；可能尚未创建或已被移除");
  }
  const source = new input.runtime.ThreadStore(dir, { readOnly: true });
  try {
    if (!source.hasThread(ref.threadId)) throw new Error("执行会话未创建或已被移除");
    const origin = source.getThread(ref.threadId)?.origin;
    if (
      origin?.kind === "scheduled" &&
      (origin.invocationId !== ref.invocationId ||
        origin.attempt !== ref.attempt ||
        origin.scheduleId !== ref.scheduleId)
    ) {
      throw new Error("会话来源与运行关联不一致");
    }
    return read(source);
  } finally {
    source.close();
  }
}

function formatMessage(message: ModelMessage): string {
  const role = { user: "用户", assistant: "助手", tool: "工具结果", system: "系统" }[message.role];
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) => ("text" in part ? part.text : JSON.stringify(part, null, 2)))
          .join("\n");
  return display(`${role}\n${content}`);
}

export async function continueScheduledThread(input: HistoryInput, threadId: string) {
  if (input.engine === undefined) {
    throw new Error("当前入口不支持继续讨论，请使用 roll chat --from-run");
  }
  const source = new input.runtime.ThreadStore(input.config.runtime.threadsDir, { readOnly: true });
  let snapshot: ThreadSnapshot;
  try {
    snapshot = source.readSnapshot(threadId);
  } finally {
    source.close();
  }
  return input.engine.forkSession(snapshot, {
    title: `讨论：${snapshot.thread.origin.kind === "scheduled" ? snapshot.thread.origin.name : (snapshot.thread.title ?? "执行记录")}`,
  });
}

export function createScheduleBrowserPort(input: HistoryInput): ScheduleBrowserPort {
  const inspect = (invocationId: string, requestedAttempt?: number): ScheduleRunDetail => {
    const run = loadRun(input, invocationId);
    const ref = resolveReference(input, run, requestedAttempt);
    const attempt = requestedAttempt ?? ref?.attempt ?? run.invocation?.attempt ?? 1;
    const attempts = [
      ...new Set([
        ...run.references.map((item) => item.attempt),
        ...(run.invocation ? [run.invocation.attempt] : []),
        attempt,
      ]),
    ].sort((a, b) => a - b);
    let unavailableReason: string | undefined;
    try {
      if (ref === undefined) {
        throw new Error("本次尝试没有可追溯的会话关联（可能在创建会话前失败）");
      }
      withSource(input, ref, () => undefined);
    } catch (error) {
      unavailableReason = errorText(error);
    }
    const current = run.invocation?.attempt === attempt ? run.invocation : undefined;
    const task =
      ref === undefined
        ? input.runtime
            .readScheduleHistory(input.config.scheduler.dataDir)
            .tasks.find((item) => item.scheduleId === run.scheduleId)
        : undefined;
    return {
      invocationId,
      taskName: display(ref?.name ?? task?.name ?? "定时任务"),
      cwd: display(ref?.cwd ?? task?.cwd ?? "未记录"),
      attempt,
      attempts,
      mode: run.mode,
      status: current?.status ?? null,
      ...(current === undefined
        ? {
            statusUnavailableReason:
              run.invocation === undefined
                ? STATUS_UNAVAILABLE_REASONS.ledgerMissing
                : STATUS_UNAVAILABLE_REASONS.attemptNotCurrent,
          }
        : {}),
      ...(current?.outputExcerpt ? { summary: display(current.outputExcerpt) } : {}),
      ...(current?.error ? { error: display(current.error) } : {}),
      ...(ref ? { sessionId: ref.threadId } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
      canContinue: unavailableReason === undefined,
    };
  };
  return {
    async listTasks() {
      const result = input.runtime.readScheduleHistory(input.config.scheduler.dataDir);
      requireReadable(result.status);
      return result.tasks.map((task) => ({
        id: task.scheduleId,
        name: display(task.name),
        removed: task.schedule === undefined,
        trigger:
          task.schedule === undefined
            ? "历史任务"
            : input.runtime.describeTrigger(task.schedule.trigger),
        status: task.schedule?.status ?? null,
        ...(task.latestRun ? { lastRunStatus: task.latestRun.invocation?.status ?? null } : {}),
      }));
    },
    async listRuns(taskId, page) {
      const offset = cursorOffset(page.cursor);
      const result = input.runtime.readScheduleHistory(input.config.scheduler.dataDir, {
        scheduleId: taskId,
        limit: page.limit,
        offset,
      });
      requireReadable(result.status);
      return {
        items: result.runs.map((run) => ({
          id: run.invocationId,
          scheduledAt: new Date(run.scheduledForMs).toISOString(),
          mode: run.mode,
          status: run.invocation?.status ?? null,
          ...(run.invocation?.outputExcerpt
            ? { excerpt: display(run.invocation.outputExcerpt) }
            : {}),
          attempts: [
            ...new Set([
              ...run.references.map((ref) => ref.attempt),
              ...(run.invocation ? [run.invocation.attempt] : []),
            ]),
          ].sort((a, b) => a - b),
        })),
        ...(result.hasMore ? { nextCursor: String(offset + page.limit) } : {}),
      };
    },
    async inspect(invocationId, attempt) {
      return inspect(invocationId, attempt);
    },
    async readTranscript(invocationId, page) {
      const run = loadRun(input, invocationId);
      const ref = resolveReference(input, run, page.attempt);
      if (ref === undefined) throw new Error("本次尝试没有可追溯的会话关联");
      const match = /^(messages|tools):(-?\d+)$/u.exec(page.cursor ?? "messages:-1");
      const through = Number.MAX_SAFE_INTEGER;
      const after = Number(match?.[2]);
      if (!match || !Number.isSafeInteger(after) || after < -1) {
        throw new Error("无效的对话分页位置");
      }
      return withSource(input, ref, (source) => {
        const completeness = source.getTranscriptCompleteness(ref.threadId);
        const notice =
          completeness === "complete"
            ? ""
            : "历史记录不完整：部分内容来自旧版快照或已超过证据保留期限。\n\n";
        if (match[1] === "messages") {
          const rows = source.listTranscriptMessages(ref.threadId, {
            afterSequence: after,
            throughSequence: through,
            limit: page.limit + 1,
          });
          const entries = rows.slice(0, page.limit);
          return {
            text: notice + entries.map((entry) => formatMessage(entry.message)).join("\n\n"),
            nextCursor:
              rows.length > page.limit
                ? `messages:${String(entries.at(-1)?.sequence)}`
                : "tools:-1",
          };
        }
        const rows = source.listToolExecutions(ref.threadId, {
          afterSequence: after,
          throughSequence: through,
          limit: page.limit + 1,
        });
        const entries = rows.slice(0, page.limit);
        return {
          text:
            entries.length === 0
              ? "没有更多保留的工具执行证据。"
              : entries
                  .map((entry) => display(`工具执行证据\n${JSON.stringify(entry, null, 2)}`))
                  .join("\n\n"),
          ...(rows.length > page.limit
            ? { nextCursor: `tools:${String(entries.at(-1)?.sequence)}` }
            : {}),
        };
      });
    },
    async continueRun(invocationId, attempt) {
      if (input.engine === undefined) throw new Error("请使用 roll chat --from-run 继续讨论");
      const run = loadRun(input, invocationId);
      const ref = resolveReference(input, run, attempt);
      if (ref === undefined) throw new Error("本次尝试没有可追溯的会话关联");
      const captured = withSource(input, ref, (source) => source.readSnapshot(ref.threadId));
      const snapshot = {
        ...captured,
        thread: { ...captured.thread, origin: originFor(input, ref) },
      };
      return input.engine.forkSession(snapshot, {
        title: `讨论：${ref.name} · ${new Date(ref.scheduledForMs).toISOString()}`,
      });
    },
  };
}

/** Chat may classify only its own threads; the scheduler ledger is always read-only here. */
export function backfillScheduledThreads(
  config: RollConfig,
  runtime: RuntimeModule,
  current: ThreadStoreInstance,
): void {
  const dir = resolve(runtime.expandTilde(config.scheduler.dataDir));
  if (!existsSync(join(dir, "schedules.db"))) return;
  const input = { config, runtime };
  try {
    const currentDir = realpathSync(runtime.expandTilde(config.runtime.threadsDir));
    const applyReference = (ref: ScheduleThreadReference): void => {
      try {
        const sourceDir = resolve(runtime.expandTilde(ref.threadsDir));
        if (
          sourceDir !== currentDir &&
          (!existsSync(sourceDir) || realpathSync(sourceDir) !== currentDir)
        ) {
          return;
        }
        current.backfillScheduledOrigin(ref.threadId, originFor(input, ref));
      } catch (error) {
        log.warn(`运行 ${ref.invocationId} 的本地会话归类已跳过：${display(errorText(error))}`);
      }
    };
    let offset = 0;
    for (;;) {
      const history = runtime.readScheduleHistory(dir, { offset, limit: 100 });
      requireReadable(history.status);
      for (const run of history.runs) {
        for (const ref of run.references) applyReference(ref);
        const invocation = run.invocation;
        if (
          invocation?.threadId === undefined ||
          run.references.some((ref) => ref.attempt === invocation.attempt)
        ) {
          continue;
        }
        const task = history.tasks.find((item) => item.scheduleId === run.scheduleId);
        if (task === undefined || !current.hasThread(invocation.threadId)) continue;
        // Legacy ledgers have an exact thread ID but no durable storage locator yet.
        applyReference({
          invocationId: invocation.id,
          attempt: invocation.attempt,
          scheduleId: run.scheduleId,
          threadId: invocation.threadId,
          threadsDir: currentDir,
          name: task.name,
          cwd: task.cwd,
          scheduledForMs: run.scheduledForMs,
          mode: run.mode,
          createdAtMs: invocation.createdAtMs,
        });
      }
      if (!history.hasMore) break;
      offset += 100;
    }
  } catch (error) {
    log.warn(`旧定时会话归类暂不可用：${display(errorText(error))}`);
  }
}

/** Called only after a scheduler-owned entrypoint explicitly opens its ledger for writing. */
export function backfillScheduleThreadReferences(
  config: RollConfig | undefined,
  runtime: RuntimeModule,
  ledger: InstanceType<RuntimeModule["ScheduleStore"]>,
  dataDir: string,
): void {
  for (const task of ledger.listSchedules()) {
    try {
      const baseConfig = config ?? loadConfig({ cwd: task.cwd }).config;
      const input: HistoryInput = {
        config: { ...baseConfig, scheduler: { ...baseConfig.scheduler, dataDir } },
        runtime,
        ...(config === undefined ? { cwd: task.cwd } : {}),
      };
      for (const invocation of ledger.listInvocations(task.id, Number.MAX_SAFE_INTEGER)) {
        if (invocation.threadId === undefined) continue;
        const run = runtime.readScheduleRun(dataDir, invocation.id).run;
        if (run === undefined || run.references.some((ref) => ref.attempt === invocation.attempt)) {
          continue;
        }
        const ref = legacyReference(input, run);
        if (ref === undefined) continue;
        ledger.backfillThreadReference({
          invocationId: invocation.id,
          expectedAttempt: invocation.attempt,
          threadId: ref.threadId,
          threadsDir: ref.threadsDir,
        });
      }
    } catch (error) {
      log.warn(`任务 ${task.id} 的历史关联补写已跳过：${display(errorText(error))}`);
    }
  }
}
