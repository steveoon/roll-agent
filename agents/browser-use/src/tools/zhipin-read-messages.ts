import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import {
  performInitialScrollPattern,
  performRandomScroll,
} from "../pages/zhipin/anti-detection.ts";
import { ensureChatListLoaded } from "../pages/zhipin/chat-navigation.ts";

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

    const candidates = await activePage.evaluate(() => {
      const items = document.querySelectorAll(".geek-item");
      const result: Array<{
        name: string;
        conversationId: string;
        candidateId: string;
        position: string;
        time: string;
        preview: string;
        unreadCount: number;
        hasUnread: boolean;
        index: number;
      }> = [];

      items.forEach((item, index) => {
        const conversationId =
          item.getAttribute("data-id") ??
          item.closest('[role="listitem"]')?.getAttribute("key") ??
          "";
        const candidateId =
          item.getAttribute("data-geek") ??
          item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
          conversationId;
        const nameEl = item.querySelector(
          '[class*="name"], .nickname, .geek-name, .candidate-name',
        );
        let name = nameEl?.textContent?.trim() ?? "";
        if (name.length > 10) {
          const match = name.match(/[\u4e00-\u9fa5]{2,4}/);
          if (match) name = match[0];
        }

        const position = item.querySelector(".source-job")?.textContent?.trim() ?? "";
        const time = item.querySelector(".time, .time-shadow")?.textContent?.trim() ?? "";
        const preview = (
          item.querySelector(".push-text, .chat-last-msg")?.textContent?.trim() ?? ""
        ).slice(0, 100);

        let unreadCount = 0;
        const badgeEl = item.querySelector(".badge-count");
        if (badgeEl) unreadCount = parseInt(badgeEl.textContent?.trim() ?? "0", 10) || 0;
        const hasUnread = unreadCount > 0 || item.querySelector(".red-dot") !== null;

        result.push({
          name,
          conversationId,
          candidateId,
          position,
          time,
          preview,
          unreadCount,
          hasUnread,
          index,
        });
      });
      return result;
    });

    let filtered = onlyUnread ? candidates.filter((c) => c.hasUnread) : candidates;
    const sortBy = input.sortBy ?? "time";
    if (sortBy === "time") {
      // DOM 顺序即为时间倒序（最新在上），但做一次稳定排序以防万一
      filtered.sort((a, b) => b.time.localeCompare(a.time));
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
    await performRandomScroll(activePage);

    ctx.logger.info(`Found ${filtered.length} candidates (${stats.withUnread} with unread)`);
    return { success: true, candidates: filtered, total: candidates.length, stats };
  },
});
