import { defineTool } from "@roll-agent/sdk";
import {
  fetchReplyFeedbackRubric,
  GenerateSignedReplyResponseSchema,
  ReasoningConfigSchema,
  ReplyAuthorityRequestError,
  ReplyStreamFinalEventSchema,
  ReplyStreamLocationResolvedEventSchema,
  streamGenerateSignedReply,
  type GenerateReplyToolInput,
  type ReasoningConfig,
  type ReplyFeedbackRubricResponse,
  type ReplyStreamEvent,
  type ReplyVariants,
} from "@roll-agent/reply-authority-client";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import {
  formatLocationSignalsVisualLabel,
  resolveConversationSignals,
} from "../pages/zhipin/job-signals.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import type {
  NativeCandidateChatDetails,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import { rethrowStructuredToolError } from "../pages/zhipin/risk-page.ts";
import { pickBestUsername } from "../pages/zhipin/username.ts";
import {
  PreparedReplyFallbackReasons,
  type PreparedReplyFallbackReason,
} from "../reply-authority/prepared-reply-decision.ts";
import {
  PreparedReplyOptionValues,
  savePreparedReply,
  type PreparedReplyRecord,
  type PreparedReplyVariantGroup,
} from "../reply-authority/prepared-reply-store.ts";
import {
  buildPreparedReplyJudgeContext,
  type PreparedReplyJudgeContext,
} from "../reply-authority/prepared-reply-judge-context.ts";
import { NativeReplyPreviewVisualSession } from "../reply-authority/reply-preview-visual.ts";
import { maybeBringToFront } from "../browser-foreground.ts";

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
  reasoning: ReasoningConfigSchema.optional().describe(
    "可选 reasoning/thinking 控制。enabled=true 会请求 Reply Authority 使用模型推理模式；effort 可选 low/medium/high；scope 可选 reply/all",
  ),
});

const ReplyPreviewErrorKindValues = ["rejected", "timeout", "server_error"] as const;
type ReplyPreviewErrorKind = (typeof ReplyPreviewErrorKindValues)[number];

const ReplyPreviewDiagnosticsSchema = z.object({
  requestId: z.string().optional(),
  elapsedMs: z.number().int().min(0).optional(),
  clientTimeoutMs: z.number().int().positive().optional(),
  lastStartedPhase: z.string().min(1).optional(),
  activePhase: z.string().min(1).optional(),
  phaseLatencies: z.record(z.number().int().min(0)).optional(),
});

const OutputSchema = z
  .object({
    success: z.boolean(),
    preparedReplyId: z.string().optional(),
    suggestedReply: z.string().optional(),
    stage: z.string().optional(),
    confidence: z.number().optional(),
    expiresAt: z.number().optional(),
    timing: z
      .object({
        totalLatencyMs: z.number().int().min(0),
        replyLatencyMs: z.number().int().min(0).optional(),
        turnPlanningLatencyMs: z.number().int().min(0).optional(),
        contextBuildingLatencyMs: z.number().int().min(0).optional(),
        preparedContextHit: z.boolean(),
      })
      .optional(),
    gateRewritten: z
      .boolean()
      .optional()
      .describe("服务端事实/质量门调整过终稿时为 true，此时最终回复可能与流式草稿不一致"),
    replyVariantSelection: z
      .object({
        groupId: z.string().min(1),
        options: z
          .array(
            z.object({
              option: z.enum(PreparedReplyOptionValues),
              suggestedReply: z.string(),
              expiresAt: z.number().int().min(0),
            }),
          )
          .min(2)
          .max(2),
        findings: z.array(
          z.object({
            code: z.string().min(1),
            description: z.string().min(1),
          }),
        ),
        rubricVersion: z.string().min(1),
        rubricHash: z.string().min(1),
      })
      .optional()
      .describe(
        "双稿选择信息；仅暴露中性 option_1/option_2、文本与 rubric 元数据，不暴露 draft/revised 或 signedEnvelope。",
      ),
    error: z.string().optional(),
    errorKind: z.enum(ReplyPreviewErrorKindValues).optional(),
  })
  .extend(ReplyPreviewDiagnosticsSchema.shape);

type ReplyPreviewDiagnostics = z.infer<typeof ReplyPreviewDiagnosticsSchema>;

type ReplyPreviewDiagnosticsState = {
  startedAtMs: number | undefined;
  requestId: string | undefined;
  lastStartedPhase: string | undefined;
  activePhase: string | undefined;
  readonly phaseLatencies: Map<string, number>;
};

