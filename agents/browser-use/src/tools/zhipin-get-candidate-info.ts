import { defineTool } from "@roll-agent/sdk";
import {
  CandidateLocationSignalSchema,
  prepareReplyContext,
  ReplyAuthorityRequestError,
  type PrepareReplyContextInput,
} from "@roll-agent/reply-authority-client";
import { z } from "zod";
import { NativeVisualActivitySession } from "../native-visual-activity-session.ts";
import { resolveConversationSignals } from "../pages/zhipin/job-signals.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { rethrowStructuredToolError } from "../pages/zhipin/risk-page.ts";
import type {
  NativeCandidateChatDetails,
  NativeSelectedChatTarget,
  ZhipinNativePagePort,
} from "../pages/zhipin/native-page.ts";
import { pickBestUsername } from "../pages/zhipin/username.ts";
import { recordZhipinWechatCompletedEvents } from "../recruitment-events/zhipin-events.ts";

const ChatMessageSchema = z.object({
  index: z.number(),
  sender: z.enum(["candidate", "recruiter", "system"]),
  messageType: z.enum(["text", "system", "resume", "wechat-exchange"]),
  content: z.string(),
  time: z.string(),
});

const CandidateInfoSchema = z.object({
  name: z.string(),
  age: z.string(),
  experience: z.string(),
  education: z.string(),
  communicationPosition: z.string(),
  expectedPosition: z.string(),
  expectedLocation: z.string(),
  expectedSalary: z.string(),
  tags: z.array(z.string()),
});

const OutputSchema = z.object({
  success: z.boolean(),
  conversationId: z.string(),
  candidateId: z.string(),
  candidateInfo: CandidateInfoSchema,
  preferredBrand: z.string().optional(),
  preferredBrandId: z.number().int().positive().optional(),
  locationSignals: z
    .array(CandidateLocationSignalSchema)
    .describe("已废弃：地点证据改由 Reply Authority 服务端提取，此字段恒为空数组，仅为兼容保留"),
  chatMessages: z.array(ChatMessageSchema),
  formattedHistory: z.array(z.string()),
  stats: z.object({
    totalMessages: z.number(),
    candidateMessages: z.number(),
    recruiterMessages: z.number(),
    systemMessages: z.number(),
  }),
  error: z.string().optional(),
});

function emptyCandidateInfo() {
  return {
    name: "",
    age: "",
    experience: "",
    education: "",
    communicationPosition: "",
    expectedPosition: "",
    expectedLocation: "",
    expectedSalary: "",
    tags: [] as string[],
  };
}

