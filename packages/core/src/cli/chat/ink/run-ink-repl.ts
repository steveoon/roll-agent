import { createElement as h } from "react";
import { render } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import { ChatApp, INK_HINTS } from "./app.ts";
import { messagesToHistory } from "./history-from-messages.ts";
import { titleFromMessage } from "../title.ts";
import { buildSessionPickerItems } from "../session-picker-format.ts";
import type { BannerInfo } from "../banner.ts";
import { log } from "../../utils/output.ts";
import { createChatTerminalOutput } from "./terminal-output.ts";

export interface InkReplThreadSummary {
  readonly id: string;
  readonly title: string | undefined;
  readonly updatedAt: string;
}

export interface InkReplStore {
  updateTitle(threadId: string, title: string): void;
  countMessages(threadId: string): number;
  deleteThread(threadId: string): void;
  listThreads(): readonly InkReplThreadSummary[];
}

export interface RunInkReplOptions {
  readonly model: string;
  readonly banner?: BannerInfo;
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
  readonly onStarted?: () => void;
  readonly signal?: AbortSignal;
  readonly resumeSession?: (threadId: string) => Promise<AgentSession>;
  readonly onActiveSessionChange?: (session: AgentSession) => void;
}

export async function runInkRepl(
  session: AgentSession,
  store: InkReplStore,
  isNewSession: boolean,
  options: RunInkReplOptions,
): Promise<void> {
  let active = session;
  let titled = !isNewSession;
  const initial = { id: session.id, isNew: isNewSession, submitted: false };

  const onUserSubmit = (text: string): void => {
    if (active.id === initial.id) {
      initial.submitted = true;
    }
    if (!titled) {
      store.updateTitle(active.id, titleFromMessage(text));
      titled = true;
    }
  };

  const resumeSession = options.resumeSession;
  const sessionSwitching =
    resumeSession === undefined
      ? undefined
      : {
          loadItems: (currentSessionId: string) =>
            buildSessionPickerItems(store.listThreads(), {
              currentSessionId,
              countMessages: (threadId: string) => store.countMessages(threadId),
              now: new Date(),
            }),
          resume: async (threadId: string) => {
            const next = await resumeSession(threadId);
            active = next;
            titled =
              store.listThreads().find((thread) => thread.id === next.id)?.title !== undefined;
            options.onActiveSessionChange?.(next);
            return next;
          },
          onRetired: (threadId: string) => {
            if (
              initial.isNew &&
              threadId === initial.id &&
              !initial.submitted &&
              store.countMessages(threadId) === 0
            ) {
              store.deleteThread(threadId);
            }
          },
        };

  if (!options.banner) {
    log.info(`多轮对话已就绪（${INK_HINTS}）`);
  }
  const priorHistory = messagesToHistory(session.getMessages());

  const terminalOutput = createChatTerminalOutput(process.stdout);
  try {
    const instance: ReturnType<typeof render> = render(
      h(ChatApp, {
        session,
        model: options.model,
        onUserSubmit,
        onExit: () => {
          instance.unmount();
        },
        initialHistory: priorHistory,
        ...(sessionSwitching === undefined ? {} : { sessionSwitching }),
        ...(options.banner === undefined ? {} : { banner: options.banner }),
        ...(options.initialThinkingLevel
          ? { initialThinkingLevel: options.initialThinkingLevel }
          : {}),
        ...(options.onThinkingChange ? { onThinkingChange: options.onThinkingChange } : {}),
      }),
      {
        stdout: terminalOutput.stdout,
        interactive: true,
        alternateScreen: true,
        kittyKeyboard: {
          mode: "auto",
          flags: ["disambiguateEscapeCodes", "reportAlternateKeys"],
        },
      },
    );
    options.onStarted?.();
    const handleAbort = (): void => {
      instance.unmount();
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted === true) {
      handleAbort();
    }
    try {
      await instance.waitUntilExit();
    } finally {
      options.signal?.removeEventListener("abort", handleAbort);
    }
  } finally {
    terminalOutput.dispose();
  }
  await active.close();

  if (
    initial.isNew &&
    active.id === initial.id &&
    !initial.submitted &&
    store.countMessages(active.id) === 0
  ) {
    store.deleteThread(active.id);
    process.stderr.write("本次会话无消息，未保存\n");
    return;
  }

  const messageCount = active
    .getMessages()
    .filter((message) => message.role === "user" || message.role === "assistant").length;
  process.stderr.write(
    `会话 ${active.id} · ${String(messageCount)} 条消息\n继续：roll chat --session ${active.id}\n`,
  );
}
