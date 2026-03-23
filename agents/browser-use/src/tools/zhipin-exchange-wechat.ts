import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { getContextManager } from "../runtime-holder.ts";
import { randomDelay, humanDelay } from "../pages/zhipin/anti-detection.ts";
import { ensureChatOpen } from "../pages/zhipin/chat-navigation.ts";

const OutputSchema = z.object({
  success: z.boolean(),
  exchanged: z.boolean(),
  wechatNumber: z.string().optional(),
  error: z.string().optional(),
});

export const zhipinExchangeWechat = defineTool({
  name: "zhipin_exchange_wechat",
  description:
    '换微信。可指定 candidateName 自动打开对应聊天后执行，或不传则在当前窗口执行；例如"和鲁倩换微信"应提取 candidateName=鲁倩。',
  input: z.object({
    candidateName: z
      .string()
      .optional()
      .describe('候选人姓名。若用户说"和鲁倩换微信"，这里应提取为"鲁倩"'),
    index: z.number().optional().describe("候选人在列表中的索引（可选）"),
  }),
  output: OutputSchema,
  execute: async (input, ctx) => {
    const ctxManager = getContextManager();
    const page = await ctxManager.getPage("zhipin");

    // 如果指定了候选人，先导航到对应聊天
    const nav = await ensureChatOpen(page, {
      candidateName: input.candidateName,
      index: input.index,
    });
    if (nav && !nav.found) {
      return { success: false, exchanged: false, error: nav.error };
    }

    ctx.logger.info(`Starting WeChat exchange${nav ? ` with ${nav.name}` : ""}`);

    try {
      // Step 1: 多策略查找"换微信"按钮
      // 用 getBoundingClientRect 判断可见性（offsetParent 对 fixed 定位不可靠）
      const btnData = await page.evaluate(() => {
        const check = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        // 策略 1: 直接选择器查找
        const selectors = [
          ".operate-exchange-left .operate-btn",
          "span.operate-btn",
        ];
        for (const sel of selectors) {
          const elements = Array.from(document.querySelectorAll(sel));
          for (const el of elements) {
            const text = el.textContent?.trim() ?? "";
            if (text.includes("换微信") && check(el)) {
              (el as HTMLElement).setAttribute("data-roll-wechat-btn", "true");
              return { found: true, text };
            }
          }
        }

        // 策略 2: 全量 span 文本搜索 fallback
        const allSpans = Array.from(document.querySelectorAll("span"));
        for (const span of allSpans) {
          const text = span.textContent?.trim() ?? "";
          if (text.includes("换微信") && check(span)) {
            span.setAttribute("data-roll-wechat-btn", "true");
            return { found: true, text };
          }
        }

        return { found: false };
      });

      if (!btnData.found) {
        return { success: false, exchanged: false, error: "未找到「换微信」按钮" };
      }

      // 用 Playwright 的 click（模拟真实鼠标事件，带坐标）
      await randomDelay(page, 200, 400);
      await page.click('[data-roll-wechat-btn="true"]');

      // 清理标记
      await page.evaluate(() => {
        document.querySelector("[data-roll-wechat-btn]")?.removeAttribute("data-roll-wechat-btn");
      });

      // Step 2: 等确认对话框出现（polling 模式，对动画更宽容）
      // 先等待 400-800ms，然后 polling 检查，最多 ~5 秒
      await randomDelay(page, 400, 800);

      let dialogFound = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const found = await page.evaluate(() => {
          const check = (el: Element): boolean => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };

          // 策略 1: .exchange-tooltip 类名
          const tooltip = document.querySelector(".exchange-tooltip");
          if (tooltip && check(tooltip)) return true;

          // 策略 2: 文本内容匹配 — 查找包含"交换微信"的弹窗
          const allElements = document.querySelectorAll("div, section, aside");
          for (const el of Array.from(allElements)) {
            const text = el.textContent ?? "";
            if (text.includes("交换微信") && el.querySelector(".boss-btn-primary, .boss-btn")) {
              if (check(el)) return true;
            }
          }

          return false;
        });
        if (found) {
          dialogFound = true;
          break;
        }
        await randomDelay(page, 400, 800);
      }

      if (!dialogFound) {
        return { success: false, exchanged: false, error: "确认对话框未弹出" };
      }

      await humanDelay(page);

      // Step 3: 多策略查找确认按钮（不限定在 .exchange-tooltip 内）
      const confirmData = await page.evaluate(() => {
        const check = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };

        // 策略 1: 在 .exchange-tooltip 内查找
        const tooltip = document.querySelector(".exchange-tooltip");
        if (tooltip) {
          const selectors = [
            ".btn-box .boss-btn-primary.boss-btn",
            ".btn-box span.boss-btn-primary",
            "span.boss-btn-primary",
            ".boss-btn-primary",
          ];
          for (const sel of selectors) {
            const btn = tooltip.querySelector(sel) as HTMLElement | null;
            if (btn && check(btn)) {
              btn.setAttribute("data-roll-confirm-btn", "true");
              return { found: true, text: btn.textContent?.trim() ?? "" };
            }
          }
        }

        // 策略 2: 全局查找"确定"按钮 — 限定在包含"交换微信"文本的容器内
        const containers = document.querySelectorAll("div, section, aside");
        for (const container of Array.from(containers)) {
          const cText = container.textContent ?? "";
          if (!cText.includes("交换微信")) continue;

          const btns = container.querySelectorAll(
            "span.boss-btn-primary, button.boss-btn-primary, span.boss-btn, button.boss-btn",
          );
          for (const btn of Array.from(btns)) {
            const bText = btn.textContent?.trim() ?? "";
            if (bText === "确定" && check(btn)) {
              (btn as HTMLElement).setAttribute("data-roll-confirm-btn", "true");
              return { found: true, text: bText };
            }
          }
        }

        return { found: false };
      });

      if (!confirmData.found) {
        return { success: false, exchanged: false, error: "未找到确认按钮" };
      }

      // 点击前稍等（模拟人类阅读弹窗）
      await randomDelay(page, 200, 400);
      await page.click('[data-roll-confirm-btn="true"]');

      // 清理标记
      await page.evaluate(() => {
        document.querySelector("[data-roll-confirm-btn]")?.removeAttribute("data-roll-confirm-btn");
      });

      // Step 4: 等待交换完成，提取微信号
      await randomDelay(page, 1500, 2500);

      const wechatNumber = await page.evaluate(() => {
        // 策略 1: 从微信交换卡片提取
        const cardSelectors = [
          ".message-card-top-wrap",
          '[class*="d-top-text"]',
          ".message-card-top-title",
        ];
        for (const sel of cardSelectors) {
          const cards = Array.from(document.querySelectorAll(sel));
          for (let i = cards.length - 1; i >= 0; i--) {
            const text = cards[i]?.textContent ?? "";
            const digitMatch = text.match(/\b(\d{8,15})\b/);
            if (digitMatch) return digitMatch[1];
            const wxMatch = text.match(/微信[：:号]*\s*([a-zA-Z0-9_-]{5,20})/);
            if (wxMatch) return wxMatch[1];
            const letterMatch = text.match(/\b([a-zA-Z][a-zA-Z0-9_-]{5,19})\b/);
            if (letterMatch && !["微信", "WeChat"].includes(letterMatch[1]!)) {
              return letterMatch[1];
            }
          }
        }

        // 策略 2: 从消息列表末尾反向查找微信交换卡片
        const msgItems = Array.from(document.querySelectorAll(".message-item"));
        for (let i = msgItems.length - 1; i >= 0; i--) {
          const card = msgItems[i]?.querySelector(
            '.message-card-top-wrap, [class*="d-top-text"]',
          );
          if (card) {
            const text = card.textContent ?? "";
            const numMatch = text.match(/\b(\d{8,15})\b/);
            if (numMatch) return numMatch[1];
          }
        }

        return null;
      });

      ctx.logger.info(`WeChat exchanged${wechatNumber ? `, number: ${wechatNumber}` : ""}`);
      return {
        success: true,
        exchanged: true,
        ...(wechatNumber !== null ? { wechatNumber } : {}),
      };
    } catch (err) {
      return {
        success: false,
        exchanged: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
