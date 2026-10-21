import type { ModelTurnRecovery } from "@roll-agent/runtime";
import { isRecoverableChatGptError } from "../llm/chatgpt-recovery.ts";
import { chatGptConnectionError, type ChatGptConnection } from "./chatgpt-connection.ts";

/** Host-owned connection lifecycle; request retry admission remains entirely in Runtime. */
export function createChatGptTurnRecovery(connection: ChatGptConnection): ModelTurnRecovery {
  return {
    isRecoverable: isRecoverableChatGptError,
    prepare: (signal) => connection.prepareRecovery(signal),
    onTurnStart: () => connection.beginTurn(),
    onRecovering: () => connection.recovering(),
    onTurnEnd: (error) => connection.endTurn(error),
    formatError: (error) =>
      `${chatGptConnectionError(error)} 本轮已停止，输入和已完成的操作已保留。`,
  };
}
