import { createElement as h } from "react";
import { render } from "ink";
import type { AgentSession } from "@roll-agent/runtime";
import { ChatApp } from "./app.ts";
import { titleFromMessage } from "../title.ts";
import { log } from "../../utils/output.ts";

export interface InkReplStore {
  updateTitle(threadId: string, title: string): void;
  countMessages(threadId: string): number;
  deleteThread(threadId: string): void;
}

export async function runInkRepl(
  session: AgentSession,
  store: InkReplStore,
  isNewSession: boolean,
  model: string,
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

  log.info("多轮对话已就绪（exit / quit 退出 · /compact 压缩上下文 · 方向键确认工具）");

  const instance = render(
    h(ChatApp, {
      session,
      model,
      contextWindow: session.getContextWindow(),
      onUserSubmit,
      onExit: () => {
        instance.unmount();
      },
    }),
  );

  await instance.waitUntilExit();
  session.abort();

  if (isNewSession && !submitted && store.countMessages(session.id) === 0) {
    store.deleteThread(session.id);
  }
}
