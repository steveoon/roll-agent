import { defineTool } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type {
  NativeCandidateChatDetails,
  NativeSelectedChatTarget,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import { matchesRecruiterBinding } from "../pages/zhipin/recruiter-identity.ts";
import { pickBestUsername } from "../pages/zhipin/username.ts";
import { getReplyAuthorityKeysLoaded } from "../runtime-holder.ts";
import { recordZhipinMessageSentEvent } from "../recruitment-events/zhipin-events.ts";
import type { ReplyAuthorityEnvelopePayload } from "../reply-authority/schemas.ts";
import {
  isReplyEnvelopeConsumed,
  markReplyEnvelopeConsumed,
} from "../reply-authority/replay-store.ts";
import { NativeReplyPreviewVisualSession } from "../reply-authority/reply-preview-visual.ts";
import { verifySignedReplyEnvelope } from "../reply-authority/verifier.ts";
import { maybeBringToFront } from "../browser-foreground.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  sentMessage: z.string(),
  error: z.string().optional(),
});

export type ZhipinSendReplyResult = z.infer<typeof OutputSchema>;

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "previewMouseMotion" | "succeed" | "fail"
>;

export type ZhipinSendReplyDeps = {
  readonly getReplyAuthorityKeysLoaded: typeof getReplyAuthorityKeysLoaded;
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
};

let zhipinSendReplyDepsOverride: Partial<ZhipinSendReplyDeps> | undefined;

function getZhipinSendReplyDeps(): ZhipinSendReplyDeps {
  return {
    getReplyAuthorityKeysLoaded,
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    ...zhipinSendReplyDepsOverride,
  };
}

