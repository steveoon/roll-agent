import { defineTool } from "@roll-agent/sdk";
import {
  GenerateSignedReplyResponseSchema,
  ReplyStreamFinalEventSchema,
  streamGenerateSignedReply,
  type GenerateReplyToolInput,
  type ReplyStreamEvent,
} from "@roll-agent/reply-authority-client";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { resolveConversationSignals } from "../pages/zhipin/job-signals.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type {
  NativeCandidateChatDetails,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import { pickBestUsername } from "../pages/zhipin/username.ts";
import {
  savePreparedReply,
  type PreparedReplyRecord,
} from "../reply-authority/prepared-reply-store.ts";
import { NativeReplyPreviewVisualSession } from "../reply-authority/reply-preview-visual.ts";

const InputSchema = z.object({
  conversationId: z
    .string()
    .optional()
    .describe("会话 ID。若已从 `zhipin_read_messages` 获取，优先传这个，最稳定"),
  candidateName: z
    .string()
    .optional()
    .describe("候选人姓名。若用户说“给鲁倩生成回复”，这里应提取为“鲁倩”"),
  index: z.number().optional().describe("候选人在列表中的索引（可选，仅兜底）"),
  maxMessages: z.number().default(100).describe("最多读取的聊天消息条数"),
});

const OutputSchema = z.object({
  success: z.boolean(),
  preparedReplyId: z.string().optional(),
  suggestedReply: z.string().optional(),
  stage: z.string().optional(),
  confidence: z.number().optional(),
  expiresAt: z.number().optional(),
  requestId: z.string().optional(),
  error: z.string().optional(),
});

const PHASE_LABELS: Readonly<Record<string, string>> = {
  tenant_context: "加载租户上下文",
  binding_check: "校验招聘账号绑定",
  turn_planning: "分析候选人意图",
  context_building: "准备业务上下文",
  qualification_check: "检查候选人资格",
  reply_generation: "生成回复草稿",
  fact_gate: "检查事实安全",
  reply_gate: "检查回复策略",
  signing: "签发安全信封",
};

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "succeed" | "fail"
>;

type ReplyPreviewVisualSessionLike = Pick<
  NativeReplyPreviewVisualSession,
  "begin" | "updateStatus" | "updateDraft" | "complete" | "fail"
>;

type ZhipinGenerateReplyPreviewDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
  readonly createReplyPreviewVisualSession: (
    page: ZhipinNativePagePort,
  ) => ReplyPreviewVisualSessionLike;
  readonly streamGenerateSignedReply: typeof streamGenerateSignedReply;
  readonly savePreparedReply: typeof savePreparedReply;
};

let zhipinGenerateReplyPreviewDepsOverride: Partial<ZhipinGenerateReplyPreviewDeps> | undefined;

function getZhipinGenerateReplyPreviewDeps(): ZhipinGenerateReplyPreviewDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    createReplyPreviewVisualSession: (page) => new NativeReplyPreviewVisualSession(page),
    streamGenerateSignedReply,
    savePreparedReply,
    ...zhipinGenerateReplyPreviewDepsOverride,
  };
}

