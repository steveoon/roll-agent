import { createElement as h } from "react";
import { render } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import { ChatApp } from "./app.ts";
import { messagesToHistory } from "./history-from-messages.ts";
import { titleFromMessage } from "../title.ts";
import { log } from "../../utils/output.ts";

export interface InkReplStore {
  updateTitle(threadId: string, title: string): void;
  countMessages(threadId: string): number;
  deleteThread(threadId: string): void;
}

export interface RunInkReplOptions {
  readonly model: string;
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

  log.info("多轮对话已就绪（/exit 退出 · / 命令 · Shift+Enter/Ctrl+J 换行 · Alt+./Alt+, 调推理）");

  const instance = render(
    h(ChatApp, {
      session,
      model: options.model,
      contextWindow: session.getContextWindow(),
      onUserSubmit,
      onExit: () => {
        instance.unmount();
      },
      initialHistory: messagesToHistory(session.getMessages()),
      ...(options.initialThinkingLevel
        ? { initialThinkingLevel: options.initialThinkingLevel }
        : {}),
      ...(options.onThinkingChange ? { onThinkingChange: options.onThinkingChange } : {}),
    }),
    { kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes", "reportAlternateKeys"] } },
  );

  await instance.waitUntilExit();
  session.abort();

  if (isNewSession && !submitted && store.countMessages(session.id) === 0) {
    store.deleteThread(session.id);
  }
}
