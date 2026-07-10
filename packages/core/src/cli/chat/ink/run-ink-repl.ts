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
  const bannerItems: HistoryItem[] = options.banner
    ? [
        {
          kind: "banner",
          id: "banner",
          lines: buildBannerLines(options.banner, process.stdout.columns || 80, {
            hints: INK_HINTS,
          }),
        },
      ]
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
        initialHistory: [...bannerItems, ...messagesToHistory(session.getMessages())],
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
  session.abort();

  if (isNewSession && !submitted && store.countMessages(session.id) === 0) {
    store.deleteThread(session.id);
  }
}