export function setZhipinGenerateReplyPreviewDepsForTests(
  override: Partial<ZhipinGenerateReplyPreviewDeps> | undefined,
): void {
  zhipinGenerateReplyPreviewDepsOverride = override;
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

function readEventString(event: ReplyStreamEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function buildHistory(messages: NativeCandidateChatDetails["messages"]): string[] {
  return messages
    .filter((message) => message.sender === "candidate" || message.sender === "recruiter")
    .map((message) => {
      const prefix = message.sender === "candidate" ? "求职者" : "我";
      return `${prefix}: ${message.content}`;
    });
}

function getLatestCandidateMessage(messages: NativeCandidateChatDetails["messages"]): string {
  const latest = [...messages]
    .reverse()
    .find((message) => message.sender === "candidate" && message.content.trim().length > 0);
  return latest?.content.trim() ?? "";
}

function buildGenerateReplyInput(input: {
  readonly data: NativeCandidateChatDetails;
  readonly conversationId: string;
  readonly candidateId: string;
  readonly recruiterUsername: string;
}): GenerateReplyToolInput {
  const signals = resolveConversationSignals({
    communicationPosition: input.data.candidateInfo.communicationPosition,
    expectedJobText: input.data.candidateInfo.expectedJobText,
  });

  return {
    candidateMessage: getLatestCandidateMessage(input.data.messages),
    conversationHistory: buildHistory(input.data.messages),
    candidateInfo: {
      name: input.data.candidateInfo.name,
      age: input.data.candidateInfo.age,
      experience: input.data.candidateInfo.experience,
      education: input.data.candidateInfo.education,
      communicationPosition: signals.communicationPosition,
      expectedPosition: signals.expectedPosition,
      expectedLocation: signals.expectedLocation,
      expectedSalary: input.data.candidateInfo.expectedSalary,
      info: [...input.data.candidateInfo.tags],
    },
    ...(signals.preferredBrand !== undefined ? { preferredBrand: signals.preferredBrand } : {}),
    target: {
      platform: "zhipin",
      conversationId: input.conversationId,
      candidateId: input.candidateId,
      recruiterUsername: input.recruiterUsername,
    },
  };
}

function resolveProgressLabel(event: ReplyStreamEvent): string | undefined {
  if (event.type === "phase.started") {
    return (
      readEventString(event, "label") ??
      PHASE_LABELS[readEventString(event, "phase") ?? ""] ??
      "正在处理回复生成阶段"
    );
  }

  if (event.type === "tool.started") {
    return `正在执行工具${readEventString(event, "toolName") ? `: ${readEventString(event, "toolName")}` : ""}`;
  }

  if (event.type === "tool.completed") {
    return `工具执行完成${readEventString(event, "toolName") ? `: ${readEventString(event, "toolName")}` : ""}`;
  }

  if (event.type === "draft.started") {
    return "正在生成回复草稿";
  }

  if (event.type === "reasoning.started") {
    return "正在推理回复策略";
  }

  if (event.type === "reasoning.completed") {
    return "回复策略推理完成";
  }

  return undefined;
}

function createFailure(error: string) {
  return {
    success: false,
    error,
  };
}

function toOutput(record: PreparedReplyRecord) {
  return {
    success: true,
    preparedReplyId: record.preparedReplyId,
    suggestedReply: record.suggestedReply,
    stage: record.stage,
    confidence: record.confidence,
    expiresAt: record.expiresAt,
    ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
  };
}

export const zhipinGenerateReplyPreview = defineTool({
  name: "zhipin_generate_reply_preview",
  description:
    "读取当前或指定 BOSS 聊天，流式生成智能回复并在浏览器中展示阶段和临时草稿；返回 preparedReplyId 供发送。",
  input: InputSchema,
  output: OutputSchema,
  execute: async (input, ctx) => {
    const deps = getZhipinGenerateReplyPreviewDeps();
    const maxMessages = input.maxMessages ?? 100;
    const hasNavigationTarget =
      input.conversationId !== undefined ||
      input.candidateName !== undefined ||
      input.index !== undefined;
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;
    let preview: ReplyPreviewVisualSessionLike | undefined;

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      preview = deps.createReplyPreviewVisualSession(nativePage);
      await nativePage.bringToFront().catch(() => {});
      await session.begin(hasNavigationTarget ? "正在打开目标聊天" : "正在准备当前聊天");

      const nav = hasNavigationTarget
        ? await nativePage.openChat({
            conversationId: input.conversationId,
            candidateName: input.candidateName,
            index: input.index,
            maxScrolls: 4,
          })
        : undefined;
      if (nav !== undefined && !nav.found) {
        const error = nav.error ?? "打开聊天失败";
        await session.fail(error);
        return createFailure(error);
      }
      if (nav === undefined && !(await nativePage.isChatSurfaceOpen().catch(() => false))) {
        const error = "当前页面不是 BOSS 沟通页，无法生成回复";
        await session.fail("当前不是沟通页");
        return createFailure(error);
      }

      await session.begin("正在读取聊天上下文");
      await session.highlightSelector(
        ".chat-conversation, .conversation-box, .conversation-message",
        { label: "正在读取聊天上下文", padding: 12 },
      );

      const expectedName = nav?.name ?? input.candidateName ?? "";
      const activePanel = await nativePage.readActiveChatPanel();
      if (
        expectedName.length > 0 &&
        (!activePanel || !namesCompatible(expectedName, activePanel.candidateName))
      ) {
        const error = `右侧聊天面板未切换到 ${expectedName}`;
        await session.fail("聊天面板未同步");
        return createFailure(error);
      }

      const selectedTarget = await nativePage.readSelectedChatTarget();
      if (!selectedTarget) {
        const error = "未能提取当前选中聊天的 conversationId/candidateId";
        await session.fail("未识别当前会话");
        return createFailure(error);
      }
      if (
        activePanel !== null &&
        selectedTarget.candidateName.length > 0 &&
        !namesCompatible(selectedTarget.candidateName, activePanel.candidateName)
      ) {
        const error =
          `左侧选中会话与右侧聊天面板不一致: ` +
          `${selectedTarget.candidateName} / ${activePanel.candidateName}`;
        await session.fail("当前会话不一致");
        return createFailure(error);
      }
      const selectedTargetMatchesNav =
        nav === undefined ||
        (nav.conversationId.length > 0 && selectedTarget.conversationId === nav.conversationId) ||
        (nav.conversationId.length === 0 &&
          nav.candidateId.length > 0 &&
          selectedTarget.candidateId === nav.candidateId);
      if (!selectedTargetMatchesNav) {
        const error = `当前选中会话与目标会话不一致: ${nav?.name || nav?.conversationId || ""}`;
        await session.fail("当前会话不一致");
        return createFailure(error);
      }

      await nativePage.waitForChatMessages();
      const data = await nativePage.readCandidateChatDetails(maxMessages);
      if (
        data.selectedTarget !== null &&
        (data.selectedTarget.conversationId !== selectedTarget.conversationId ||
          data.selectedTarget.candidateId !== selectedTarget.candidateId)
      ) {
        const error =
          `聊天详情目标与当前选中会话不一致: ` +
          `${data.selectedTarget.conversationId}/${data.selectedTarget.candidateId}`;
        await session.fail("聊天详情目标不一致");
        return createFailure(error);
      }

      const usernameResult = pickBestUsername(await nativePage.readUsernameEvidence());
      if (!usernameResult.found) {
        const error = "未找到用户名，请确认当前页面已登录招聘者账号。";
        await session.fail("未找到用户名");
        return createFailure(error);
      }

      const replyInput = buildGenerateReplyInput({
        data,
        conversationId: selectedTarget.conversationId,
        candidateId: selectedTarget.candidateId,
        recruiterUsername: usernameResult.username,
      });
      if (replyInput.candidateMessage.length === 0) {
        const error = "未找到候选人最新消息，无法生成回复";
        await session.fail("候选人消息为空");
        return createFailure(error);
      }

      ctx.logger.info(
        `Generating reply preview for ${
          selectedTarget.candidateName || selectedTarget.candidateId
        }`,
      );
      await session.begin("正在生成回复");
      await preview.begin("正在生成回复");

      let draftText = "";
      let requestId: string | undefined;
      let preparedRecord: PreparedReplyRecord | undefined;

      for await (const event of deps.streamGenerateSignedReply(replyInput)) {
        if (event.type === "stream.started") {
          requestId = readEventString(event, "requestId");
        }

        const label = resolveProgressLabel(event);
        if (label !== undefined) {
          await session.begin(label);
          await preview.updateStatus(label);
        }

        if (event.type === "draft.started") {
          draftText = "";
          await preview.updateDraft(draftText, true);
        }

        if (event.type === "draft.delta") {
          const delta = readEventString(event, "delta") ?? "";
          draftText += delta;
          await preview.updateDraft(draftText, true);
        }

        if (event.type === "final") {
          const finalEvent = ReplyStreamFinalEventSchema.parse(event);
          const finalReply = GenerateSignedReplyResponseSchema.parse(finalEvent);
          preparedRecord = deps.savePreparedReply({
            signedEnvelope: finalReply.signedEnvelope,
            suggestedReply: finalReply.suggestedReply,
            stage: finalReply.stage,
            confidence: finalReply.confidence,
            expiresAt: finalReply.envelopeExp,
            ...(requestId !== undefined ? { requestId } : {}),
          });
          await preview.complete("回复已生成", finalReply.suggestedReply);
        }
      }

      if (preparedRecord === undefined) {
        const error = "Reply Authority stream 未返回 final";
        await preview.fail(error);
        await session.fail(error);
        return createFailure(error);
      }

      await session.succeed("回复已生成");
      return toOutput(preparedRecord);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await preview?.fail(message);
      await session?.fail(message);
      return createFailure(message);
    } finally {
      nativePage?.close();
    }
  },
});
