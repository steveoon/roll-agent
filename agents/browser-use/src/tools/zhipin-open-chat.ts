import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { rethrowStructuredToolError } from "../pages/zhipin/risk-page.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  conversationId: z.string(),
  candidateId: z.string(),
  candidateName: z.string(),
  index: z.number(),
  hasUnread: z.boolean(),
  unreadCount: z.number(),
  lastMessageTime: z.string(),
  messagePreview: z.string(),
  error: z.string().optional(),
});

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "previewMouseMotion" | "succeed" | "fail"
>;

type ZhipinOpenChatDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinOpenChatDepsOverride: Partial<ZhipinOpenChatDeps> | undefined;

function getZhipinOpenChatDeps(): ZhipinOpenChatDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinOpenChatDepsOverride,
  };
}

export function setZhipinOpenChatDepsForTests(
  override: Partial<ZhipinOpenChatDeps> | undefined,
): void {
  zhipinOpenChatDepsOverride = override;
}

export const zhipinOpenChat = defineTool({
  name: "zhipin_open_chat",
  description: "打开指定候选人的聊天窗口（优先按 conversationId，其次姓名，最后才用索引）",
  input: z.object({
    conversationId: z
      .string()
      .optional()
      .describe("会话 ID。若已从 `zhipin_read_messages` 获取，优先传这个，最稳定"),
    candidateName: z
      .string()
      .optional()
      .describe("候选人姓名。若用户说“打开鲁倩的聊天”，这里应提取为“鲁倩”"),
    index: z.number().optional().describe("候选人在列表中的索引。仅在缺少 conversationId 时兜底"),
    preferUnread: z.boolean().default(false).describe("优先选择有未读消息的候选人"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(
      `Opening chat: name=${input.candidateName ?? "N/A"}, index=${input.index ?? "N/A"}`,
    );

    const deps = getZhipinOpenChatDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await session.begin("正在打开目标聊天");
      await session.highlightSelector(
        ".user-list.b-scroll-stable, .chat-user .user-container, .chat-user",
        { label: "正在定位候选人", padding: 8 },
      );

      const result = await nativePage.openChat({
        conversationId: input.conversationId,
        candidateName: input.candidateName,
        index: input.index,
        preferUnread: input.preferUnread ?? false,
        ...(session !== undefined ? { motionObserver: session } : {}),
      });
      if (!result.found) {
        await session.fail("打开聊天失败");
        return {
          success: false,
          conversationId: "",
          candidateId: "",
          candidateName: input.candidateName ?? "",
          index: input.index ?? -1,
          hasUnread: false,
          unreadCount: 0,
          lastMessageTime: "",
          messagePreview: "",
          error: result.error ?? `未找到候选人: ${input.candidateName ?? `index ${input.index}`}`,
        };
      }

      await session.succeed(`已打开 ${result.name || "目标"} 的聊天`);
      ctx.logger.info(`Opened chat with ${result.name} (index: ${result.index})`);
      return {
        success: true,
        conversationId: result.conversationId,
        candidateId: result.candidateId,
        candidateName: result.name,
        index: result.index,
        hasUnread: result.hasUnread,
        unreadCount: result.unreadCount,
        lastMessageTime: result.lastMessageTime,
        messagePreview: result.messagePreview,
      };
    } catch (error) {
      rethrowStructuredToolError(error);
      await session?.fail("打开聊天失败");
      ctx.logger.warn(
        `Native zhipin open chat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        success: false,
        conversationId: "",
        candidateId: "",
        candidateName: input.candidateName ?? "",
        index: input.index ?? -1,
        hasUnread: false,
        unreadCount: 0,
        lastMessageTime: "",
        messagePreview: "",
        error: error instanceof Error ? error.message : "打开聊天失败",
      };
    } finally {
      nativePage?.close();
    }
  },
});
