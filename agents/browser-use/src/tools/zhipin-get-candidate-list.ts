import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getRecommendTarget, waitForRecommendList } from "../pages/zhipin/recommend-list.ts";
import { getZhipinListSurfaceConfig } from "../pages/zhipin/list-surfaces.ts";
import {
  collectDynamicListItems,
  DYNAMIC_LIST_COLLECTION_STOP_REASONS,
} from "../pages/shared/dynamic-list-scroller.ts";
import { getContextManager } from "../runtime-holder.ts";
import { VisualActivitySession } from "../visual-activity-session.ts";

const CandidateCardSchema = z.object({
  index: z.number(),
  candidateId: z.string(),
  name: z.string(),
  age: z.string(),
  experience: z.string(),
  education: z.string(),
  workStatus: z.string(),
  company: z.string(),
  currentPosition: z.string(),
  expectedLocation: z.string(),
  expectedPosition: z.string(),
  expectedSalary: z.string(),
  tags: z.array(z.string()),
  buttonText: z.string(),
});

const ScrollStatsSchema = z.object({
  containerLabel: z.string(),
  stepsRequested: z.number(),
  stepsCompleted: z.number(),
  reachedBoundary: z.boolean(),
  stopReason: z.enum(DYNAMIC_LIST_COLLECTION_STOP_REASONS),
  uniqueCount: z.number(),
  duplicateCount: z.number(),
  noNewRounds: z.number(),
  beforeItemCount: z.number(),
  afterItemCount: z.number(),
  beforeScrollHeight: z.number(),
  afterScrollHeight: z.number(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  candidates: z.array(CandidateCardSchema),
  total: z.number(),
  scrollStats: ScrollStatsSchema.optional(),
  error: z.string().optional(),
});

type CandidateCard = z.infer<typeof CandidateCardSchema>;
type ScrollStats = z.infer<typeof ScrollStatsSchema>;
type RecommendTarget = ReturnType<typeof getRecommendTarget>;
type VisualActivitySessionLike = Pick<
  VisualActivitySession,
  "begin" | "highlightSelector" | "succeed" | "fail" | "retarget"
>;
type ZhipinGetCandidateListDeps = {
  readonly getContextManager: typeof getContextManager;
  readonly getRecommendTarget: typeof getRecommendTarget;
  readonly waitForRecommendList: typeof waitForRecommendList;
  readonly createVisualActivitySession: (target: RecommendTarget) => VisualActivitySessionLike;
};

let zhipinGetCandidateListDepsOverride: Partial<ZhipinGetCandidateListDeps> | undefined;

function getZhipinGetCandidateListDeps(): ZhipinGetCandidateListDeps {
  return {
    getContextManager,
    getRecommendTarget,
    waitForRecommendList,
    createVisualActivitySession: (target) => new VisualActivitySession(target),
    ...zhipinGetCandidateListDepsOverride,
  };
}

export function setZhipinGetCandidateListDepsForTests(
  override: Partial<ZhipinGetCandidateListDeps> | undefined,
): void {
  zhipinGetCandidateListDepsOverride = override;
}

async function readVisibleRecommendCandidates(target: RecommendTarget): Promise<CandidateCard[]> {
  return await target.evaluate(() => {
    // 优先用 .candidate-card-wrap（按钮在这一层），fallback 到 [data-geek]
    let items = Array.from(document.querySelectorAll(".candidate-card-wrap"));
    if (items.length === 0) {
      // fallback: 直接用 card-inner[data-geek]
      items = Array.from(document.querySelectorAll("[data-geek], .geek-item"));
    }
    const result: CandidateCard[] = [];

    items.forEach((item, idx) => {
      // candidateId 可能在自身或子元素 .card-inner 上
      const candidateId =
        item.getAttribute("data-geek") ??
        item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
        "";
      const name = item.querySelector(".name")?.textContent?.trim() ?? "";

      // base-info 解析 — join-text-wrap 的分隔符由 CSS 伪元素渲染
      // 实际 DOM: <div class="base-info join-text-wrap"><span>47岁</span><span>10年以上</span>...</div>
      let age = "";
      let experience = "";
      let education = "";
      let workStatus = "";
      const baseInfoEl = item.querySelector(".base-info.join-text-wrap, .base-info");
      if (baseInfoEl) {
        const textParts: string[] = [];

        // 策略 1: 遍历子元素（span 等），每个子元素是一个独立字段
        const children = baseInfoEl.querySelectorAll(":scope > *");
        children.forEach((child) => {
          const t = child.textContent?.trim();
          if (t) textParts.push(t);
        });

        // 策略 2: 子元素为空时，尝试文本节点
        if (textParts.length <= 1) {
          textParts.length = 0;
          baseInfoEl.childNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              const t = node.textContent?.trim();
              if (t) textParts.push(t);
            }
          });
        }

        // 策略 3: 仍为空时，整体 textContent 按分隔符切割
        if (textParts.length <= 1) {
          const fullText = baseInfoEl.textContent?.trim() ?? "";
          textParts.length = 0;
          fullText.split(/[丨·|]/).forEach((s) => {
            const t = s.trim();
            if (t) textParts.push(t);
          });
        }

        for (const p of textParts) {
          if (!age && p.includes("岁")) {
            age = p;
          } else if (
            !experience &&
            (p.includes("年") || p.includes("应届") || p.includes("在校"))
          ) {
            experience = p;
          } else if (!education && /(初中|高中|中专|中技|大专|本科|硕士|博士)/.test(p)) {
            education = p;
          } else if (!workStatus && /(在职|离职|在校)/.test(p)) {
            workStatus = p;
          }
        }
      }

      // 工作经历
      const workExpEl =
        item.querySelector(".timeline-wrap.work-exps .content.join-text-wrap") ??
        item.querySelector(".timeline-wrap.work-exps .content");
      const workText = workExpEl?.textContent?.trim() ?? "";
      const workParts = workText.split("·").map((s) => s.trim());
      const company = workParts[0] ?? "";
      const currentPosition = workParts[1] ?? "";

      // 期望信息 — 兼容新版 .row-flex 和旧版 .timeline-wrap.expect
      let expectedLocation = "";
      let expectedPosition = "";
      const expectRow = item.querySelector(".row-flex:not(.geek-desc)");
      if (expectRow) {
        const labelEl = expectRow.querySelector(".label");
        const contentEl = expectRow.querySelector(".content");
        const labelText = labelEl?.textContent ?? "";
        if ((labelText.includes("期望") || labelText.includes("最近关注")) && contentEl) {
          const parts = (contentEl.textContent?.trim() ?? "")
            .split("·")
            .map((s) => s.trim());
          expectedLocation = parts[0] ?? "";
          expectedPosition = parts[1] ?? "";
        }
      }
      if (!expectedLocation) {
        const expectEl =
          item.querySelector(".timeline-wrap.expect .content.join-text-wrap") ??
          item.querySelector(".timeline-wrap.expect .content");
        if (expectEl) {
          const parts = (expectEl.textContent?.trim() ?? "").split("·").map((s) => s.trim());
          expectedLocation = parts[0] ?? "";
          expectedPosition = parts[1] ?? "";
        }
      }

      const expectedSalary = item.querySelector(".salary-wrap")?.textContent?.trim() ?? "";

      const tags: string[] = [];
      item.querySelectorAll(".tags-wrap .tag-item, .tags-wrap .tag, .tags-wrap span").forEach(
        (t) => {
          const text = t.textContent?.trim();
          if (text) tags.push(text);
        },
      );

      // 按钮在 .candidate-card-wrap 层
      const buttonText = item.querySelector("button.btn.btn-greet")?.textContent?.trim() ?? "";

      result.push({
        index: idx,
        candidateId,
        name,
        age,
        experience,
        education,
        workStatus,
        company,
        currentPosition,
        expectedLocation,
        expectedPosition,
        expectedSalary,
        tags,
        buttonText,
      });
    });
    return result;
  });
}

