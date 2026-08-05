import { createElement as h } from "react";
import { render } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import { ChatApp, INK_HINTS } from "./app.ts";
import { messagesToHistory } from "./history-from-messages.ts";
import { titleFromMessage } from "../title.ts";
import type { BannerInfo } from "../banner.ts";
import { log } from "../../utils/output.ts";
import { createChatTerminalOutput } from "./terminal-output.ts";

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
  readonly onStarted?: () => void;
  readonly signal?: AbortSignal;
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
  await session.close();

  if (isNewSession && !submitted && store.countMessages(session.id) === 0) {
    store.deleteThread(session.id);
    process.stderr.write("本次会话无消息，未保存\n");
    return;
  }

  const messageCount = session
    .getMessages()
    .filter((message) => message.role === "user" || message.role === "assistant").length;
  process.stderr.write(
    `会话 ${session.id} · ${String(messageCount)} 条消息\n继续：roll chat --session ${session.id}\n`,
  );
}
