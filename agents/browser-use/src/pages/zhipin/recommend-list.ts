import type { Page } from "@roll-agent/browser";
import {
  resolveRecommendTargetKind,
  resolveResumeCandidateIdentity,
  resolveResumeCardSelector,
  ZHIPIN_RESUME_CANDIDATE_ID_SELECTOR,
  ZHIPIN_RESUME_CANDIDATE_NAME_SELECTOR,
  ZHIPIN_RESUME_CARD_LIST_SELECTOR,
  ZHIPIN_RESUME_CARD_PRIMARY_SELECTOR,
  ZHIPIN_RESUME_RECOMMEND_FRAME_NAME,
  ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER,
} from "./resume-dom-contract.ts";

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
  return target
    .evaluate((primarySelector: string) => {
      return document.querySelectorAll(primarySelector).length;
    }, ZHIPIN_RESUME_CARD_PRIMARY_SELECTOR)
    .then(resolveResumeCardSelector);
}

export function getRecommendTarget(page: Page): RecommendTarget {
  const namedFrame = page.frame(ZHIPIN_RESUME_RECOMMEND_FRAME_NAME);
  const recommendUrlFrame = page
    .frames()
    .find((frame) => frame.url().includes(ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER));
  const targetKind = resolveRecommendTargetKind({
    hasNamedRecommendFrame: namedFrame !== null,
    hasRecommendUrlFrame: recommendUrlFrame !== undefined,
  });

  if (targetKind === "named-frame") {
    return namedFrame ?? page;
  }
  if (targetKind === "recommend-url-frame") {
    return recommendUrlFrame ?? page;
  }
  return page;
}

export async function waitForRecommendList(
  target: RecommendTarget,
  timeout = 10_000,
): Promise<boolean> {
  try {
    await target.waitForSelector(ZHIPIN_RESUME_CARD_LIST_SELECTOR, { timeout });
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
  const info = await card.evaluate(
    (item, selectors) => {
      const candidateId =
        item.getAttribute("data-geek") ??
        item.querySelector(selectors.candidateIdSelector)?.getAttribute("data-geek") ??
        "";
      const name = item.querySelector(selectors.candidateNameSelector)?.textContent?.trim() ?? "";
      const greetButton = item.querySelector("button.btn.btn-greet") as HTMLElement | null;

      return {
        candidateId,
        name,
        hasGreetButton: greetButton !== null && greetButton.offsetWidth > 0,
      };
    },
    {
      candidateIdSelector: ZHIPIN_RESUME_CANDIDATE_ID_SELECTOR,
      candidateNameSelector: ZHIPIN_RESUME_CANDIDATE_NAME_SELECTOR,
    },
  );
  const identity = resolveResumeCandidateIdentity({
    ownDataGeek: info.candidateId,
    nameText: info.name,
  });

  return {
    found: true,
    cardSelector,
    candidateId: identity.candidateId,
    name: identity.name,
    hasGreetButton: info.hasGreetButton,
  };
}
