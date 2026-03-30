import type { BrowserContextManager, Page } from "@roll-agent/browser";
import { findExistingPlatformPage } from "../platform-page.ts";
import { ZHIPIN_SELECTORS } from "./selectors.ts";

// ---------------------------------------------------------------------------
// Locator type (derived from Page, no direct playwright-core import needed)
// ---------------------------------------------------------------------------

type Locator = ReturnType<Page["locator"]>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ZHIPIN_USERNAME_LENGTH_LIMIT = 30;

const ZHIPIN_NAV_LABELS = new Set([
  "招聘规范",
  "消息",
  "首页",
  "推荐牛人",
  "看简历",
  "我的客服",
  "面试",
  "招聘数据",
  "账号权益",
  "升级VIP",
  "职位",
  "职位管理",
  "牛人",
  "公司",
  "数据统计",
  "设置",
  "帮助中心",
  "登录",
  "注册",
  "退出登录",
  "退出",
  "BOSS直聘",
  "下载APP",
  "搜索",
  "发布职位",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UsernameStrategy =
  | "role-link"
  | "role-button"
  | "aria-snapshot"
  | "leaf-text"
  | "css-fallback";

export type UsernameEvidence = {
  text: string;
  strategy: UsernameStrategy;
  /** Lower is higher priority */
  priority: number;
  /** Debugging info, e.g. "role:link" or "#header .user-name" */
  source: string;
  /** Horizontal position ratio (0-1, left to right). Used to favor rightmost elements. */
  xRatio?: number | undefined;
};

export type UsernameLookupResult =
  | { found: true; userName: string; strategy: UsernameStrategy; source: string }
  | { found: false };

export type ParsedAccessibleName = {
  role: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Pure functions (testable without browser)
// ---------------------------------------------------------------------------

export function isPlausibleUsername(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > ZHIPIN_USERNAME_LENGTH_LIMIT) {
    return false;
  }
  if (ZHIPIN_NAV_LABELS.has(trimmed)) {
    return false;
  }
  if (/登录|注册|退出|下载|帮助|设置|管理/.test(trimmed)) {
    return false;
  }
  return true;
}

export function parseAccessibleNames(snapshot: string): ReadonlyArray<ParsedAccessibleName> {
  const results: ParsedAccessibleName[] = [];
  const pattern = /(link|button|menuitem|img|heading)\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(snapshot)) !== null) {
    const name = match[2]?.trim() ?? "";
    if (name.length > 0) {
      results.push({ role: match[1] ?? "", name });
    }
  }
  return results;
}

export function scoreUsernameEvidence(evidence: UsernameEvidence): number {
  let score = evidence.priority;

  // Hard penalty for known nav labels
  if (ZHIPIN_NAV_LABELS.has(evidence.text.trim())) {
    score += 10;
  }

  // Penalty for long text (usernames are typically short)
  if (evidence.text.trim().length > 10) {
    score += 5;
  }

  // Bonus for CJK name pattern (2-4 characters, common Chinese names)
  if (/^[\u4e00-\u9fff]{2,4}$/.test(evidence.text.trim())) {
    score -= 0.5;
  }

  // Position bonus: elements further to the right are more likely to be the username
  // (usernames in Chinese sites are typically in the top-right corner)
  if (evidence.xRatio !== undefined) {
    // xRatio 0.8+ gets up to -2 bonus, xRatio 0.2 gets +1 penalty
    score -= (evidence.xRatio - 0.5) * 4;
  }

  return score;
}

export function pickBestUsername(evidence: ReadonlyArray<UsernameEvidence>): UsernameLookupResult {
  const plausible = evidence.filter((e) => isPlausibleUsername(e.text));
  if (plausible.length === 0) {
    return { found: false };
  }

  // Cross-confirmation bonus: if the same text appears from DIFFERENT strategies,
  // give a bonus to those entries (count distinct strategies, not occurrences)
  const textStrategies = new Map<string, Set<UsernameStrategy>>();
  for (const e of plausible) {
    const t = e.text.trim();
    const strategies = textStrategies.get(t) ?? new Set<UsernameStrategy>();
    strategies.add(e.strategy);
    textStrategies.set(t, strategies);
  }

  const scored = plausible
    .map((e) => {
      let s = scoreUsernameEvidence(e);
      const distinctStrategies = textStrategies.get(e.text.trim())?.size ?? 1;
      if (distinctStrategies > 1) {
        s -= distinctStrategies * 0.5; // cross-strategy confirmation bonus
      }
      return { evidence: e, score: s };
    })
    .sort((a, b) => a.score - b.score);

  const best = scored[0];
  if (!best) {
    return { found: false };
  }

  return {
    found: true,
    userName: best.evidence.text.trim(),
    strategy: best.evidence.strategy,
    source: best.evidence.source,
  };
}

// ---------------------------------------------------------------------------
// Async functions (need Page)
// ---------------------------------------------------------------------------

export async function findHeaderScope(page: Page): Promise<Locator | null> {
  const candidates: Locator[] = [
    page.getByRole("banner"),
    page.locator("header").first(),
    page.getByRole("navigation").first(),
    page.locator("#header"),
  ];

  for (const candidate of candidates) {
    try {
      const count = await candidate.count();
      if (count > 0 && (await candidate.first().isVisible())) {
        return candidate.first();
      }
    } catch {
      // Candidate not found, try next
    }
  }

  return null;
}

