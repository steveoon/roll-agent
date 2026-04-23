import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  performInitialScrollPattern,
} from "../pages/zhipin/anti-detection.ts";
import { ensureChatListLoaded, getChatCandidates } from "../pages/zhipin/chat-navigation.ts";
import { VisualActivitySession } from "../visual-activity-session.ts";

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
  description: "读取 BOSS直聘消息列表，默认返回全部候选人；若只看未读消息，传 onlyUnread=true",
  input: z.object({
    limit: z.number().optional().describe("最多返回条数"),
    onlyUnread: z
      .boolean()
      .default(false)
      .describe("是否只返回有未读消息的候选人；用户说“全部/所有消息列表”时应为 false，说“未读消息”时应为 true"),
    sortBy: z.enum(["time", "unreadCount", "name"]).default("time"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const onlyUnread = input.onlyUnread ?? false;
    ctx.logger.info(
      `Reading zhipin messages (limit: ${input.limit ?? "all"}, onlyUnread: ${onlyUnread})`,
    );

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");
    const session = new VisualActivitySession(page);
    const beginLabel = "正在打开消息列表";
    const readLabel = onlyUnread ? "正在读取未读消息列表" : "正在读取消息列表";

    await session.begin(beginLabel);

    try {
      const listReady = await ensureChatListLoaded(ctxManager, page);
      const activePage = await ctxManager.getPage("zhipin");
      await session.retarget(activePage);
      if (!listReady) {
        await session.fail("未找到消息列表");
        return {
          success: false,
          candidates: [],
          total: 0,
          stats: { withName: 0, withUnread: 0 },
        };
      }

      await session.begin(readLabel);
      await session.highlightSelector(
        ".user-list.b-scroll-stable, .chat-user .user-container, .chat-list-wrap",
        { label: readLabel, padding: 8 },
      );
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

      await session.succeed(
        onlyUnread ? `已读取 ${filtered.length} 条未读消息` : `已读取 ${filtered.length} 条消息`,
      );

      ctx.logger.info(`Found ${filtered.length} candidates (${stats.withUnread} with unread)`);
      return { success: true, candidates: filtered, total: candidates.length, stats };
    } catch (error) {
      await session.fail("读取消息列表失败");
      throw error;
    }
  },
});