function getCandidateKey(candidate: CandidateCard): string | undefined {
  if (candidate.candidateId.length > 0) return candidate.candidateId;
  if (candidate.name.length === 0) return undefined;
  return [
    candidate.name,
    candidate.age,
    candidate.experience,
    candidate.expectedLocation,
    candidate.expectedPosition,
    candidate.expectedSalary,
  ].join("|");
}

export const zhipinGetCandidateList = defineTool({
  name: "zhipin_get_candidate_list",
  description: "获取推荐列表页的候选人卡片信息",
  input: z.object({
    maxResults: z.number().optional().describe("最多返回条数"),
    autoScroll: z.boolean().default(true).describe("是否自动向下滚动动态列表并合并采集结果"),
    maxScrolls: z.number().int().min(0).max(50).default(4).describe("自动滚动的最大步数"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info("Getting candidate list from recommend page");

    const deps = getZhipinGetCandidateListDeps();
    const ctxManager = deps.getContextManager();
    const page = await ctxManager.getPage("zhipin");
    let target = deps.getRecommendTarget(page);
    const session = deps.createVisualActivitySession(target);

    await session.begin("正在打开推荐列表");

    const listReady = await deps.waitForRecommendList(target);
    target = deps.getRecommendTarget(page);
    await session.retarget(target);
    if (!listReady) {
      await session.fail("推荐列表未加载");
      return { success: false, candidates: [], total: 0, error: "推荐列表未加载" };
    }

    try {
      const readLabel = "正在读取推荐列表";
      await session.begin(readLabel);
      await session.highlightSelector(".candidate-card-wrap, [data-geek], .geek-item", {
        label: readLabel,
        padding: 8,
      });

      const autoScroll = input.autoScroll ?? true;
      const maxScrolls = input.maxScrolls ?? 4;
      let scrollStats: ScrollStats | undefined;
      let candidates: CandidateCard[];
      if (autoScroll && maxScrolls > 0) {
        const collection = await collectDynamicListItems(
          target,
          getZhipinListSurfaceConfig("recommend-list"),
          () => readVisibleRecommendCandidates(target),
          getCandidateKey,
          {
            direction: "down",
            steps: maxScrolls,
            settleMs: 900,
            maxNoNewRounds: 4,
            boundaryLoadRetries: 4,
            boundarySettleMs: 1_200,
            ...(input.maxResults !== undefined ? { targetCount: input.maxResults } : {}),
          },
        );
        candidates = [...collection.items];
        scrollStats = {
          containerLabel: collection.after.containerLabel,
          stepsRequested: collection.stepsRequested,
          stepsCompleted: collection.stepsCompleted,
          reachedBoundary: collection.reachedBoundary,
          stopReason: collection.stopReason,
          uniqueCount: collection.uniqueCount,
          duplicateCount: collection.duplicateCount,
          noNewRounds: collection.noNewRounds,
          beforeItemCount: collection.before.itemCount,
          afterItemCount: collection.after.itemCount,
          beforeScrollHeight: collection.before.scrollHeight,
          afterScrollHeight: collection.after.scrollHeight,
        };
      } else {
        candidates = await readVisibleRecommendCandidates(target);
      }

      const limitedCandidates =
        input.maxResults !== undefined ? candidates.slice(0, input.maxResults) : candidates;

      await session.succeed(`已读取 ${limitedCandidates.length} 位候选人`);
      ctx.logger.info(
        `Found ${limitedCandidates.length} candidates in recommend list` +
          (scrollStats ? `, scroll stop: ${scrollStats.stopReason}` : ""),
      );
      return {
        success: true,
        candidates: limitedCandidates,
        total: limitedCandidates.length,
        ...(scrollStats !== undefined ? { scrollStats } : {}),
      };
    } catch (error) {
      await session.fail("读取推荐列表失败");
      throw error;
    }
  },
});
