import { createElement as h } from "react";
import { render } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import { ChatApp } from "./app.ts";
import { messagesToHistory } from "./history-from-messages.ts";
import { titleFromMessage } from "../title.ts";
import { buildBannerLines, type BannerInfo } from "../banner.ts";
import type { HistoryItem } from "./state.ts";
import { log } from "../../utils/output.ts";

export const INK_HINTS =
  "/exit 退出 · Esc 中断 · / 命令 · Shift+Enter/Ctrl+J 换行 · Alt+./Alt+, 调推理 · Shift+Tab 自动批准";

export interface InkReplStore {
  updateTitle(threadId: string, title: string): void;
  countMessages(threadId: string): number;
  deleteThread(threadId: string): void;
}

export interface RunInkReplOptions {
  readonly model: string;
  readonly banner?: BannerInfo;
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
}

export async function runInkRepl(
  session: AgentSession,
  store: InkReplStore,
  isNewSession: boolean,
  options: RunInkReplOptions,
): Promise<void> {
  let submitted = false;
  let titled = !isNewSession;

  const onUserSubmit = (text: string): void => {
    submitted = true;
    if (!titled) {
      store.updateTitle(session.id, titleFromMessage(text));
      titled = true;
    }
  };

  if (!options.banner) {
    log.info(`多轮对话已就绪（${INK_HINTS}）`);
  }
  const priorHistory = messagesToHistory(session.getMessages());
  const bannerLines = options.banner
    ? buildBannerLines(options.banner, process.stdout.columns || 80, { hints: INK_HINTS })
    : undefined;
  // 恢复会话时历史消息已在 Static 区，动画 banner 会排到消息之后，只对全新会话做入场动画。
  const animateBanner = bannerLines !== undefined && priorHistory.length === 0;
  const bannerItems: HistoryItem[] =
    bannerLines !== undefined && !animateBanner
      ? [{ kind: "banner", id: "banner", lines: bannerLines }]
      : [];

  const rawModeAvailable =
    process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function";
  if (rawModeAvailable) {
    process.stdin.setRawMode(true);
  }

  let instance: ReturnType<typeof render>;
  try {
    instance = render(
      h(ChatApp, {
        session,
        model: options.model,
        contextWindow: session.getContextWindow(),
        availableSkills: session.getSkillSummaries(),
        onUserSubmit,
        onExit: () => {
          instance.unmount();
        },
        initialHistory: [...bannerItems, ...priorHistory],
        ...(animateBanner && bannerLines !== undefined ? { animatedBanner: bannerLines } : {}),
        ...(options.initialThinkingLevel
          ? { initialThinkingLevel: options.initialThinkingLevel }
          : {}),
        ...(options.onThinkingChange ? { onThinkingChange: options.onThinkingChange } : {}),
      }),
      {
        kittyKeyboard: {
          mode: "auto",
          flags: ["disambiguateEscapeCodes", "reportAlternateKeys"],
        },
      },
    );
  } catch (error) {
    if (rawModeAvailable) {
      process.stdin.setRawMode(false);
    }
    throw error;
  }

  await instance.waitUntilExit();
  await session.close();

  if (isNewSession && !submitted && store.countMessages(session.id) === 0) {
    store.deleteThread(session.id);
  }
}
