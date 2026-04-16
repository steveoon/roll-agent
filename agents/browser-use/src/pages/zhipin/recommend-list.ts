import type { Page } from "@roll-agent/browser";

const PRIMARY_CARD_SELECTOR = ".candidate-card-wrap";
const FALLBACK_CARD_SELECTOR = "[data-geek], .geek-item";
const RECOMMEND_LIST_SELECTOR = `${PRIMARY_CARD_SELECTOR}, ${FALLBACK_CARD_SELECTOR}`;

type RecommendTarget = Page | NonNullable<ReturnType<Page["frame"]>>;
type RecommendCardInfo = {
  readonly found: boolean;
  readonly cardSelector: string;
  readonly candidateId: string;
  readonly name: string;
  readonly hasGreetButton: boolean;
  readonly error?: string;
};

function getCardSelector(target: RecommendTarget): Promise<string> {
  return target.evaluate(
    (selectors: { primarySelector: string; fallbackSelector: string }) => {
      return document.querySelectorAll(selectors.primarySelector).length > 0
        ? selectors.primarySelector
        : selectors.fallbackSelector;
    },
    {
      primarySelector: PRIMARY_CARD_SELECTOR,
      fallbackSelector: FALLBACK_CARD_SELECTOR,
    },
  );
}

export function getRecommendTarget(page: Page): RecommendTarget {
  return page.frame("recommendFrame") ?? page.frames().find((f) => f.url().includes("recommend")) ?? page;
}

export async function waitForRecommendList(
  target: RecommendTarget,
  timeout = 10_000,
): Promise<boolean> {
  try {
    await target.waitForSelector(RECOMMEND_LIST_SELECTOR, { timeout });
    return true;
  } catch {
    return false;
  }
}

export async function inspectRecommendCard(
  target: RecommendTarget,
  index: number,
): Promise<RecommendCardInfo> {
  const cardSelector = await getCardSelector(target);
  const cards = target.locator(cardSelector);
  if ((await cards.count()) <= index) {
    return {
      found: false,
      cardSelector,
      candidateId: "",
      name: "",
      hasGreetButton: false,
      error: "索引超出范围",
    };
  }

  const card = cards.nth(index);
  const info = await card.evaluate((item) => {
    const candidateId =
      item.getAttribute("data-geek") ?? item.querySelector("[data-geek]")?.getAttribute("data-geek") ?? "";
    const name = item.querySelector(".name")?.textContent?.trim() ?? "";
    const greetButton = item.querySelector("button.btn.btn-greet") as HTMLElement | null;

    return {
      candidateId,
      name,
      hasGreetButton: greetButton !== null && greetButton.offsetWidth > 0,
    };
  });

  return {
    found: true,
    cardSelector,
    candidateId: info.candidateId,
    name: info.name,
    hasGreetButton: info.hasGreetButton,
  };
}
