import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { getActiveChatPanel, getSelectedChatTarget } from "../pages/zhipin/chat-target.ts";
import { ensureChatOpen } from "../pages/zhipin/chat-navigation.ts";
import { resolveConversationSignals } from "../pages/zhipin/job-signals.ts";

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

    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");

    // 如果指定了候选人，先导航到对应聊天
    const nav = await ensureChatOpen(ctxManager, page, {
      conversationId: input.conversationId,
      candidateName: input.candidateName,
      index: input.index,
    });
    if (nav && !nav.found) {
      return buildFailureResult(nav.error ?? "打开聊天失败");
    }

    ctx.logger.info(`Extracting candidate info${nav ? ` for ${nav.name}` : " (current window)"}`);
    const activePage = await ctxManager.getPage("zhipin");
    const expectedName = nav?.name ?? input.candidateName ?? "";
    const activePanel = await getActiveChatPanel(activePage);
    if (expectedName.length > 0 && (!activePanel || !namesCompatible(expectedName, activePanel.candidateName))) {
      return buildFailureResult(`右侧聊天面板未切换到 ${expectedName}`);
    }

    const selectedTarget = await getSelectedChatTarget(activePage);
    if (!selectedTarget) {
      return buildFailureResult("未能提取当前选中聊天的 conversationId/candidateId");
    }
    if (nav && selectedTarget.conversationId !== nav.conversationId) {
      return buildFailureResult(`当前选中会话与目标会话不一致: ${nav.name || nav.conversationId}`);
    }
    if (
      activePanel &&
      selectedTarget.candidateName.length > 0 &&
      !namesCompatible(selectedTarget.candidateName, activePanel.candidateName)
    ) {
      return buildFailureResult(
        `左侧选中会话与右侧聊天面板不一致: ${selectedTarget.candidateName} / ${activePanel.candidateName}`,
      );
    }

    // 等待聊天消息加载（DOM: .conversation-message > .chat-message-list > .message-item）
    try {
      await activePage.waitForSelector(
        ".chat-message-list .message-item, .conversation-message .message-item",
        { timeout: 8_000 },
      );
    } catch {
      // 可能是空对话（无消息），继续提取 candidateInfo
    }

    const data = await activePage.evaluate((maxMsgs: number) => {
      const conversationRoot =
        document.querySelector(".chat-conversation") ??
        document.querySelector(".conversation-box") ??
        document;

      // ===== Candidate Info =====
      // 限定到聊天头部的详情区域，避免匹配左侧列表
      const detailArea = conversationRoot.querySelector(
        ".base-info-single-detial, .base-info-content, .base-info-single-container",
      );
      const name =
        detailArea
          ?.querySelector(".name-box, .base-name, .chat-user-name, .geek-name")
          ?.textContent?.trim() ?? "";

      const infoItems = detailArea
        ? detailArea.querySelectorAll(":scope > div")
        : conversationRoot.querySelectorAll(".geek-info-item, .base-info-item");
      const infoTexts: string[] = [];
      infoItems.forEach((el) => {
        const t = el.textContent?.trim();
        if (t) infoTexts.push(t);
      });
      const fullInfo = infoTexts.join(" ");

      const ageMatch = fullInfo.match(/(\d{2,3})岁/);
      const age = ageMatch ? ageMatch[1] + "岁" : "";
      const expMatch = fullInfo.match(/(\d+年(?:以上)?|应届生|在校生)/);
      const experience = expMatch?.[1] ?? "";
      const education = fullInfo.match(/(初中|高中|中专|大专|本科|硕士|博士)/)?.[1] ?? "";

      let communicationPosition = "";
      const posNameEl = conversationRoot.querySelector(".position-name");
      if (posNameEl) {
        const cloned = posNameEl.cloneNode(true) as HTMLElement;
        cloned.querySelectorAll(".popover-wrap, .tooltip-job").forEach((e) => e.remove());
        communicationPosition = cloned.textContent?.trim() ?? "";
      }

      let expectedJobText = "";
      const expectValue = conversationRoot.querySelector(".position-item.expect .value.job");
      if (expectValue) {
        expectedJobText = expectValue.textContent?.trim() ?? "";
      }
      const expectedSalary =
        conversationRoot
          .querySelector(".position-item.expect .high-light-orange")
          ?.textContent?.trim() ??
        "";

      // tags 只取详情区域内的标签，排除沟通职位区域的 .high-light-boss
      const tags: string[] = [];
      if (detailArea) {
        detailArea.querySelectorAll(".geek-tag, .base-info-item .high-light-boss").forEach((el) => {
          const t = el.textContent?.trim();
          // 过滤掉沟通职位文本（通常很长且包含"更换职位"）
          if (t && !t.includes("更换职位") && t.length < 20) tags.push(t);
        });
      }

      // ===== Chat Messages =====
      // 实际 DOM: .conversation-message > .chat-message-list > .message-item
      // 直接查 .chat-message-list 的直接子 .message-item，跳过中间层
      const msgItems = conversationRoot.querySelectorAll(
        ".chat-message-list > .message-item, .conversation-message .message-item",
      );
      const timeRegex = /\d{1,2}:\d{2}(?::\d{2})?|\d{4}-\d{2}-\d{2}/;

      type Msg = {
        index: number;
        sender: "candidate" | "recruiter" | "system";
        messageType: "text" | "system" | "resume" | "wechat-exchange";
        content: string;
        time: string;
      };
      const messages: Msg[] = [];
      let msgIdx = 0;

      msgItems.forEach((item) => {
        if (msgIdx >= maxMsgs) return;

        // 从子元素判断消息类型（.message-item 本身只是包装层）
        const hasFriend = item.querySelector(".item-friend") !== null;
        const hasMyself = item.querySelector(".item-myself") !== null;
        const hasSystem = item.querySelector(".item-system") !== null;
        const hasResume = item.querySelector(".item-resume") !== null;
        const hasDialog = item.querySelector(".message-dialog-center") !== null;

        let sender: Msg["sender"] = "system";
        let messageType: Msg["messageType"] = "text";

        if (hasFriend) {
          sender = "candidate";
        } else if (hasMyself) {
          sender = "recruiter";
        } else if (hasSystem || hasDialog) {
          sender = "system";
          messageType = "system";
        }
        if (hasResume) messageType = "resume";

        // 微信交换卡片检测
        const cardEl = item.querySelector(".message-card-top-wrap, [class*='d-top-text']");
        if (cardEl) {
          const cardText = cardEl.textContent ?? "";
          if (cardText.includes("微信") || cardText.includes("WeChat")) {
            messageType = "wechat-exchange";
          }
        }

        // 时间
        const timeEl = item.querySelector(".message-time .time, .message-time");
        const timeMatch = (timeEl?.textContent ?? "").match(timeRegex);
        const time = timeMatch ? timeMatch[0] : "";

        // 内容提取 — 按消息类型使用不同选择器
        let content = "";
        if (messageType === "wechat-exchange" && cardEl) {
          const ct = cardEl.textContent ?? "";
          const digitMatch = ct.match(/\b(\d{8,15})\b/);
          const wxMatch = ct.match(/微信[：:号]*\s*([a-zA-Z0-9_-]{5,20})/);
          if (digitMatch) content = `[微信号: ${digitMatch[1]}]`;
          else if (wxMatch) content = `[微信号: ${wxMatch[1]}]`;
          else content = "[交换微信]";
        } else if (cardEl) {
          // 系统卡片：提取标题和描述
          const titleEl = item.querySelector(".message-card-top-title");
          const descEl = item.querySelector(".dialog-content, .message-card-top-text");
          content = (titleEl?.textContent?.trim() ?? descEl?.textContent?.trim() ?? "").trim();
        } else {
          // 普通文本消息
          const textEl = item.querySelector(".text span, .text-content, .text");
          if (textEl) {
            content = (textEl.textContent?.trim() ?? "")
              .replace(timeRegex, "")
              .replace("已读", "")
              .trim();
          }
        }

        if (content || messageType !== "text") {
          messages.push({ index: msgIdx, sender, messageType, content, time });
          msgIdx++;
        }
      });

      return {
        candidateInfo: {
          name,
          age,
          experience,
          education,
          communicationPosition,
          expectedJobText,
          expectedSalary,
          tags,
        },
        messages,
      };
    }, maxMessages);

    const signals = resolveConversationSignals({
      communicationPosition: data.candidateInfo.communicationPosition,
      expectedJobText: data.candidateInfo.expectedJobText,
    });

    // formattedHistory 只保留 candidate + recruiter 对话，过滤系统消息噪音
    const formattedHistory = data.messages
      .filter((m) => m.sender === "candidate" || m.sender === "recruiter")
      .map((m) => {
        const prefix = m.sender === "candidate" ? "求职者" : "我";
        return `${prefix}: ${m.content}`;
      });

    const stats = {
      totalMessages: data.messages.length,
      candidateMessages: data.messages.filter((m) => m.sender === "candidate").length,
      recruiterMessages: data.messages.filter((m) => m.sender === "recruiter").length,
      systemMessages: data.messages.filter((m) => m.sender === "system").length,
    };

    ctx.logger.info(
      `Extracted info for ${data.candidateInfo.name}: ${stats.totalMessages} messages`,
    );
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
        tags: data.candidateInfo.tags,
      },
      ...(signals.preferredBrand !== undefined ? { preferredBrand: signals.preferredBrand } : {}),
      chatMessages: data.messages,
      formattedHistory,
      stats,
    };
  },
});