async function collectRoleEvidence(
  scope: Locator,
  page: Page,
  role: "link" | "button",
  strategy: UsernameStrategy,
): Promise<UsernameEvidence[]> {
  const evidence: UsernameEvidence[] = [];
  const viewportSize = page.viewportSize();
  const viewportWidth = viewportSize?.width ?? 1280;
  try {
    const elements = await scope.getByRole(role).all();
    for (const el of elements) {
      try {
        const visible = await el.isVisible();
        if (!visible) continue;
        const text = (await el.textContent()) ?? "";
        const trimmed = text.trim();
        if (trimmed.length > 0 && trimmed.length <= ZHIPIN_USERNAME_LENGTH_LIMIT) {
          let xRatio: number | undefined;
          try {
            const box = await el.boundingBox();
            if (box) {
              xRatio = (box.x + box.width / 2) / viewportWidth;
            }
          } catch {
            // boundingBox failed, leave xRatio undefined
          }
          evidence.push({
            text: trimmed,
            strategy,
            priority: 1,
            source: `role:${role}`,
            xRatio,
          });
        }
      } catch {
        // Skip element on error
      }
    }
  } catch {
    // Role query failed
  }
  return evidence;
}

async function collectAriaSnapshotEvidence(scope: Locator): Promise<UsernameEvidence[]> {
  const evidence: UsernameEvidence[] = [];
  try {
    const snapshot = await scope.ariaSnapshot({ timeout: 3000 });
    const names = parseAccessibleNames(snapshot);
    for (const { role, name } of names) {
      if (name.length > 0 && name.length <= ZHIPIN_USERNAME_LENGTH_LIMIT) {
        evidence.push({
          text: name,
          strategy: "aria-snapshot",
          priority: 2,
          source: `aria:${role}:${name}`,
        });
      }
    }
  } catch {
    // ariaSnapshot timed out or failed
  }
  return evidence;
}

async function collectLeafTextEvidence(scope: Locator): Promise<UsernameEvidence[]> {
  const evidence: UsernameEvidence[] = [];
  try {
    const leafTexts = await scope.evaluate(
      (el: Element, limit: number) => {
        const texts: string[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const t = walker.currentNode.textContent?.trim();
          if (t && t.length > 0 && t.length <= limit) {
            texts.push(t);
          }
        }
        return texts;
      },
      ZHIPIN_USERNAME_LENGTH_LIMIT,
    );
    for (const text of leafTexts) {
      evidence.push({
        text,
        strategy: "leaf-text",
        priority: 3,
        source: "leaf-text",
      });
    }
  } catch {
    // evaluate failed
  }
  return evidence;
}

async function collectCssFallbackEvidence(page: Page): Promise<UsernameEvidence[]> {
  const evidence: UsernameEvidence[] = [];
  try {
    const selectors = [ZHIPIN_SELECTORS.username.primary, ...ZHIPIN_SELECTORS.username.fallbacks];
    const candidates = await page.evaluate((sels: string[]) => {
      return sels.map((selector) => {
        try {
          return {
            selector,
            text: document.querySelector(selector)?.textContent?.trim() ?? "",
          };
        } catch {
          return { selector, text: "" };
        }
      });
    }, selectors);
    for (const { selector, text } of candidates) {
      if (text.length > 0 && text.length <= ZHIPIN_USERNAME_LENGTH_LIMIT) {
        evidence.push({
          text,
          strategy: "css-fallback",
          priority: 4,
          source: selector,
        });
      }
    }
  } catch {
    // evaluate failed
  }
  return evidence;
}

export async function collectUsernameEvidence(
  page: Page,
): Promise<ReadonlyArray<UsernameEvidence>> {
  const scope = await findHeaderScope(page);

  // P1 + P2: run first, check if high-confidence result exists
  const p1p2 = scope
    ? (
        await Promise.all([
          collectRoleEvidence(scope, page, "link", "role-link"),
          collectRoleEvidence(scope, page, "button", "role-button"),
          collectAriaSnapshotEvidence(scope),
        ])
      ).flat()
    : [];

  // Short-circuit only if at least 2 different strategies confirm the same text
  const earlyResult = pickBestUsername(p1p2);
  if (earlyResult.found) {
    const confirmedText = earlyResult.userName;
    const distinctStrategies = new Set(
      p1p2.filter((e) => e.text.trim() === confirmedText).map((e) => e.strategy),
    );
    if (distinctStrategies.size >= 2) {
      return p1p2;
    }
  }

  // P3 + P4: supplement with lower priority strategies
  const p3p4 = (
    await Promise.all([
      scope ? collectLeafTextEvidence(scope) : Promise.resolve([]),
      collectCssFallbackEvidence(page),
    ])
  ).flat();

  return [...p1p2, ...p3p4];
}

// ---------------------------------------------------------------------------
// Page selection (unchanged)
// ---------------------------------------------------------------------------

export async function selectExistingZhipinPage(ctxManager: BrowserContextManager) {
  if (!ctxManager.hasContext("zhipin")) {
    return undefined;
  }
  return findExistingPlatformPage(ctxManager, "zhipin");
}
