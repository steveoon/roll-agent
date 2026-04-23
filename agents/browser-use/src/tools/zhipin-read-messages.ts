import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  performInitialScrollPattern,
} from "../pages/zhipin/anti-detection.ts";
import { ensureChatListLoaded, getChatCandidates } from "../pages/zhipin/chat-navigation.ts";

const CandidateItemSchema = z.object({
  name: z.string(),
  conversationId: z.string(),
  candidateId: z.string(),
  position: z.string(),
  time: z.string(),
  preview: z.string(),
  unreadCount: z.number(),
  hasUnread: z.boolean(),
  index: z.number(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  candidates: z.array(CandidateItemSchema),
  total: z.number(),
  stats: z.object({ withName: z.number(), withUnread: z.number() }),
});

export const zhipinReadMessages = defineTool({
  name: "zhipin_read_messages",
  description: "读取 BOSS直聘未读候选人列表，支持过滤和排序",
  input: z.object({
    limit: z.number().optional().describe("最多返回条数"),
    onlyUnread: z.boolean().default(true).describe("是否只返回有未读消息的候选人"),
    sortBy: z.enum(["time", "unreadCount", "name"]).default("time"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const onlyUnread = input.onlyUnread ?? true;
    ctx.logger.info(
      `Reading zhipin messages (limit: ${input.limit ?? "all"}, onlyUnread: ${onlyUnread})`,
    );

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");

    const listReady = await ensureChatListLoaded(ctxManager, page);
    if (!listReady) {
      return { success: false, candidates: [], total: 0, stats: { withName: 0, withUnread: 0 } };
    }

    const activePage = await ctxManager.getPage("zhipin");

    await performInitialScrollPattern(activePage);

    const candidates = (await getChatCandidates(activePage)).map((candidate) => ({
      name: candidate.name,
      conversationId: candidate.conversationId,
      candidateId: candidate.candidateId,
      position: candidate.position,
      time: candidate.lastMessageTime,
      preview: candidate.messagePreview,
      unreadCount: candidate.unreadCount,
      hasUnread: candidate.hasUnread,
      index: candidate.index,
    }));

    let filtered = onlyUnread ? candidates.filter((c) => c.hasUnread) : candidates;
    const sortBy = input.sortBy ?? "time";
    if (sortBy === "time") {
      // Boss 聊天列表是混合时间格式（例如“昨天”/“04月21日”），保留 DOM 原始顺序最稳妥
    } else if (sortBy === "unreadCount") {
      filtered.sort((a, b) => b.unreadCount - a.unreadCount);
    } else if (sortBy === "name") {
      filtered.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (input.limit !== undefined) filtered = filtered.slice(0, input.limit);

    const stats = {
      withName: candidates.filter((c) => c.name.length > 0).length,
      withUnread: candidates.filter((c) => c.hasUnread).length,
    };

    ctx.logger.info(`Found ${filtered.length} candidates (${stats.withUnread} with unread)`);
    return { success: true, candidates: filtered, total: candidates.length, stats };
  },
});