export function setZhipinSendReplyDepsForTests(
  override: Partial<ZhipinSendReplyDeps> | undefined,
): void {
  zhipinSendReplyDepsOverride = override;
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

type CandidateDetailsReader = {
  readonly readCandidateChatDetails: (maxMessages?: number) => Promise<NativeCandidateChatDetails>;
};

function canReadCandidateDetails(
  nativePage: ZhipinNativePagePort,
): nativePage is ZhipinNativePagePort & CandidateDetailsReader {
  const candidate = nativePage as Partial<CandidateDetailsReader>;
  return typeof candidate.readCandidateChatDetails === "function";
}

async function readCandidateDetailsSafely(
  nativePage: ZhipinNativePagePort,
): Promise<NativeCandidateChatDetails | undefined> {
  if (!canReadCandidateDetails(nativePage)) return undefined;
  return await nativePage.readCandidateChatDetails(50).catch(() => undefined);
}

function targetMatchesEnvelope(
  chatTarget: NativeSelectedChatTarget | null,
  envelopePayload: ReplyAuthorityEnvelopePayload,
): chatTarget is NativeSelectedChatTarget {
  return (
    chatTarget !== null &&
    chatTarget.conversationId === envelopePayload.conversationId &&
    chatTarget.candidateId === envelopePayload.candidateId
  );
}

function panelMatchesTarget(
  chatTarget: NativeSelectedChatTarget,
  activePanel: { readonly candidateName: string } | null,
): boolean {
  return (
    activePanel === null ||
    chatTarget.candidateName.length === 0 ||
    namesCompatible(chatTarget.candidateName, activePanel.candidateName)
  );
}

function normalizeUnreadCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export async function sendSignedZhipinReply(
  input: {
    readonly signedEnvelope: string;
    readonly candidateName?: string | undefined;
    readonly index?: number | undefined;
    readonly unreadCountBeforeReply?: number | undefined;
  },
  ctx: AgentContext,
): Promise<ZhipinSendReplyResult> {
  const deps = getZhipinSendReplyDeps();
  let nativePage: ZhipinNativePagePort | undefined;
  let session: NativeVisualActivitySessionLike | undefined;
  let sentMessage = "";

  if (!deps.getReplyAuthorityKeysLoaded()) {
    const error =
      "Reply Authority 公钥尚未成功预加载，当前无法发送签名回复。请检查启动日志、" +
      "`REPLY_AUTHORITY_KEYS_URL` 配置，以及 `browser_status.replyAuthorityKeysLoaded`。";
    ctx.logger.error(error);
    return { success: false, sentMessage, error };
  }

  try {
    const envelopePayload = await verifySignedReplyEnvelope(input.signedEnvelope);
    sentMessage = envelopePayload.reply;

    if (isReplyEnvelopeConsumed(envelopePayload.jti)) {
      return { success: false, sentMessage, error: "token 已消费，禁止重放" };
    }

    nativePage = await deps.openNativePagePort();
    session = deps.createNativeVisualActivitySession(nativePage);
    await maybeBringToFront(nativePage);
    await new NativeReplyPreviewVisualSession(nativePage).clear();
    await session.begin("正在发送回复");

    let activePanel = await nativePage.readActiveChatPanel().catch(() => null);
    let chatTarget = await nativePage.readSelectedChatTarget().catch(() => null);
    let unreadCountBeforeReply = normalizeUnreadCount(input.unreadCountBeforeReply);

    if (
      !targetMatchesEnvelope(chatTarget, envelopePayload) ||
      !panelMatchesTarget(chatTarget, activePanel)
    ) {
      const nav = await nativePage.openChat({
        conversationId: envelopePayload.conversationId,
        candidateName: input.candidateName,
        index: input.index,
      });
      if (!nav.found) {
        await session.fail(nav.error ?? "未找到目标聊天");
        return { success: false, sentMessage, error: nav.error ?? "未找到目标聊天" };
      }
      unreadCountBeforeReply = Math.max(
        unreadCountBeforeReply,
        normalizeUnreadCount(nav.unreadCount),
      );
      activePanel = await nativePage.readActiveChatPanel();
      chatTarget = await nativePage.readSelectedChatTarget();
    }

    if (chatTarget === null) {
      await session.fail("未能提取当前聊天的 conversationId/candidateId");
      return {
        success: false,
        sentMessage,
        error: "未能提取当前聊天的 conversationId/candidateId",
      };
    }
    if (
      activePanel !== null &&
      chatTarget.candidateName.length > 0 &&
      !namesCompatible(chatTarget.candidateName, activePanel.candidateName)
    ) {
      const error =
        `左侧选中会话与右侧聊天面板不一致: ` +
        `${chatTarget.candidateName} / ${activePanel.candidateName}`;
      await session.fail(error);
      return { success: false, sentMessage, error };
    }
    if (
      chatTarget.conversationId !== envelopePayload.conversationId ||
      chatTarget.candidateId !== envelopePayload.candidateId
    ) {
      await session.fail("发送目标与签名不匹配");
      return { success: false, sentMessage, error: "发送目标与签名不匹配" };
    }

    const usernameResult = pickBestUsername(await nativePage.readUsernameEvidence());
    if (!usernameResult.found) {
      await session.fail("未找到用户名");
      return {
        success: false,
        sentMessage,
        error: "未找到用户名，请确认当前页面已登录招聘者账号。",
      };
    }
    const recruiterIdentity = {
      platform: "zhipin" as const,
      username: usernameResult.username,
      strategy: usernameResult.strategy,
      source: usernameResult.source,
    };
    if (!matchesRecruiterBinding(recruiterIdentity, envelopePayload.recruiterBinding)) {
      const error =
        `recruiter 绑定不匹配：当前账号 ${recruiterIdentity.username}` +
        ` 与签发时 ${envelopePayload.recruiterBinding.username} 不一致`;
      await session.fail(error);
      return { success: false, sentMessage, error };
    }

    ctx.logger.info(
      `Sending native message (${sentMessage.length} chars) to ${
        chatTarget.candidateName || chatTarget.candidateId
      }`,
    );
    const sendResult = await nativePage.sendChatReply(sentMessage, {
      ...(session !== undefined ? { motionObserver: session } : {}),
    });
    if (!sendResult.success) {
      await session.fail(sendResult.error ?? "发送失败");
      return { success: false, sentMessage, error: sendResult.error ?? "发送失败" };
    }

    const candidateDetails = await readCandidateDetailsSafely(nativePage);
    recordZhipinMessageSentEvent(
      {
        conversationId: chatTarget.conversationId,
        candidateId: chatTarget.candidateId,
        replyId: envelopePayload.jti,
        candidateName: chatTarget.candidateName,
        message: sentMessage,
        unreadCountBeforeReply,
        ...(candidateDetails !== undefined ? { candidateDetails } : {}),
      },
      ctx.logger,
    );
    markReplyEnvelopeConsumed(envelopePayload.jti, envelopePayload.exp);
    await session.succeed("已发送回复");
    return { success: true, sentMessage };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await session?.fail(error);
    return { success: false, sentMessage, error };
  } finally {
    nativePage?.close();
  }
}

export const zhipinSendReply = defineTool({
  name: "zhipin_send_reply",
  description:
    "发送消息。只接受由 Reply Authority Service 签发的 signedEnvelope；可指定 candidateName 自动打开对应聊天后发送，或不传则发送到当前选中的聊天窗口。",
  input: z.object({
    signedEnvelope: z.string().describe("Reply Authority Service 返回的紧凑签名信封"),
    candidateName: z
      .string()
      .optional()
      .describe("候选人姓名。若用户说“回复鲁倩”，这里应提取为“鲁倩”"),
    index: z.number().optional().describe("候选人在列表中的索引（可选）"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => await sendSignedZhipinReply(input, ctx),
});
