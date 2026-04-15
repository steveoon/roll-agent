import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  ensureChatListLoaded,
  ensureChatOpen,
  getChatCandidates,
} from "../pages/zhipin/chat-navigation.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  candidateName: z.string(),
  index: z.number(),
  hasUnread: z.boolean(),
  unreadCount: z.number(),
  lastMessageTime: z.string(),
  messagePreview: z.string(),
  error: z.string().optional(),
});

export const zhipinOpenChat = defineTool({
  name: "zhipin_open_chat",
  description: "打开指定候选人的聊天窗口（按姓名模糊匹配或索引）",
  input: z.object({
    candidateName: z
      .string()
      .optional()
      .describe("候选人姓名。若用户说“打开鲁倩的聊天”，这里应提取为“鲁倩”"),
    index: z.number().optional().describe("候选人在列表中的索引"),
    preferUnread: z.boolean().default(false).describe("优先选择有未读消息的候选人"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(
      `Opening chat: name=${input.candidateName ?? "N/A"}, index=${input.index ?? "N/A"}`,
    );

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");
    let navTarget = {
      candidateName: input.candidateName,
      index: input.index,
    };

    if (input.preferUnread && input.candidateName === undefined && input.index === undefined) {
      const listReady = await ensureChatListLoaded(ctxManager, page);
      if (!listReady) {
        return {
          success: false,
          candidateName: "",
          index: -1,
          hasUnread: false,
          unreadCount: 0,
          lastMessageTime: "",
          messagePreview: "",
          error: "消息列表未加载",
        };
      }

      const activePage = await ctxManager.getPage("zhipin");
      const unreadCandidate = (await getChatCandidates(activePage)).find(
        (candidate) => candidate.hasUnread,
      );
      if (unreadCandidate) {
        navTarget = {
          candidateName: unreadCandidate.name,
          index: unreadCandidate.index,
        };
      }
    }

    const result = await ensureChatOpen(ctxManager, page, navTarget);
    if (!result || !result.found) {
      return {
        success: false,
        candidateName: input.candidateName ?? "",
        index: input.index ?? -1,
        hasUnread: false,
        unreadCount: 0,
        lastMessageTime: "",
        messagePreview: "",
        error: result?.error ?? `未找到候选人: ${input.candidateName ?? `index ${input.index}`}`,
      };
    }

    ctx.logger.info(`Opened chat with ${result.name} (index: ${result.index})`);
    return {
      success: true,
      candidateName: result.name,
      index: result.index,
      hasUnread: result.hasUnread,
      unreadCount: result.unreadCount,
      lastMessageTime: result.lastMessageTime,
      messagePreview: result.messagePreview,
    };
  },
});
