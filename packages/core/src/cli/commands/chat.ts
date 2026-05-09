import { defineCommand } from "citty";
import type { ChatCommandResult, ChatUnavailableResult } from "../../types/chat.ts";
import { log } from "../utils/output.ts";

const UNAVAILABLE_MESSAGE =
  "roll chat 仍处于 experimental 阶段，当前只提供命令骨架，不会执行会话编排、不会恢复 session，也不会隐式降级到 roll ask。";

function createUnavailableResult(): ChatUnavailableResult {
  return {
    status: "unavailable",
    message: UNAVAILABLE_MESSAGE,
  };
}

function printChatJson(result: ChatCommandResult): void {
  console.log(JSON.stringify(result, null, 2));
}

export default defineCommand({
  meta: {
    description: "Experimental: 会话式入口骨架（当前不可用）",
  },
  args: {
    message: { type: "positional", description: "起始消息", required: false },
    session: { type: "string", description: "继续已有会话的 session ID" },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    const result = createUnavailableResult();

    if (args.json) {
      printChatJson(result);
    } else {
      log.warn(result.message);
    }

    process.exitCode = 1;
  },
});
