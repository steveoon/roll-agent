import type { AgentSession, ConversationEngine, EngineModelSwitch } from "@roll-agent/runtime";
import type { ChatGptConnection } from "./chatgpt-connection.ts";

/** Refresh the session budget while idle, before Runtime constructs a turn's request. */
export function createChatGptSessionPreparation(options: {
  connection: ChatGptConnection;
  engine: Pick<ConversationEngine, "switchModel">;
  getSession: () => AgentSession | undefined;
  getSelection: () => EngineModelSwitch;
  contextWindowOverride?: number;
}) {
  const synchronize = () => {
    const selection = options.getSelection();
    const session = options.getSession();
    if (selection.provider !== "chatgpt" || !session?.canSwitchModel()) return;
    const window =
      options.contextWindowOverride ??
      options.connection.models.find(({ slug }) => slug === selection.modelName)?.contextWindow;
    if (window !== undefined && session.getContextWindow() !== window) {
      options.engine.switchModel(selection);
    }
  };
  const unsubscribe = options.connection.subscribe(synchronize);
  return {
    synchronize,
    dispose: unsubscribe,
    async prepare(signal?: AbortSignal): Promise<void> {
      if (options.getSelection().provider !== "chatgpt") return;
      try {
        await options.connection.prepare(signal);
      } catch {
        // Runtime still records the input and surfaces the cached connection error.
        // Do not bypass its input persistence by throwing a preflight network error.
      }
      signal?.throwIfAborted();
      synchronize();
    },
  };
}
