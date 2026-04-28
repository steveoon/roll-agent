import type { Page } from "@roll-agent/browser";
import { ZHIPIN_SELECTORS } from "./selectors.ts";

const ZHIPIN_SIDEBAR_SECTION_LABELS = {
  chat: "沟通",
  recommend: "推荐牛人",
} as const;

export type ZhipinSidebarSection = keyof typeof ZHIPIN_SIDEBAR_SECTION_LABELS;

type Locator = ReturnType<Page["locator"]>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pickVisibleLocator(candidates: readonly Locator[]): Promise<Locator | null> {
  for (const candidate of candidates) {
    try {
      if ((await candidate.count()) > 0 && (await candidate.first().isVisible())) {
        return candidate.first();
      }
    } catch {
      // ignore detached or unsupported locator variants
    }
  }

  return null;
}

export function getZhipinSidebarSectionLabel(section: ZhipinSidebarSection): string {
  return ZHIPIN_SIDEBAR_SECTION_LABELS[section];
}

export async function findZhipinSidebarSectionLink(
  page: Page,
  section: ZhipinSidebarSection,
): Promise<Locator | null> {
  const sidebar = page.locator(ZHIPIN_SELECTORS.nav.sidebar).first();
  const label = getZhipinSidebarSectionLabel(section);
  const roleNamePattern = new RegExp(`^${escapeRegExp(label)}(?:\\s|$)`);

  const sectionSelectors =
    section === "recommend"
      ? [ZHIPIN_SELECTORS.nav.recommendLink]
      : [ZHIPIN_SELECTORS.nav.chatLink];

  const candidates: Locator[] = [
    sidebar.getByRole("link", { name: roleNamePattern }).first(),
    ...sectionSelectors.map((selector) => sidebar.locator(selector).first()),
    sidebar.locator(`a:has-text("${label}")`).first(),
    page.getByRole("link", { name: roleNamePattern }).first(),
  ];

  return await pickVisibleLocator(candidates);
}

export function isZhipinRecommendSurfaceOpen(page: Page): boolean {
  if (page.url().includes("/web/chat/recommend")) {
    return true;
  }

  if (page.frame("recommendFrame") !== null) {
    return true;
  }

  return page.frames().some((frame) => frame.url().includes("recommend"));
}

export async function isZhipinChatSurfaceOpen(page: Page): Promise<boolean> {
  if (page.url().includes("/web/chat/index")) {
    return true;
  }

  try {
    const container = page.locator("#container.chat-container-private").first();
    return (await container.count()) > 0 && (await container.isVisible());
  } catch {
    return false;
  }
}

export async function waitForZhipinRecommendSurface(
  page: Page,
  timeout = 10_000,
  pollInterval = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (isZhipinRecommendSurfaceOpen(page)) {
      return true;
    }
    if (page.isClosed()) {
      return false;
    }
    await page.waitForTimeout(Math.min(pollInterval, Math.max(deadline - Date.now(), 0)));
  }

  return isZhipinRecommendSurfaceOpen(page);
}

export async function waitForZhipinChatSurface(
  page: Page,
  timeout = 10_000,
  pollInterval = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await isZhipinChatSurfaceOpen(page)) {
      return true;
    }
    if (page.isClosed()) {
      return false;
    }
    await page.waitForTimeout(Math.min(pollInterval, Math.max(deadline - Date.now(), 0)));
  }

  return await isZhipinChatSurfaceOpen(page);
}
