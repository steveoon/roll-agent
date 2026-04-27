import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import type { ChatListItem } from "../pages/zhipin/chat-navigation.ts";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";

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

type ZhipinReadMessagesDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySession;
};

let zhipinReadMessagesDepsOverride: Partial<ZhipinReadMessagesDeps> | undefined;

function getZhipinReadMessagesDeps(): ZhipinReadMessagesDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinReadMessagesDepsOverride,
  };
}

export function setZhipinReadMessagesDepsForTests(
  override: Partial<ZhipinReadMessagesDeps> | undefined,
): void {
  zhipinReadMessagesDepsOverride = override;
}

function getChatCandidateKey(candidate: ChatListItem): string | undefined {
  if (candidate.conversationId.length > 0) return candidate.conversationId;
  if (candidate.candidateId.length > 0) return candidate.candidateId;
  if (candidate.name.length === 0) return undefined;
  return [candidate.name, candidate.position, candidate.lastMessageTime].join("|");
}

function dedupeChatCandidates(candidates: ReadonlyArray<ChatListItem>): ChatListItem[] {
  const seen = new Set<string>();
  const deduped: ChatListItem[] = [];

  for (const candidate of candidates) {
    const key = getChatCandidateKey(candidate);
    if (key !== undefined && seen.has(key)) {
      continue;
    }
    if (key !== undefined) {
      seen.add(key);
    }
    deduped.push(candidate);
  }

  return deduped;
}

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
    autoScroll: z.boolean().default(true).describe("是否自动向下滚动消息列表并合并采集结果"),
    maxScrolls: z.number().int().min(0).max(50).default(4).describe("自动滚动的最大步数"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const onlyUnread = input.onlyUnread ?? false;
    ctx.logger.info(
      `Reading zhipin messages (limit: ${input.limit ?? "all"}, onlyUnread: ${onlyUnread})`,
    );

    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySession | undefined;
    const deps = getZhipinReadMessagesDeps();

    try {
      nativePage = await deps.openNativePagePort({ requireChatPage: true });
      session = deps.createNativeVisualActivitySession(nativePage);

      await session.begin("正在读取消息列表");

      const listReady = await nativePage.waitForSelector(
        ".user-list.b-scroll-stable, .user-list.b-scroll-stable [role=\"listitem\"], .geek-item",
        5_000,
      );
      if (!listReady) {
        await session.fail("未找到消息列表");
        return {
          success: false,
          candidates: [],
          total: 0,
          stats: { withName: 0, withUnread: 0 },
        };
      }
      const readLabel = onlyUnread ? "正在读取未读消息列表" : "正在读取消息列表";
      await session.highlightSelector(
        ".user-list.b-scroll-stable, .chat-user .user-container, .chat-user",
        { label: readLabel, padding: 8 },
      );

      const autoScroll = input.autoScroll ?? true;
      const maxScrolls = input.maxScrolls ?? 4;
      const rawCandidates = dedupeChatCandidates(
        await nativePage.readChatCandidates({
          autoScroll,
          maxScrolls,
          ...(input.limit !== undefined && !onlyUnread ? { targetCount: input.limit } : {}),
        }),
      );

      const candidates = rawCandidates.map((candidate) => ({
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
      await session?.fail("读取消息列表失败");
      ctx.logger.warn(
        `Native zhipin message read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        success: false,
        candidates: [],
        total: 0,
        stats: { withName: 0, withUnread: 0 },
      };
    } finally {
      nativePage?.close();
    }
  },
});