function buildFailureResult(error: string) {
  return {
    success: false,
    conversationId: "",
    candidateId: "",
    candidateInfo: emptyCandidateInfo(),
    locationSignals: [],
    chatMessages: [],
    formattedHistory: [],
    stats: { totalMessages: 0, candidateMessages: 0, recruiterMessages: 0, systemMessages: 0 },
    error,
  };
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

type NativeVisualActivitySessionLike = Pick<
  NativeVisualActivitySession,
  "begin" | "highlightSelector" | "succeed" | "fail"
>;

type ZhipinGetCandidateInfoDeps = {
  readonly openNativePagePort: typeof openZhipinNativePagePort;
  readonly createNativeVisualActivitySession: (
    page: ZhipinNativePagePort,
  ) => NativeVisualActivitySessionLike;
  readonly prepareReplyContext: typeof prepareReplyContext;
};

let zhipinGetCandidateInfoDepsOverride: Partial<ZhipinGetCandidateInfoDeps> | undefined;

function getZhipinGetCandidateInfoDeps(): ZhipinGetCandidateInfoDeps {
  return {
    openNativePagePort: openZhipinNativePagePort,
    createNativeVisualActivitySession: (page) => new NativeVisualActivitySession(page),
    prepareReplyContext,
    ...zhipinGetCandidateInfoDepsOverride,
  };
}

function buildFormattedHistory(messages: NativeCandidateChatDetails["messages"]): string[] {
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

function buildPrepareReplyContextInput(input: {
  readonly data: NativeCandidateChatDetails;
  readonly selectedTarget: NativeSelectedChatTarget;
  readonly recruiterUsername: string;
  readonly formattedHistory: readonly string[];
  readonly communicationPosition: string;
  readonly expectedPosition: string;
  readonly expectedLocation: string;
  readonly preferredBrand?: string | undefined;
  readonly preferredBrandId?: number | undefined;
}): PrepareReplyContextInput {
  return {
    candidateMessage: getLatestCandidateMessage(input.data.messages),
    conversationHistory: [...input.formattedHistory],
    candidateInfo: {
      name: input.data.candidateInfo.name,
      age: input.data.candidateInfo.age,
      experience: input.data.candidateInfo.experience,
      education: input.data.candidateInfo.education,
      communicationPosition: input.communicationPosition,
      expectedPosition: input.expectedPosition,
      expectedLocation: input.expectedLocation,
      expectedSalary: input.data.candidateInfo.expectedSalary,
      info: [...input.data.candidateInfo.tags],
    },
    ...(input.preferredBrand !== undefined ? { preferredBrand: input.preferredBrand } : {}),
    ...(input.preferredBrandId !== undefined ? { preferredBrandId: input.preferredBrandId } : {}),
    target: {
      platform: "zhipin",
      conversationId: input.selectedTarget.conversationId,
      candidateId: input.selectedTarget.candidateId,
      recruiterUsername: input.recruiterUsername,
    },
  };
}

const PREPARE_COOLDOWN_MS = 10 * 60_000;
let prepareCooldownUntilMs = 0;

export function resetPrepareReplyContextCooldownForTests(): void {
  prepareCooldownUntilMs = 0;
}

function isPersistentPrepareError(error: unknown): boolean {
  if (error instanceof ReplyAuthorityRequestError) {
    return error.statusCode === 403;
  }
  return error instanceof Error && error.message.includes("未配置");
}

function recordPrepareFailure(error: unknown): void {
  if (isPersistentPrepareError(error)) {
    prepareCooldownUntilMs = Date.now() + PREPARE_COOLDOWN_MS;
  }
}

async function startReplyContextPreparation(input: {
  readonly nativePage: ZhipinNativePagePort;
  readonly deps: ZhipinGetCandidateInfoDeps;
  readonly data: NativeCandidateChatDetails;
  readonly selectedTarget: NativeSelectedChatTarget;
  readonly formattedHistory: readonly string[];
  readonly communicationPosition: string;
  readonly expectedPosition: string;
  readonly expectedLocation: string;
  readonly preferredBrand?: string | undefined;
  readonly preferredBrandId?: number | undefined;
  readonly logger: {
    readonly debug: (message: string) => void;
    readonly info: (message: string) => void;
  };
}): Promise<void> {
  if (Date.now() < prepareCooldownUntilMs) {
    input.logger.debug("Skip Reply Authority prepare: cooling down after a persistent failure.");
    return;
  }

  const candidateMessage = getLatestCandidateMessage(input.data.messages);
  if (candidateMessage.length === 0) {
    input.logger.debug("Skip Reply Authority prepare: latest candidate message is empty.");
    return;
  }

  let usernameResult: ReturnType<typeof pickBestUsername>;
  try {
    usernameResult = pickBestUsername(await input.nativePage.readUsernameEvidence());
  } catch (error) {
    input.logger.debug(
      `Skip Reply Authority prepare: recruiter username read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  if (!usernameResult.found) {
    input.logger.debug("Skip Reply Authority prepare: recruiter username was not detected.");
    return;
  }

  const prepareInput = buildPrepareReplyContextInput({
    data: input.data,
    selectedTarget: input.selectedTarget,
    recruiterUsername: usernameResult.username,
    formattedHistory: input.formattedHistory,
    communicationPosition: input.communicationPosition,
    expectedPosition: input.expectedPosition,
    expectedLocation: input.expectedLocation,
    preferredBrand: input.preferredBrand,
    preferredBrandId: input.preferredBrandId,
  });

  const startedAtMs = Date.now();
  try {
    const preparePromise = input.deps.prepareReplyContext(prepareInput);
    preparePromise
      .then((response) => {
        input.logger.info(
          `Reply Authority prepare ${response.status} for ${input.selectedTarget.conversationId} in ${String(
            Date.now() - startedAtMs,
          )}ms`,
        );
      })
      .catch((error: unknown) => {
        recordPrepareFailure(error);
        input.logger.debug(
          `Reply Authority prepare skipped or failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  } catch (error) {
    recordPrepareFailure(error);
    input.logger.debug(
      `Reply Authority prepare failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function setZhipinGetCandidateInfoDepsForTests(
  override: Partial<ZhipinGetCandidateInfoDeps> | undefined,
): void {
  zhipinGetCandidateInfoDepsOverride = override;
}

export const zhipinGetCandidateInfo = defineTool({
  name: "zhipin_get_candidate_info",
  description:
    "提取候选人资料和完整聊天记录。可指定 conversationId 或 candidateName 自动打开对应聊天；若已从 `zhipin_read_messages` 获取 conversationId，优先传它。",
  input: z.object({
    conversationId: z
      .string()
      .optional()
      .describe("会话 ID。若已从 `zhipin_read_messages` 获取，优先传这个，最稳定"),
    candidateName: z
      .string()
      .optional()
      .describe("候选人姓名。若用户说“查看鲁倩的聊天详情”，这里应提取为“鲁倩”"),
    index: z.number().optional().describe("候选人在列表中的索引（可选，仅兜底）"),
    maxMessages: z.number().default(100).describe("最多返回的消息条数"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const maxMessages = input.maxMessages ?? 100;
    const deps = getZhipinGetCandidateInfoDeps();
    const hasNavigationTarget =
      input.conversationId !== undefined ||
      input.candidateName !== undefined ||
      input.index !== undefined;
    let nativePage: ZhipinNativePagePort | undefined;
    let session: NativeVisualActivitySessionLike | undefined;
    const openLabel = hasNavigationTarget ? "正在打开目标聊天" : "正在准备当前聊天";
    const extractLabel = "正在提取聊天记录";
    const fail = async (label: string, error: string) => {
      await session?.fail(label);
      return buildFailureResult(error);
    };

    try {
      nativePage = await deps.openNativePagePort();
      session = deps.createNativeVisualActivitySession(nativePage);
      await session.begin(openLabel);

      const nav = hasNavigationTarget
        ? await nativePage.openChat({
            conversationId: input.conversationId,
            candidateName: input.candidateName,
            index: input.index,
            maxScrolls: 4,
          })
        : undefined;

      if (nav !== undefined && !nav.found) {
        return await fail("打开聊天失败", nav.error ?? "打开聊天失败");
      }
      if (nav === undefined && !(await nativePage.isChatSurfaceOpen().catch(() => false))) {
        return await fail("当前不是沟通页", "当前页面不是 BOSS 沟通页，无法读取当前聊天详情");
      }

      ctx.logger.info(
        `Extracting candidate info${nav !== undefined ? ` for ${nav.name}` : " (current window)"}`,
      );
      await session.begin(extractLabel);
      await session.highlightSelector(
        ".chat-conversation, .conversation-box, .conversation-message",
        { label: extractLabel, padding: 12 },
      );

      const expectedName = nav?.name ?? input.candidateName ?? "";
      const activePanel = await nativePage.readActiveChatPanel();
      if (
        expectedName.length > 0 &&
        (!activePanel || !namesCompatible(expectedName, activePanel.candidateName))
      ) {
        return await fail("聊天面板未同步", `右侧聊天面板未切换到 ${expectedName}`);
      }

      const selectedTarget = await nativePage.readSelectedChatTarget();
      if (!selectedTarget) {
        return await fail("未识别当前会话", "未能提取当前选中聊天的 conversationId/candidateId");
      }
      const selectedTargetMatchesNav =
        nav === undefined ||
        (nav.conversationId.length > 0 && selectedTarget.conversationId === nav.conversationId) ||
        (nav.conversationId.length === 0 &&
          nav.candidateId.length > 0 &&
          selectedTarget.candidateId === nav.candidateId);
      if (!selectedTargetMatchesNav) {
        return await fail(
          "当前会话不一致",
          `当前选中会话与目标会话不一致: ${nav?.name || nav?.conversationId || ""}`,
        );
      }
      if (
        activePanel &&
        selectedTarget.candidateName.length > 0 &&
        !namesCompatible(selectedTarget.candidateName, activePanel.candidateName)
      ) {
        return await fail(
          "左右面板不一致",
          `左侧选中会话与右侧聊天面板不一致: ${selectedTarget.candidateName} / ${activePanel.candidateName}`,
        );
      }

      await nativePage.waitForChatMessages();
      const data: NativeCandidateChatDetails =
        await nativePage.readCandidateChatDetails(maxMessages);

      const signals = resolveConversationSignals({
        communicationPosition: data.candidateInfo.communicationPosition,
        expectedJobText: data.candidateInfo.expectedJobText,
      });

      // formattedHistory 只保留 candidate + recruiter 对话，过滤系统消息噪音
      const formattedHistory = buildFormattedHistory(data.messages);

      const stats = {
        totalMessages: data.messages.length,
        candidateMessages: data.messages.filter((m) => m.sender === "candidate").length,
        recruiterMessages: data.messages.filter((m) => m.sender === "recruiter").length,
        systemMessages: data.messages.filter((m) => m.sender === "system").length,
      };

      await session.succeed(`已提取 ${stats.totalMessages} 条聊天记录`);

      ctx.logger.info(
        `Extracted info for ${data.candidateInfo.name}: ${stats.totalMessages} messages`,
      );
      recordZhipinWechatCompletedEvents(
        data,
        selectedTarget.conversationId,
        selectedTarget.candidateId,
        ctx.logger,
      );
      await startReplyContextPreparation({
        nativePage,
        deps,
        data,
        selectedTarget,
        formattedHistory,
        communicationPosition: signals.communicationPosition,
        expectedPosition: signals.expectedPosition,
        expectedLocation: signals.expectedLocation,
        preferredBrand: signals.preferredBrand,
        preferredBrandId: signals.preferredBrandId,
        logger: ctx.logger,
      });

      return {
        success: true,
        conversationId: selectedTarget.conversationId,
        candidateId: selectedTarget.candidateId,
        candidateInfo: {
          name: data.candidateInfo.name,
          age: data.candidateInfo.age,
          experience: data.candidateInfo.experience,
          education: data.candidateInfo.education,
          communicationPosition: signals.communicationPosition,
          expectedPosition: signals.expectedPosition,
          expectedLocation: signals.expectedLocation,
          expectedSalary: data.candidateInfo.expectedSalary,
          tags: [...data.candidateInfo.tags],
        },
        ...(signals.preferredBrand !== undefined ? { preferredBrand: signals.preferredBrand } : {}),
        ...(signals.preferredBrandId !== undefined
          ? { preferredBrandId: signals.preferredBrandId }
          : {}),
        locationSignals: [],
        chatMessages: [...data.messages],
        formattedHistory,
        stats,
      };
    } catch (error) {
      rethrowStructuredToolError(error);
      await session?.fail("提取聊天记录失败");
      ctx.logger.warn(
        `Native zhipin candidate info read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return buildFailureResult(error instanceof Error ? error.message : "提取聊天记录失败");
    } finally {
      nativePage?.close();
    }
  },
});
