export const ZHIPIN_RESUME_RECOMMEND_FRAME_NAME = "recommendFrame" as const;
export const ZHIPIN_RESUME_RECOMMEND_FRAME_URL_MARKER = "recommend" as const;
export const ZHIPIN_RESUME_RECOMMEND_FRAME_SELECTOR = "#recommendFrame" as const;

export const ZHIPIN_RESUME_CARD_PRIMARY_SELECTOR = ".candidate-card-wrap" as const;
export const ZHIPIN_RESUME_CARD_FALLBACK_SELECTOR = "[data-geek], .geek-item" as const;
export const ZHIPIN_RESUME_CARD_LIST_SELECTOR =
  `${ZHIPIN_RESUME_CARD_PRIMARY_SELECTOR}, ${ZHIPIN_RESUME_CARD_FALLBACK_SELECTOR}` as const;
export const ZHIPIN_RESUME_CARD_CLICK_SURFACE_SELECTOR =
  "[data-geek], .card-inner, .geek-item" as const;
export const ZHIPIN_RESUME_CANDIDATE_ID_SELECTOR = "[data-geek]" as const;
export const ZHIPIN_RESUME_CANDIDATE_NAME_SELECTOR = ".name" as const;

export const ZHIPIN_RESUME_IFRAME_CLOSE_SELECTORS = [
  ".recommendV2 .boss-popup__close",
  ".dialog-lib-resume .boss-popup__close",
  ".boss-dialog .boss-popup__close",
  ".boss-popup__close",
  ".close-btn",
  ".dialog-close",
] as const;

export const ZHIPIN_RESUME_PAGE_CLOSE_SELECTORS = [
  ".boss-popup__close",
  ".close-btn",
  ".dialog-close",
  ".modal-close",
] as const;

export const ZHIPIN_RESUME_DIALOG_SELECTOR =
  '.boss-popup__wrapper, .dialog-lib-resume, .boss-dialog, [data-type="boss-dialog"]' as const;
export const ZHIPIN_RESUME_PAGE_DIALOG_SELECTOR = ".boss-popup__wrapper" as const;
export const ZHIPIN_RESUME_IFRAME_SELECTOR = 'iframe[src*="c-resume"]' as const;
export const ZHIPIN_RESUME_CANVAS_SELECTOR = "canvas#resume, div#resume canvas" as const;

export const ZHIPIN_RESUME_RECOMMEND_TARGET_KINDS = [
  "named-frame",
  "recommend-url-frame",
  "main-page",
] as const;

export type ZhipinResumeRecommendTargetKind = (typeof ZHIPIN_RESUME_RECOMMEND_TARGET_KINDS)[number];

export type ZhipinResumeCandidateIdentityInput = {
  readonly ownDataGeek?: string | null;
  readonly childDataGeek?: string | null;
  readonly nameText?: string | null;
};

export type ZhipinResumeCandidateIdentity = {
  readonly candidateId: string;
  readonly name: string;
};

export type ZhipinResumeCanvasRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export function resolveRecommendTargetKind(input: {
  readonly hasNamedRecommendFrame: boolean;
  readonly hasRecommendUrlFrame: boolean;
}): ZhipinResumeRecommendTargetKind {
  if (input.hasNamedRecommendFrame) {
    return "named-frame";
  }
  if (input.hasRecommendUrlFrame) {
    return "recommend-url-frame";
  }
  return "main-page";
}

export function resolveResumeCardSelector(primaryCardCount: number): string {
  return primaryCardCount > 0
    ? ZHIPIN_RESUME_CARD_PRIMARY_SELECTOR
    : ZHIPIN_RESUME_CARD_FALLBACK_SELECTOR;
}

export function resolveResumeCandidateIdentity(
  input: ZhipinResumeCandidateIdentityInput,
): ZhipinResumeCandidateIdentity {
  return {
    candidateId: (input.ownDataGeek ?? input.childDataGeek ?? "").trim(),
    name: (input.nameText ?? "").trim(),
  };
}

export function composeResumeCanvasArea(input: {
  readonly recommendFrameRect?: Pick<ZhipinResumeCanvasRect, "x" | "y"> | null;
  readonly resumeFrameRect?: Pick<ZhipinResumeCanvasRect, "x" | "y"> | null;
  readonly canvasRect: ZhipinResumeCanvasRect;
}): ZhipinResumeCanvasRect {
  const offsetX = (input.recommendFrameRect?.x ?? 0) + (input.resumeFrameRect?.x ?? 0);
  const offsetY = (input.recommendFrameRect?.y ?? 0) + (input.resumeFrameRect?.y ?? 0);

  return {
    x: Math.round(offsetX + input.canvasRect.x),
    y: Math.round(offsetY + input.canvasRect.y),
    width: Math.round(input.canvasRect.width),
    height: Math.round(input.canvasRect.height),
  };
}
