import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import {
  ScheduleBrowserController,
  formatInvocationMode,
  formatInvocationStatus,
  formatScheduleStatus,
  scheduleDetailText,
  type ScheduleBrowserPort,
} from "../schedule-browser.ts";
import { SessionPicker } from "./session-picker.ts";
import { TranscriptViewport } from "./transcript-viewport.ts";
import type { HistoryItem, LiveState } from "./state.ts";
import { bannerTextLine } from "../banner.ts";
import { truncateDisplay } from "./commands.ts";

interface ScheduleBrowserProps {
  readonly port: ScheduleBrowserPort;
  readonly width: number;
  readonly height: number;
  readonly onClose: () => void;
  readonly onContinue: (session: AgentSession) => void;
}

const EMPTY_LIVE: LiveState = {
  streamingText: "",
  reasoningId: undefined,
  reasoningText: "",
  reasoningActive: false,
  reasoningStartedAt: undefined,
  thinkTagOpen: false,
  activeTools: [],
  compacting: false,
  producedOutput: false,
};
const settled = (): void => {};

export function ScheduleBrowser(props: ScheduleBrowserProps): ReactElement {
  const controller = useMemo(() => new ScheduleBrowserController(props.port), [props.port]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const { view } = state;
  useEffect(() => {
    controller.refresh();
  }, [controller]);

  const back = (): void => {
    if (!controller.back()) props.onClose();
  };
  useInput((input, key) => {
    if (state.busy) {
      if (key.escape) back();
      return;
    }
    if (key.escape && view.kind === "detail") back();
    else if (input === "r") controller.refresh();
    else if (input === "n") controller.page(1);
    else if (input === "p") controller.page(-1);
    else if (input === "[") controller.changeAttempt(-1);
    else if (input === "]") controller.changeAttempt(1);
    else if (input.toLowerCase() === "c" && view.kind === "detail" && view.detail.canContinue) {
      setCreatingConversation(true);
      controller.continueRun().then((session) => {
        setCreatingConversation(false);
        if (session !== undefined) props.onContinue(session);
      });
    }
  });

  const history = useMemo<readonly HistoryItem[]>(
    () =>
      view.kind !== "detail"
        ? []
        : [
            {
              kind: "banner",
              id: "run-metadata",
              lines: [bannerTextLine(scheduleDetailText(view.detail, process.cwd()))],
            },
            {
              kind: "banner",
              id: "run-transcript",
              lines: [bannerTextLine(view.page.text || "暂无已提交的对话内容")],
            },
          ],
    [view],
  );

  if (view.kind === "detail") {
    const compact = props.height < 16;
    const actionAvailable = view.detail.canContinue && !state.busy;
    const navigation =
      props.width >= 86
        ? "PgUp/PgDn 滚动 · n/p 翻页 · [/] 切换尝试 · r 刷新 · Esc 返回"
        : "PgUp/PgDn 滚动 · n/p 翻页\n[/] 尝试 · r 刷新 · Esc 返回";
    return h(
      Box,
      { flexDirection: "column", width: props.width, height: props.height },
      h(
        Box,
        { flexShrink: 0, justifyContent: "space-between", marginBottom: compact ? 0 : 1 },
        h(
          Text,
          { bold: true },
          truncateDisplay(view.detail.taskName, Math.max(8, props.width - 24)),
        ),
        h(Text, { dimColor: true }, `只读快照 · 第 ${String(view.cursors.length)} 页`),
      ),
      h(TranscriptViewport, {
        key: `${view.detail.invocationId}:${String(view.detail.attempt)}:${String(view.cursors.length)}`,
        width: props.width,
        history,
        live: EMPTY_LIVE,
        animateBanner: false,
        onBannerSettled: settled,
        navigationBlocked: state.busy,
        thinkingDisplay: "expanded",
        diffDisplay: "expanded",
      }),
      state.error === undefined
        ? null
        : h(
            Box,
            { flexShrink: 0 },
            h(Text, { color: "red", wrap: "truncate-end" }, `操作失败：${state.error}`),
          ),
      h(
        Box,
        {
          flexDirection: "column",
          flexShrink: 0,
          paddingX: 1,
          borderStyle: "round",
          borderColor: actionAvailable ? "cyan" : "gray",
        },
        creatingConversation
          ? h(Text, { bold: true, color: "cyan" }, "正在创建新对话…")
          : state.busy
            ? h(Text, { dimColor: true }, "正在读取执行记录…")
            : view.detail.canContinue
              ? h(
                  Box,
                  { gap: 1, flexShrink: 0 },
                  h(Text, null, "按"),
                  h(Text, { bold: true, color: "black", backgroundColor: "cyan" }, " C "),
                  h(Text, { bold: true, color: "cyan" }, "继续对话"),
                )
              : h(Text, { bold: true, dimColor: true }, "暂无可继续的会话"),
        h(
          Text,
          { dimColor: true, wrap: "truncate-end" },
          view.detail.canContinue
            ? "从快照新建对话，使用当前工作区"
            : "执行会话不可用，请查看上方说明",
        ),
      ),
      h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, navigation)),
    );
  }

  const items =
    view.kind === "tasks"
      ? view.tasks.map((task) => ({
          id: task.id,
          title: `${task.removed ? "历史任务 · " : ""}${task.name}`,
          meta: `${task.trigger} · ${formatScheduleStatus(task.status)}${task.lastRunStatus === undefined ? "" : ` · 最近${formatInvocationStatus(task.lastRunStatus)}`}`,
        }))
      : view.page.items.map((run) => ({
          id: run.id,
          title: `${run.scheduledAt} · ${run.excerpt ?? run.id}`,
          meta: `${formatInvocationMode(run.mode)} · ${formatInvocationStatus(run.status)} · ${String(run.attempts.length)} 次尝试`,
        }));
  return h(
    Box,
    { flexDirection: "column", width: props.width, height: props.height },
    state.error === undefined ? null : h(Text, { color: "red" }, `读取失败：${state.error}`),
    h(SessionPicker, {
      items,
      width: props.width,
      maxRows: props.height - 2,
      busy: state.busy,
      labels: {
        title: view.kind === "tasks" ? "定时任务" : `${view.task.name} · 运行记录`,
        summary: (count) =>
          view.kind === "tasks"
            ? `共 ${String(count)} 个任务`
            : `第 ${String(view.cursors.length)} 页 · ${String(count)} 次运行`,
        empty: view.kind === "tasks" ? "暂无定时任务或保留的历史任务" : "该任务暂无运行记录",
        select: "Enter 查看",
        busy: "读取中…",
      },
      onSelect: (id) => {
        controller.choose(id);
      },
      onCancel: back,
    }),
    h(Text, { dimColor: true }, view.kind === "tasks" ? "r 刷新" : "n 下一页 · p 上一页 · r 刷新"),
  );
}
