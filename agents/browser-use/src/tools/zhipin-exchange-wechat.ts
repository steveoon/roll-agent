import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type { ZhipinNativePagePort } from "../pages/zhipin/native-page.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  exchanged: z.boolean(),
  wechatNumber: z.string().optional(),
  error: z.string().optional(),
});

const EXCHANGE_WECHAT_CLICK_PRE_DELAY_MS = 900;
const EXCHANGE_WECHAT_CLICK_PRESS_MS = 160;
const EXCHANGE_WECHAT_CLICK_SETTLE_MS = 1_100;

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "previewMouseMotion" | "succeed" | "fail"
>;

type ZhipinExchangeWechatDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinExchangeWechatDepsOverride: Partial<ZhipinExchangeWechatDeps> | undefined;

function getZhipinExchangeWechatDeps(): ZhipinExchangeWechatDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinExchangeWechatDepsOverride,
  };
}

export function setZhipinExchangeWechatDepsForTests(
  override: Partial<ZhipinExchangeWechatDeps> | undefined,
): void {
  zhipinExchangeWechatDepsOverride = override;
}

function namesCompatible(expectedName: string, actualName: string): boolean {
  const expected = expectedName.trim().toLocaleLowerCase("zh-CN");
  const actual = actualName.trim().toLocaleLowerCase("zh-CN");
  return (
    expected.length > 0 &&
    actual.length > 0 &&
    (expected === actual || expected.includes(actual) || actual.includes(expected))
  );
}

export const zhipinExchangeWechat = defineTool({
  name: "zhipin_exchange_wechat",
  description:
    '换微信。可指定 candidateName 自动打开对应聊天后执行，或不传则在当前窗口执行；例如"和鲁倩换微信"应提取 candidateName=鲁倩。',
  input: z.object({
    conversationId: z.string().optional().describe("会话 ID。若已从消息列表拿到，优先传这个"),
    candidateName: z
      .string()
      .optional()
      .describe('候选人姓名。若用户说"和鲁倩换微信"，这里应提取为"鲁倩"'),
    index: z.number().optional().describe("候选人在列表中的索引（可选）"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinExchangeWechatDeps();
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await nativePage.bringToFront().catch(() => {});
      await session.begin("正在换微信");

      if (
        input.conversationId !== undefined ||
        input.candidateName !== undefined ||
        input.index !== undefined
      ) {
        const nav = await nativePage.openChat({
          conversationId: input.conversationId,
          candidateName: input.candidateName,
          index: input.index,
          ...(session !== undefined ? { motionObserver: session } : {}),
        });
        if (!nav.found) {
          await session.fail(nav.error ?? "未找到目标聊天");
          return {
            success: false,
            exchanged: false,
            error: nav.error ?? "未找到目标聊天",
          };
        }
      } else if (!(await nativePage.isChatSurfaceOpen())) {
        await session.fail("消息列表未加载");
        return { success: false, exchanged: false, error: "消息列表未加载" };
      }

      const chatTarget = await nativePage.readSelectedChatTarget();
      if (chatTarget === null) {
        await session.fail("未选中聊天联系人");
        return {
          success: false,
          exchanged: false,
          error: "未选中聊天联系人，无法点击当前聊天输入区的「换微信」按钮",
        };
      }

      const activePanel = await nativePage.readActiveChatPanel();
      if (
        activePanel !== null &&
        chatTarget.candidateName.length > 0 &&
        !namesCompatible(chatTarget.candidateName, activePanel.candidateName)
      ) {
        const error =
          `左侧选中会话与右侧聊天面板不一致: ` +
          `${chatTarget.candidateName} / ${activePanel.candidateName}`;
        await session.fail(error);
        return { success: false, exchanged: false, error };
      }

      ctx.logger.info(`Starting native WeChat exchange with ${chatTarget.candidateName}`);
      const result = await nativePage.exchangeWechat({
        preClickDelayMs: EXCHANGE_WECHAT_CLICK_PRE_DELAY_MS,
        pressDurationMs: EXCHANGE_WECHAT_CLICK_PRESS_MS,
        settleMs: EXCHANGE_WECHAT_CLICK_SETTLE_MS,
        ...(session !== undefined ? { motionObserver: session } : {}),
      });

      if (result.success) {
        await session.succeed("已完成换微信");
        return result;
      }

      await session.fail(result.error ?? "换微信失败");
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await session?.fail(error);
      return { success: false, exchanged: false, error };
    } finally {
      nativePage?.close();
    }
  },
});