const PHASE_LABELS: Readonly<Record<string, string>> = {
  tenant_context: "加载租户上下文",
  binding_check: "校验招聘账号绑定",
  turn_planning: "分析候选人意图",
  context_building: "准备业务上下文",
  qualification_check: "检查候选人资格",
  reply_generation: "生成回复草稿",
  dual_draft: "生成可选改写稿",
  fact_gate: "检查事实安全",
  reply_gate: "检查回复策略",
  signing: "签发安全信封",
};

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "succeed" | "fail" | "clear"
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
  readonly fetchReplyFeedbackRubric: typeof fetchReplyFeedbackRubric;
  readonly savePreparedReply: typeof savePreparedReply;
  readonly random: () => number;
};

let zhipinGenerateReplyPreviewDepsOverride: Partial<ZhipinGenerateReplyPreviewDeps> | undefined;

function getZhipinGenerateReplyPreviewDeps(): ZhipinGenerateReplyPreviewDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    createReplyPreviewVisualSession: (page) => new NativeReplyPreviewVisualSession(page),
    streamGenerateSignedReply,
    fetchReplyFeedbackRubric,
    savePreparedReply,
    random: Math.random,
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

function readEventNumber(event: ReplyStreamEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readEventBoolean(event: ReplyStreamEvent, key: string): boolean | undefined {
  const value = event[key];
  return typeof value === "boolean" ? value : undefined;
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

function getLatestHumanMessage(
  messages: NativeCandidateChatDetails["messages"],
): NativeCandidateChatDetails["messages"][number] | undefined {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        (message.sender === "candidate" || message.sender === "recruiter") &&
        message.content.trim().length > 0,
    );
}

function normalizeUnreadCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function resolveUnreadCountBeforeReply(input: {
  readonly navigationUnreadCount?: number | undefined;
  readonly data: NativeCandidateChatDetails;
}): number {
  const navigationUnreadCount = normalizeUnreadCount(input.navigationUnreadCount);
  if (navigationUnreadCount > 0) return navigationUnreadCount;

  return getLatestHumanMessage(input.data.messages)?.sender === "candidate" ? 1 : 0;
}

function buildGenerateReplyInput(input: {
  readonly data: NativeCandidateChatDetails;
  readonly conversationId: string;
  readonly candidateId: string;
  readonly recruiterUsername: string;
  readonly reasoning?: ReasoningConfig | undefined;
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
    ...(signals.preferredBrandId !== undefined
      ? { preferredBrandId: signals.preferredBrandId }
      : {}),
    ...(input.reasoning !== undefined ? { modelConfig: { reasoning: input.reasoning } } : {}),
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

function createFailure(
  error: string,
  errorKind?: ReplyPreviewErrorKind,
  diagnostics: ReplyPreviewDiagnostics = {},
) {
  return {
    success: false,
    error,
    ...(errorKind !== undefined ? { errorKind } : {}),
    ...diagnostics,
  };
}

function buildFailureDiagnostics(
  state: ReplyPreviewDiagnosticsState,
  error?: unknown,
): ReplyPreviewDiagnostics {
  const requestError = error instanceof ReplyAuthorityRequestError ? error : undefined;
  const requestId = state.requestId ?? requestError?.meta.requestId;
  const phaseLatencies = Object.fromEntries(state.phaseLatencies);

  return {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(state.startedAtMs !== undefined
      ? { elapsedMs: Math.max(0, Math.round(Date.now() - state.startedAtMs)) }
      : {}),
    ...(requestError !== undefined ? { clientTimeoutMs: requestError.meta.timeoutMs } : {}),
    ...(state.lastStartedPhase !== undefined ? { lastStartedPhase: state.lastStartedPhase } : {}),
    ...(state.activePhase !== undefined ? { activePhase: state.activePhase } : {}),
    ...(Object.keys(phaseLatencies).length > 0 ? { phaseLatencies } : {}),
  };
}

function stripReplyAuthorityRequestMeta(message: string): string {
  return message.replace(/\s+\(url=.*\)$/, "");
}

function classifyReplyPreviewError(error: unknown): {
  readonly message: string;
  readonly errorKind?: ReplyPreviewErrorKind;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ReplyAuthorityRequestError) {
    const cleanMessage = stripReplyAuthorityRequestMeta(message);
    if (error.statusCode === 422) {
      return {
        message: `回复未通过事实核验：${cleanMessage}`,
        errorKind: "rejected",
      };
    }
    if (error.statusCode === 504 || cleanMessage.includes("请求超时")) {
      return {
        message: `AI 响应超时：${cleanMessage}`,
        errorKind: "timeout",
      };
    }
    if (error.statusCode !== undefined && error.statusCode >= 500) {
      return {
        message: `Reply Authority 服务端异常：${cleanMessage}`,
        errorKind: "server_error",
      };
    }
  }

  return { message };
}

function formatLatency(ms: number): string {
  if (ms < 1_000) {
    return `${String(ms)}ms`;
  }

  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function isPreparedContextHit(input: {
  readonly turnPlanningLatencyMs?: number | undefined;
  readonly contextBuildingLatencyMs?: number | undefined;
}): boolean {
  return (
    input.turnPlanningLatencyMs !== undefined &&
    input.contextBuildingLatencyMs !== undefined &&
    input.turnPlanningLatencyMs <= 50 &&
    input.contextBuildingLatencyMs <= 50
  );
}

function buildCompletionLabel(input: {
  readonly totalLatencyMs: number;
  readonly replyLatencyMs?: number | undefined;
  readonly preparedContextHit: boolean;
  readonly gateRewritten: boolean;
}): string {
  const parts = [`回复已生成`, `总 ${formatLatency(input.totalLatencyMs)}`];

  if (input.replyLatencyMs !== undefined) {
    parts.push(`生成 ${formatLatency(input.replyLatencyMs)}`);
  }
  if (input.preparedContextHit) {
    parts.push("预热命中");
  }
  if (input.gateRewritten) {
    parts.push("终稿经安全门调整");
  }

  return parts.join(" · ");
}

function toOutput(
  record: PreparedReplyRecord,
  timing:
    | {
        readonly totalLatencyMs: number;
        readonly replyLatencyMs?: number | undefined;
        readonly turnPlanningLatencyMs?: number | undefined;
        readonly contextBuildingLatencyMs?: number | undefined;
        readonly preparedContextHit: boolean;
      }
    | undefined = undefined,
  gateRewritten = false,
) {
  return {
    success: true,
    preparedReplyId: record.preparedReplyId,
    suggestedReply: record.suggestedReply,
    stage: record.stage,
    confidence: record.confidence,
    expiresAt: record.expiresAt,
    ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
    ...(timing !== undefined ? { timing } : {}),
    ...(gateRewritten ? { gateRewritten } : {}),
    ...(record.variantGroup?.state === "judge_ready"
      ? {
          replyVariantSelection: {
            groupId: record.variantGroup.groupId,
            options: record.variantGroup.options.map((option) => ({
              option: option.option,
              suggestedReply: option.suggestedReply,
              expiresAt: option.envelopeExp,
            })),
            findings: record.variantGroup.findings.map((finding) => ({
              code: finding.code,
              description: finding.description,
            })),
            rubricVersion: record.variantGroup.rubricVersion,
            rubricHash: record.variantGroup.rubricHash,
          },
        }
      : {}),
  };
}

function reorderReplyVariants(
  replyVariants: ReplyVariants,
  random: () => number,
): ReplyVariants["items"] {
  const first = replyVariants.items[0];
  const second = replyVariants.items[1];
  if (first === undefined || second === undefined) {
    return replyVariants.items;
  }
  return random() < 0.5 ? [second, first] : [first, second];
}

function buildNotLearnedVariantGroup(input: {
  readonly replyVariants: ReplyVariants;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly reason: PreparedReplyFallbackReason;
}): PreparedReplyVariantGroup {
  return {
    state: "not_learned",
    groupId: input.replyVariants.groupId,
    rubricVersion: input.replyVariants.rubricVersion,
    rubricHash: input.replyVariants.rubricHash,
    ...(input.replyVariants.feedbackExpiresAt !== undefined
      ? { feedbackExpiresAt: input.replyVariants.feedbackExpiresAt }
      : {}),
    target: {
      platform: "zhipin",
      tenantId: input.tenantId,
      conversationId: input.conversationId,
    },
    chosenVariant: "draft",
    reason: input.reason,
  };
}

function buildVariantGroup(input: {
  readonly replyVariants: ReplyVariants;
  readonly rubric: ReplyFeedbackRubricResponse;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly judgeContext: PreparedReplyJudgeContext;
  readonly random: () => number;
}): PreparedReplyVariantGroup {
  if (
    input.rubric.rubricVersion !== input.replyVariants.rubricVersion ||
    input.rubric.rubricHash !== input.replyVariants.rubricHash
  ) {
    return buildNotLearnedVariantGroup({
      ...input,
      reason: PreparedReplyFallbackReasons.RUBRIC_MISMATCH,
    });
  }

  const orderedItems = reorderReplyVariants(input.replyVariants, input.random);
  if (orderedItems.length !== 2) {
    return buildNotLearnedVariantGroup({
      ...input,
      reason: PreparedReplyFallbackReasons.INVALID_VARIANT_SHAPE,
    });
  }
  const variantKinds = new Set(orderedItems.map((item) => item.variant));
  if (!variantKinds.has("draft") || !variantKinds.has("revised")) {
    return buildNotLearnedVariantGroup({
      ...input,
      reason: PreparedReplyFallbackReasons.INVALID_VARIANT_SHAPE,
    });
  }

  const options = orderedItems.map((item, index) => ({
    option: PreparedReplyOptionValues[index] ?? "option_1",
    variant: item.variant,
    suggestedReply: item.suggestedReply,
    signedEnvelope: item.signedEnvelope,
    envelopeExp: item.envelopeExp,
  }));
  const recommendedOption =
    options.find((option) => option.variant === input.replyVariants.recommended)?.option ??
    "option_1";

  return {
    state: "judge_ready",
    groupId: input.replyVariants.groupId,
    options,
    findings: input.replyVariants.findings,
    rubricVersion: input.replyVariants.rubricVersion,
    rubricHash: input.replyVariants.rubricHash,
    ...(input.replyVariants.feedbackExpiresAt !== undefined
      ? { feedbackExpiresAt: input.replyVariants.feedbackExpiresAt }
      : {}),
    target: {
      platform: "zhipin",
      tenantId: input.tenantId,
      conversationId: input.conversationId,
    },
    recommendedOption,
    judgeContext: input.judgeContext,
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
    const diagnosticsState: ReplyPreviewDiagnosticsState = {
      startedAtMs: undefined,
      requestId: undefined,
      lastStartedPhase: undefined,
      activePhase: undefined,
      phaseLatencies: new Map<string, number>(),
    };

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      preview = deps.createReplyPreviewVisualSession(nativePage);
      await maybeBringToFront(nativePage);
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

      if (getLatestCandidateMessage(data.messages).length === 0) {
        const error = "未找到候选人最新消息，无法生成回复";
        await session.fail("候选人消息为空");
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
        reasoning: input.reasoning,
      });
      const unreadCountBeforeReply = resolveUnreadCountBeforeReply({
        navigationUnreadCount: nav?.unreadCount,
        data,
      });

      ctx.logger.info(
        `Generating reply preview for ${
          selectedTarget.candidateName || selectedTarget.candidateId
        }`,
      );
      const previewStartedAtMs = Date.now();
      diagnosticsState.startedAtMs = previewStartedAtMs;
      await preview.begin("正在生成回复");

      let draftText = "";
      let tenantId: string | undefined;
      let preparedRecord: PreparedReplyRecord | undefined;
      let timingSummary:
        | {
            readonly totalLatencyMs: number;
            readonly replyLatencyMs?: number | undefined;
            readonly turnPlanningLatencyMs?: number | undefined;
            readonly contextBuildingLatencyMs?: number | undefined;
            readonly preparedContextHit: boolean;
          }
        | undefined;
      let gateRewritten = false;

      for await (const event of deps.streamGenerateSignedReply(replyInput)) {
        if (event.type === "stream.started") {
          diagnosticsState.requestId = readEventString(event, "requestId");
          tenantId = readEventString(event, "tenantId");
        }

        if (event.type === "phase.started") {
          const phase = readEventString(event, "phase");
          if (phase !== undefined) {
            diagnosticsState.lastStartedPhase = phase;
            diagnosticsState.activePhase = phase;
          }
        }

        if (event.type === "phase.completed") {
          const phase = readEventString(event, "phase");
          const latencyMs = readEventNumber(event, "latencyMs");
          if (phase !== undefined && latencyMs !== undefined) {
            diagnosticsState.phaseLatencies.set(phase, Math.round(latencyMs));
            if (diagnosticsState.activePhase === phase) {
              diagnosticsState.activePhase = undefined;
            }
          }
        }

        if (event.type === "gate.completed" && readEventBoolean(event, "rewritten") === true) {
          gateRewritten = true;
        }

        const label = resolveProgressLabel(event);
        if (label !== undefined) {
          await preview.updateStatus(label);
        }

        if (event.type === "location.resolved") {
          const locationEvent = ReplyStreamLocationResolvedEventSchema.safeParse(event);
          if (locationEvent.success) {
            const serverLocationLabel = formatLocationSignalsVisualLabel({
              signals: locationEvent.data.signals,
              analysisPath: locationEvent.data.analysisPath,
              inquiryType: locationEvent.data.inquiryType,
            });
            if (serverLocationLabel.length > 0) {
              await preview.updateStatus(serverLocationLabel);
            }
          }
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
          const turnPlanningLatencyMs = diagnosticsState.phaseLatencies.get("turn_planning");
          const contextBuildingLatencyMs = diagnosticsState.phaseLatencies.get("context_building");
          const totalLatencyMs = Math.max(0, Math.round(Date.now() - previewStartedAtMs));
          const replyLatencyMs =
            finalReply.latencyMs !== undefined ? Math.round(finalReply.latencyMs) : undefined;
          const expiresAt =
            finalReply.replyVariants?.items.reduce(
              (minExpiresAt, item) => Math.min(minExpiresAt, item.envelopeExp),
              finalReply.envelopeExp,
            ) ?? finalReply.envelopeExp;
          const preparedContextHit = isPreparedContextHit({
            turnPlanningLatencyMs,
            contextBuildingLatencyMs,
          });
          timingSummary = {
            totalLatencyMs,
            ...(replyLatencyMs !== undefined ? { replyLatencyMs } : {}),
            ...(turnPlanningLatencyMs !== undefined ? { turnPlanningLatencyMs } : {}),
            ...(contextBuildingLatencyMs !== undefined ? { contextBuildingLatencyMs } : {}),
            preparedContextHit,
          };
          let variantGroup: PreparedReplyVariantGroup | undefined;
          if (finalReply.replyVariants !== undefined) {
            if (tenantId === undefined) {
              const error =
                "Reply Authority returned replyVariants without stream.started.tenantId; " +
                "refusing to create a sendable prepared reply without feedback identity.";
              ctx.logger.error(error);
              await preview.fail("双稿反馈身份缺失");
              return createFailure(error, undefined, buildFailureDiagnostics(diagnosticsState));
            } else {
              try {
                const rubric = await deps.fetchReplyFeedbackRubric({
                  tenantId,
                  rubricVersion: finalReply.replyVariants.rubricVersion,
                });
                variantGroup = buildVariantGroup({
                  replyVariants: finalReply.replyVariants,
                  rubric,
                  tenantId,
                  conversationId: selectedTarget.conversationId,
                  judgeContext: buildPreparedReplyJudgeContext(replyInput),
                  random: deps.random,
                });
                if (variantGroup.state === "not_learned") {
                  ctx.logger.warn(
                    `Reply variants will use a non-learning terminal outcome: ` +
                      `reason=${variantGroup.reason}`,
                  );
                }
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                ctx.logger.warn(
                  `Failed to fetch reply feedback rubric; using a non-learning terminal outcome. ` +
                    `reason=${PreparedReplyFallbackReasons.RUBRIC_FETCH_FAILED} detail=${detail}`,
                );
                variantGroup = buildNotLearnedVariantGroup({
                  replyVariants: finalReply.replyVariants,
                  tenantId,
                  conversationId: selectedTarget.conversationId,
                  reason: PreparedReplyFallbackReasons.RUBRIC_FETCH_FAILED,
                });
              }
            }
          }
          preparedRecord = deps.savePreparedReply({
            signedEnvelope: finalReply.signedEnvelope,
            suggestedReply: finalReply.suggestedReply,
            stage: finalReply.stage,
            confidence: finalReply.confidence,
            expiresAt,
            unreadCountBeforeReply,
            ...(diagnosticsState.requestId !== undefined
              ? { requestId: diagnosticsState.requestId }
              : {}),
            ...(variantGroup !== undefined ? { variantGroup } : {}),
          });
          await preview.complete(
            buildCompletionLabel({ ...timingSummary, gateRewritten }),
            finalReply.suggestedReply,
            variantGroup?.state === "judge_ready"
              ? {
                  options: variantGroup.options.map((option) => ({
                    option: option.option,
                    suggestedReply: option.suggestedReply,
                  })),
                  findings: variantGroup.findings,
                }
              : undefined,
          );
        }
      }

      if (preparedRecord === undefined) {
        const error = "Reply Authority stream 未返回 final";
        await preview.fail(error);
        return createFailure(error, undefined, buildFailureDiagnostics(diagnosticsState));
      }

      return toOutput(preparedRecord, timingSummary, gateRewritten);
    } catch (error) {
      rethrowStructuredToolError(error);
      const failure = classifyReplyPreviewError(error);
      const diagnostics = buildFailureDiagnostics(diagnosticsState, error);
      await preview?.fail(failure.message);
      await session?.fail(failure.message);
      return createFailure(failure.message, failure.errorKind, diagnostics);
    } finally {
      nativePage?.close();
    }
  },
});
