import type { Readable, Writable } from "node:stream";
import { isCancel, select } from "@clack/prompts";
import type { AgentSession } from "@roll-agent/runtime";
import {
  ScheduleBrowserController,
  formatInvocationMode,
  formatInvocationStatus,
  formatScheduleStatus,
  scheduleDetailText,
  type ScheduleBrowserPort,
} from "./schedule-browser.ts";

export interface BasicScheduleBrowserOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
}

type BrowserChoice = { readonly action: string; readonly id?: string };

/** Caller pauses its readline while browsing; this helper never closes the shared input. */
export async function runBasicScheduleBrowser(
  port: ScheduleBrowserPort,
  options: BasicScheduleBrowserOptions = {},
): Promise<AgentSession | undefined> {
  const output = options.output ?? process.stderr;
  const controller = new ScheduleBrowserController(port);
  await controller.refresh();
  while (!options.signal?.aborted) {
    const { view, error } = controller.getSnapshot();
    if (error !== undefined) output.write(`读取／操作失败：${error}\n`);
    const choices: Array<{ value: BrowserChoice; label: string; hint?: string }> = [];
    if (view.kind === "tasks") {
      for (const task of view.tasks) {
        choices.push({
          value: { action: "choose", id: task.id },
          label: `${task.removed ? "历史任务 · " : ""}${task.name}`,
          hint: `${task.trigger} · ${formatScheduleStatus(task.status)}${task.lastRunStatus === undefined ? "" : ` · 最近${formatInvocationStatus(task.lastRunStatus)}`}`,
        });
      }
      if (view.tasks.length === 0) output.write("暂无定时任务或保留的历史任务\n");
    } else if (view.kind === "runs") {
      for (const run of view.page.items) {
        choices.push({
          value: { action: "choose", id: run.id },
          label: `${run.scheduledAt} · ${run.excerpt ?? run.id}`,
          hint: `${formatInvocationMode(run.mode)} · ${formatInvocationStatus(run.status)} · ${String(run.attempts.length)} 次尝试`,
        });
      }
      if (view.page.items.length === 0) output.write("该任务暂无运行记录\n");
    } else {
      output.write(`\n${scheduleDetailText(view.detail, process.cwd())}\n\n${view.page.text}\n`);
      if (view.detail.canContinue) {
        choices.push({
          value: { action: "continue" },
          label: "基于截至此刻的快照继续讨论",
          hint: "使用当前目录、模型和权限",
        });
      }
      const attemptIndex = view.detail.attempts.indexOf(view.detail.attempt);
      if (attemptIndex > 0) {
        choices.push({ value: { action: "previous-attempt" }, label: "查看上一次尝试" });
      }
      if (attemptIndex < view.detail.attempts.length - 1) {
        choices.push({ value: { action: "next-attempt" }, label: "查看下一次尝试" });
      }
    }
    if (view.kind !== "tasks") {
      if (view.page.nextCursor !== undefined) {
        choices.push({ value: { action: "next" }, label: "下一页" });
      }
      if (view.cursors.length > 1) choices.push({ value: { action: "previous" }, label: "上一页" });
    }
    choices.push({ value: { action: "refresh" }, label: "刷新" });
    choices.push({
      value: { action: "back" },
      label: view.kind === "tasks" ? "返回聊天" : "返回上一级",
    });
    // Clack retains its abort listener until the signal aborts. Give each prompt an isolated
    // signal so long browsing sessions do not accumulate listeners on the REPL's signal.
    const promptAbort = new AbortController();
    const relayAbort = (): void => promptAbort.abort();
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    if (options.signal?.aborted) promptAbort.abort();
    const answer = await select<BrowserChoice>({
      message:
        view.kind === "tasks"
          ? "定时任务"
          : view.kind === "runs"
            ? `${view.task.name} · 运行记录 · 第 ${String(view.cursors.length)} 页`
            : `执行记录 · 第 ${String(view.cursors.length)} 页`,
      options: choices,
      ...(options.input === undefined ? {} : { input: options.input }),
      output,
      signal: promptAbort.signal,
    }).finally(() => options.signal?.removeEventListener("abort", relayAbort));
    if (options.signal?.aborted) return undefined;
    if (isCancel(answer) || answer.action === "back") {
      if (!controller.back()) return undefined;
      continue;
    }
    if (answer.action === "choose" && answer.id !== undefined) await controller.choose(answer.id);
    else if (answer.action === "refresh") await controller.refresh();
    else if (answer.action === "next") await controller.page(1);
    else if (answer.action === "previous") await controller.page(-1);
    else if (answer.action === "next-attempt") await controller.changeAttempt(1);
    else if (answer.action === "previous-attempt") await controller.changeAttempt(-1);
    else if (answer.action === "continue") {
      const session = await controller.continueRun();
      if (session !== undefined) return session;
    }
  }
  return undefined;
}
