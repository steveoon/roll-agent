import type { Page } from "@roll-agent/browser";
import { ZHIPIN_SELECTORS } from "./selectors.ts";

export const ZHIPIN_RECOMMEND_GENDER_VALUES = ["不限", "男", "女"] as const;

export type ZhipinRecommendGender = (typeof ZHIPIN_RECOMMEND_GENDER_VALUES)[number];

export const ZHIPIN_RECOMMEND_ACTIVITY_VALUES = [
  "不限",
  "刚刚活跃",
  "今日活跃",
  "3日内活跃",
  "本周活跃",
  "本月活跃",
] as const;

export type ZhipinRecommendActivity = (typeof ZHIPIN_RECOMMEND_ACTIVITY_VALUES)[number];

export const ZHIPIN_RECOMMEND_FILTER_APPLY_MODE_VALUES = ["patch", "replace"] as const;

export type ZhipinRecommendFilterApplyMode =
  (typeof ZHIPIN_RECOMMEND_FILTER_APPLY_MODE_VALUES)[number];

export const ZHIPIN_RECOMMEND_FILTER_OPTION_FIELDS = [
  {
    key: "gender",
    label: "性别",
    selection: "single",
    clearValue: "不限",
    values: ZHIPIN_RECOMMEND_GENDER_VALUES,
  },
  {
    key: "activity",
    label: "活跃度",
    selection: "single",
    clearValue: "不限",
    values: ZHIPIN_RECOMMEND_ACTIVITY_VALUES,
  },
  {
    key: "major",
    label: "专业",
    selection: "multi",
    clearValue: "不限",
  },
  {
    key: "recentNotView",
    label: "近期没有看过",
    selection: "single",
    clearValue: "不限",
  },
  {
    key: "exchangeResumeWithColleague",
    label: "是否与同事交换简历",
    selection: "single",
    clearValue: "不限",
  },
  {
    key: "candidateKeywords",
    label: "牛人关键词",
    selection: "multi",
    clearValue: "不限",
  },
  {
    key: "school",
    label: "院校",
    selection: "multi",
    clearValue: "不限",
  },
  {
    key: "switchJobFrequency",
    label: "跳槽频率",
    selection: "single",
    clearValue: "不限",
  },
  {
    key: "intention",
    label: "求职意向",
    selection: "multi",
    clearValue: "不限",
  },
  {
    key: "salary",
    label: "薪资待遇",
    selection: "single",
    clearValue: "不限",
  },
  {
    key: "degree",
    label: "学历要求",
    selection: "multi",
    clearValue: "不限",
  },
  {
    key: "experience",
    label: "经验要求",
    selection: "multi",
    clearValue: "不限",
  },
  {
    key: "callPhone",
    label: "是否可拨打电话",
    selection: "single",
    clearValue: "不限",
  },
] as const;

export type ZhipinRecommendFilterOptionField =
  (typeof ZHIPIN_RECOMMEND_FILTER_OPTION_FIELDS)[number];

export type ZhipinRecommendFilterOptionFieldKey = ZhipinRecommendFilterOptionField["key"];

export type ZhipinRecommendFilterOptionSelectionMode =
  ZhipinRecommendFilterOptionField["selection"];

export const ZHIPIN_RECOMMEND_FILTER_STATUS_VALUES = [
  "applied",
  "recommend_not_ready",
  "filter_not_found",
  "requires_vip",
  "age_not_applied",
  "clear_failed",
  "submit_failed",
  "error",
] as const;

export type ZhipinRecommendFilterStatus = (typeof ZHIPIN_RECOMMEND_FILTER_STATUS_VALUES)[number];

export type RecommendTarget = Page | NonNullable<ReturnType<Page["frame"]>>;
type PageLocator = ReturnType<Page["locator"]>;

export type ZhipinRecommendFilterOptionSelection = {
  readonly fieldKey: ZhipinRecommendFilterOptionFieldKey;
  readonly label: string;
  readonly values: readonly string[];
  readonly selection: ZhipinRecommendFilterOptionSelectionMode;
  readonly clearValue: string;
};

export type ZhipinRecommendFilterAgeRange = {
  readonly min?: number;
  readonly max?: number;
};

export type ZhipinRecommendFilterLocationSelection = {
  readonly city: string;
  readonly district?: string;
};

export type ZhipinRecommendFilterRequest = {
  readonly applyMode: ZhipinRecommendFilterApplyMode;
  readonly ageMin?: number;
  readonly ageMax?: number;
  readonly location?: ZhipinRecommendFilterLocationSelection;
  readonly optionSelections: readonly ZhipinRecommendFilterOptionSelection[];
};

export type ZhipinRecommendFilterApplied = {
  readonly ageMin?: number;
  readonly ageMax?: number;
  readonly location?: ZhipinRecommendFilterLocationSelection;
  readonly optionSelections: readonly {
    readonly fieldKey: ZhipinRecommendFilterOptionFieldKey;
    readonly label: string;
    readonly values: readonly string[];
  }[];
  readonly gender?: string;
  readonly activity?: string;
};

export type ZhipinRecommendFilterApplyResult = {
  readonly status: ZhipinRecommendFilterStatus;
  readonly requested: ZhipinRecommendFilterRequest;
  readonly applied?: ZhipinRecommendFilterApplied;
  readonly filterButtonText?: string;
  readonly error?: string;
};

export function getZhipinRecommendFilterOptionField(
  fieldKey: ZhipinRecommendFilterOptionFieldKey,
): ZhipinRecommendFilterOptionField {
  const field = ZHIPIN_RECOMMEND_FILTER_OPTION_FIELDS.find((item) => item.key === fieldKey);
  if (field === undefined) {
    throw new Error(`Unknown recommend filter field: ${fieldKey}`);
  }
  return field;
}

export function shouldApplyRecommendAgeRange(requested: ZhipinRecommendFilterRequest): boolean {
  return requested.ageMin !== undefined || requested.ageMax !== undefined;
}

export type RecommendFilterVisualFeedback = {
  readonly moveToLocator: (
    page: Page,
    locator: PageLocator,
    options?: {
      readonly durationMs?: number;
      readonly settleMs?: number;
      readonly target?: RecommendTarget;
    },
  ) => Promise<boolean>;
  readonly showClickOnLocator: (
    page: Page,
    locator: PageLocator,
    options?: {
      readonly pulseDurationMs?: number;
      readonly target?: RecommendTarget;
    },
  ) => Promise<boolean>;
};

type RecommendAgeState = {
  readonly ageMin?: number;
  readonly ageMax?: number;
};

type RecommendAgeSnapshot = RecommendAgeState & {
  readonly minRatio?: number;
  readonly maxRatio?: number;
};

type AgeSliderResolution =
  | {
      readonly ok: true;
      readonly current: RecommendAgeState;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

const DEFAULT_AGE_MIN = 16;
const AGE_SLIDER_NUMERIC_MAX_ESTIMATE = 50;
const AGE_DRAG_SETTLE_MS = 650;
const AGE_DRAG_ATTEMPTS = 10;
const AGE_HANDLE_MIN_GAP_RATIO = 0.015;

const MARKER_ATTRIBUTES = [
  "data-roll-recommend-filter-button",
  "data-roll-recommend-filter-option",
  "data-roll-recommend-filter-submit",
  "data-roll-recommend-filter-age-track",
  "data-roll-recommend-filter-age-min-handle",
  "data-roll-recommend-filter-age-max-handle",
] as const;

const SELECTED_CLASS_PATTERN = "active|selected|checked|current|choose|chosen";
const CLICKABLE_OPTION_SELECTOR =
  "button, a, label, li, span, div, [role='button'], [role='radio']";

async function showClickFeedback(
  page: Page,
  target: RecommendTarget,
  locator: PageLocator,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<void> {
  if (!visualFeedback) return;

  await visualFeedback.moveToLocator(page, locator, {
    durationMs: 100,
    settleMs: 25,
    target,
  });
  await visualFeedback.showClickOnLocator(page, locator, {
    pulseDurationMs: 170,
    target,
  });
}

function buildResult(
  requested: ZhipinRecommendFilterRequest,
  status: ZhipinRecommendFilterStatus,
  options: {
    readonly applied?: ZhipinRecommendFilterApplied;
    readonly filterButtonText?: string;
    readonly error?: string;
  } = {},
): ZhipinRecommendFilterApplyResult {
  return {
    status,
    requested,
    ...(options.applied !== undefined ? { applied: options.applied } : {}),
    ...(options.filterButtonText !== undefined
      ? { filterButtonText: options.filterButtonText }
      : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
  };
}

function withAgeMax(state: { ageMin?: number }, ageMax: number | undefined): RecommendAgeState {
  return {
    ...(state.ageMin !== undefined ? { ageMin: state.ageMin } : {}),
    ...(ageMax !== undefined ? { ageMax } : {}),
  };
}

export function parseRecommendAgeStateText(text: string): RecommendAgeState {
  const normalized = text.replace(/\s+/g, " ").trim();
  const ageText = normalized.includes("年龄")
    ? normalized.slice(normalized.indexOf("年龄") + "年龄".length)
    : normalized;
  const numbers = Array.from(ageText.matchAll(/\d+/g), (match) =>
    Number.parseInt(match[0], 10),
  ).filter((value) => Number.isInteger(value));
  const ageMin = numbers[0];
  const ageMax = ageText.includes("不限") ? undefined : numbers[1];

  return withAgeMax(ageMin !== undefined ? { ageMin } : {}, ageMax);
}

export async function waitForRecommendFilterSurface(
  target: RecommendTarget,
  timeout = 10_000,
): Promise<boolean> {
  try {
    await target.waitForSelector(
      `${ZHIPIN_SELECTORS.recommend.filterButton}, .candidate-card-wrap, ${ZHIPIN_SELECTORS.recommend.candidateItem}`,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

async function getFilterButtonText(target: RecommendTarget): Promise<string | undefined> {
  try {
    const text = await target.locator(ZHIPIN_SELECTORS.recommend.filterButton).first().textContent({
      timeout: 1_000,
    });
    return text?.replace(/\s+/g, " ").trim();
  } catch {
    return undefined;
  }
}

async function dismissPreviousFilterPrompt(target: RecommendTarget): Promise<boolean> {
  return await target.evaluate(() => {
    const normalizeText = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };
    const clickCandidate = (root: Element): boolean => {
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>("button, a, span, div, [role='button']"),
      ).filter((element) => isVisible(element));

      for (const candidate of candidates) {
        const text = normalizeText(candidate.textContent);
        if (/^(取消|不应用|否|关闭|稍后)$/.test(text)) {
          candidate.click();
          return true;
        }
      }

      return false;
    };

    const roots = Array.from(document.body.querySelectorAll<HTMLElement>("div, section, aside"))
      .filter((element) => isVisible(element))
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.width * aRect.height - bRect.width * bRect.height;
      });

    for (const root of roots) {
      const text = normalizeText(root.textContent);
      if (text.includes("是否应用上次") || text.includes("上次的筛选条件")) {
        return clickCandidate(root);
      }
    }

    return false;
  });
}

async function markRecommendFilterOption(
  target: RecommendTarget,
  rowLabel: string,
  optionLabel: string,
): Promise<boolean> {
  return await target.evaluate(
    (args: {
      panelSelector: string;
      rowLabel: string;
      optionLabel: string;
      markerAttribute: string;
      clickableOptionSelector: string;
    }) => {
      const normalizeText = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };
      const elementArea = (element: Element): number => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const resolveClickable = (element: HTMLElement, row: HTMLElement): HTMLElement => {
        let current: HTMLElement | null = element;
        while (current && current !== row.parentElement) {
          const tag = current.tagName.toLowerCase();
          const role = current.getAttribute("role") ?? "";
          if (
            tag === "button" ||
            tag === "a" ||
            tag === "label" ||
            tag === "li" ||
            role === "button" ||
            role === "radio"
          ) {
            return current;
          }
          current = current.parentElement;
        }
        return element;
      };

      document
        .querySelectorAll(`[${args.markerAttribute}]`)
        .forEach((element) => element.removeAttribute(args.markerAttribute));

      const panels = Array.from(document.querySelectorAll<HTMLElement>(args.panelSelector))
        .filter((element) => isVisible(element))
        .sort((a, b) => elementArea(a) - elementArea(b));
      const panel = panels[0];
      if (!panel) return false;

      const rows = Array.from(panel.querySelectorAll<HTMLElement>("div, li, dl, dd, section, ul"))
        .filter((element) => {
          const text = normalizeText(element.textContent);
          return (
            isVisible(element) && text.includes(args.rowLabel) && text.includes(args.optionLabel)
          );
        })
        .sort((a, b) => {
          const areaDelta = elementArea(a) - elementArea(b);
          if (areaDelta !== 0) return areaDelta;
          return normalizeText(a.textContent).length - normalizeText(b.textContent).length;
        });

      for (const row of rows) {
        const options = Array.from(row.querySelectorAll<HTMLElement>(args.clickableOptionSelector))
          .filter((element) => isVisible(element))
          .filter((element) => normalizeText(element.textContent) === args.optionLabel)
          .sort((a, b) => elementArea(a) - elementArea(b));
        const option = options[0];
        if (option) {
          resolveClickable(option, row).setAttribute(args.markerAttribute, "1");
          return true;
        }
      }

      return false;
    },
    {
      panelSelector: ZHIPIN_SELECTORS.recommend.filterPanel,
      rowLabel,
      optionLabel,
      markerAttribute: "data-roll-recommend-filter-option",
      clickableOptionSelector: CLICKABLE_OPTION_SELECTOR,
    },
  );
}

async function selectRecommendFilterOption(
  target: RecommendTarget,
  page: Page,
  rowLabel: string,
  optionLabel: string,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<boolean> {
  if (!(await markRecommendFilterOption(target, rowLabel, optionLabel))) {
    return false;
  }

  try {
    const option = target.locator('[data-roll-recommend-filter-option="1"]').first();
    await showClickFeedback(page, target, option, visualFeedback);
    await option.click({ timeout: 2_000 });
    await target.waitForTimeout(120);
    return true;
  } catch {
    return false;
  }
}

async function markAgeSlider(target: RecommendTarget): Promise<AgeSliderResolution> {
  return await target.evaluate(
    (args: { panelSelector: string; markerAttributes: readonly string[] }) => {
      const normalizeText = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const parseAgeState = (text: string): RecommendAgeState => {
        const normalized = normalizeText(text);
        const ageText = normalized.includes("年龄")
          ? normalized.slice(normalized.indexOf("年龄") + "年龄".length)
          : normalized;
        const numbers = Array.from(ageText.matchAll(/\d+/g), (match) =>
          Number.parseInt(match[0], 10),
        ).filter((value) => Number.isInteger(value));
        const ageMin = numbers[0];
        const ageMax = ageText.includes("不限") ? undefined : numbers[1];

        return {
          ...(ageMin !== undefined ? { ageMin } : {}),
          ...(ageMax !== undefined ? { ageMax } : {}),
        };
      };
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };
      const elementArea = (element: Element): number => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const classText = (element: Element): string =>
        typeof element.className === "string" ? element.className : "";
      const looksLikeSlider = (element: Element): boolean => {
        const classes = classText(element);
        const role = element.getAttribute("role") ?? "";
        return /slider|range|track|bar/i.test(classes) || role === "slider";
      };
      const looksLikeHandle = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const classes = classText(element);
        const role = element.getAttribute("role") ?? "";
        return (
          role === "slider" ||
          (/handle|handler|button|thumb|slider-btn|dot|point|circle|knob/i.test(classes) &&
            rect.width <= 80 &&
            rect.height <= 80)
        );
      };

      for (const attr of args.markerAttributes) {
        document.querySelectorAll(`[${attr}]`).forEach((element) => element.removeAttribute(attr));
      }

      const panels = Array.from(document.querySelectorAll<HTMLElement>(args.panelSelector))
        .filter((element) => isVisible(element))
        .sort((a, b) => elementArea(a) - elementArea(b));
      const panel = panels[0];
      if (!panel) return { ok: false, error: "未找到筛选面板" };

      const rows = Array.from(panel.querySelectorAll<HTMLElement>("div, li, section, dl, dd"))
        .filter((element) => {
          const text = normalizeText(element.textContent);
          return (
            isVisible(element) &&
            text.includes("年龄") &&
            Array.from(element.querySelectorAll("*")).some(
              (child) => looksLikeSlider(child) || looksLikeHandle(child),
            )
          );
        })
        .sort((a, b) => {
          const areaDelta = elementArea(a) - elementArea(b);
          if (areaDelta !== 0) return areaDelta;
          return normalizeText(a.textContent).length - normalizeText(b.textContent).length;
        });

      const row = rows[0];
      if (!row) return { ok: false, error: "未找到年龄滑块" };

      const vueSliderDots = Array.from(row.querySelectorAll<HTMLElement>(".vue-slider-dot"))
        .filter((element) => isVisible(element))
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const fallbackHandles = Array.from(row.querySelectorAll<HTMLElement>("*"))
        .filter((element) => isVisible(element) && looksLikeHandle(element))
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const handles = vueSliderDots.length >= 2 ? vueSliderDots : fallbackHandles;

      if (handles.length < 2) {
        return { ok: false, error: "未找到年龄滑块双手柄" };
      }

      const minHandle = handles[0];
      const maxHandle = handles[handles.length - 1];
      if (!minHandle || !maxHandle) {
        return { ok: false, error: "未找到年龄滑块双手柄" };
      }
      const minHandleRect = minHandle.getBoundingClientRect();
      const maxHandleRect = maxHandle.getBoundingClientRect();
      const minDistance = Math.max(40, maxHandleRect.left - minHandleRect.left);
      const vueSliderTracks = Array.from(
        row.querySelectorAll<HTMLElement>(".vue-slider-rail, .vue-slider"),
      )
        .filter((element) => {
          if (!isVisible(element)) return false;
          const rect = element.getBoundingClientRect();
          return rect.width >= minDistance && rect.height <= 80;
        })
        .sort((a, b) => {
          const aClasses = classText(a);
          const bClasses = classText(b);
          if (/vue-slider-rail/.test(aClasses) && !/vue-slider-rail/.test(bClasses)) return -1;
          if (!/vue-slider-rail/.test(aClasses) && /vue-slider-rail/.test(bClasses)) return 1;
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          const heightDelta = aRect.height - bRect.height;
          if (heightDelta !== 0) return heightDelta;
          return bRect.width - aRect.width;
        });
      const tracks = Array.from(row.querySelectorAll<HTMLElement>("*"))
        .filter((element) => {
          if (!isVisible(element) || !looksLikeSlider(element)) return false;
          const rect = element.getBoundingClientRect();
          return (
            rect.width >= Math.max(80, minDistance) &&
            rect.height <= 80 &&
            rect.left <= minHandleRect.left + minHandleRect.width &&
            rect.right >= maxHandleRect.right - maxHandleRect.width
          );
        })
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          const heightDelta = aRect.height - bRect.height;
          if (heightDelta !== 0) return heightDelta;
          return bRect.width - aRect.width;
        });
      const commonAncestorTracks = Array.from(row.querySelectorAll<HTMLElement>("*"))
        .filter((element) => {
          if (!isVisible(element) || !element.contains(minHandle) || !element.contains(maxHandle)) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width >= minDistance && rect.height <= 140;
        })
        .sort((a, b) => {
          const areaDelta = elementArea(a) - elementArea(b);
          if (areaDelta !== 0) return areaDelta;
          return a.getBoundingClientRect().height - b.getBoundingClientRect().height;
        });

      const track = vueSliderTracks[0] ?? tracks[0] ?? commonAncestorTracks[0];
      if (!track) {
        return { ok: false, error: "未找到年龄滑块轨道" };
      }

      track.setAttribute("data-roll-recommend-filter-age-track", "1");
      minHandle.setAttribute("data-roll-recommend-filter-age-min-handle", "1");
      maxHandle.setAttribute("data-roll-recommend-filter-age-max-handle", "1");

      return { ok: true, current: parseAgeState(normalizeText(row.textContent)) };
    },
    {
      panelSelector: ZHIPIN_SELECTORS.recommend.filterPanel,
      markerAttributes: MARKER_ATTRIBUTES,
    },
  );
}

async function readAgeState(target: RecommendTarget): Promise<RecommendAgeSnapshot> {
  return await target.evaluate((panelSelector: string) => {
    const normalizeText = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const parseAgeValue = (text: string): number | undefined => {
      if (text.includes("不限")) return undefined;
      const match = text.match(/\d+/);
      return match ? Number.parseInt(match[0], 10) : undefined;
    };
    const parseAgeState = (text: string): RecommendAgeState => {
      const normalized = normalizeText(text);
      const ageText = normalized.includes("年龄")
        ? normalized.slice(normalized.indexOf("年龄") + "年龄".length)
        : normalized;
      const numbers = Array.from(ageText.matchAll(/\d+/g), (match) =>
        Number.parseInt(match[0], 10),
      ).filter((value) => Number.isInteger(value));
      const ageMin = numbers[0];
      const ageMax = ageText.includes("不限") ? undefined : numbers[1];

      return {
        ...(ageMin !== undefined ? { ageMin } : {}),
        ...(ageMax !== undefined ? { ageMax } : {}),
      };
    };
    const readRatio = (dot: HTMLElement, track: HTMLElement): number | undefined => {
      const styleLeft = dot.style.left;
      if (styleLeft.endsWith("%")) {
        const parsed = Number.parseFloat(styleLeft);
        if (Number.isFinite(parsed)) {
          return Math.max(0, Math.min(1, parsed / 100));
        }
      }

      const dotRect = dot.getBoundingClientRect();
      const trackRect = track.getBoundingClientRect();
      if (trackRect.width <= 0) return undefined;
      return Math.max(
        0,
        Math.min(1, (dotRect.left + dotRect.width / 2 - trackRect.left) / trackRect.width),
      );
    };
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };
    const elementArea = (element: Element): number => {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const classText = (element: Element): string =>
      typeof element.className === "string" ? element.className : "";
    const looksLikeSlider = (element: Element): boolean => {
      const classes = classText(element);
      const role = element.getAttribute("role") ?? "";
      return /slider|range|track|bar/i.test(classes) || role === "slider";
    };
    const panel = Array.from(document.querySelectorAll<HTMLElement>(panelSelector))
      .filter((element) => isVisible(element))
      .sort((a, b) => elementArea(a) - elementArea(b))[0];
    if (!panel) return {};

    const row = Array.from(panel.querySelectorAll<HTMLElement>("div, li, section, dl, dd"))
      .filter((element) => {
        const text = normalizeText(element.textContent);
        return (
          isVisible(element) &&
          text.includes("年龄") &&
          (/\d+|不限/.test(text) || Array.from(element.querySelectorAll("*")).some(looksLikeSlider))
        );
      })
      .sort((a, b) => {
        const areaDelta = elementArea(a) - elementArea(b);
        if (areaDelta !== 0) return areaDelta;
        return normalizeText(a.textContent).length - normalizeText(b.textContent).length;
      })[0];

    if (!row) return {};

    const dots = Array.from(row.querySelectorAll<HTMLElement>(".vue-slider-dot"))
      .filter((element) => isVisible(element))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const track = row.querySelector<HTMLElement>(".vue-slider-rail, .vue-slider");

    if (dots.length >= 2) {
      const minDot = dots[0];
      const maxDot = dots[dots.length - 1];
      const minText = normalizeText(
        minDot?.querySelector(".vue-slider-dot-tooltip-text")?.textContent,
      );
      const maxText = normalizeText(
        maxDot?.querySelector(".vue-slider-dot-tooltip-text")?.textContent,
      );
      const ageMin = parseAgeValue(minText);
      const ageMax = parseAgeValue(maxText);

      return {
        ...(ageMin !== undefined ? { ageMin } : {}),
        ...(ageMax !== undefined ? { ageMax } : {}),
        ...(track && minDot ? { minRatio: readRatio(minDot, track) } : {}),
        ...(track && maxDot ? { maxRatio: readRatio(maxDot, track) } : {}),
      };
    }

    return parseAgeState(normalizeText(row.textContent));
  }, ZHIPIN_SELECTORS.recommend.filterPanel);
}

async function dragAgeHandleToRatio(
  target: RecommendTarget,
  page: Page,
  handle: "min" | "max",
  ratio: number,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<boolean> {
  const resolution = await markAgeSlider(target);
  if (!resolution.ok) return false;

  const track = target.locator('[data-roll-recommend-filter-age-track="1"]').first();
  const handleSelector =
    handle === "min"
      ? '[data-roll-recommend-filter-age-min-handle="1"]'
      : '[data-roll-recommend-filter-age-max-handle="1"]';
  const handleLocator = target.locator(handleSelector).first();
  const trackBox = await track.boundingBox();
  if (!trackBox) return false;

  const x = Math.max(0, Math.min(trackBox.width, trackBox.width * ratio));
  const y = Math.max(1, trackBox.height / 2);

  try {
    if (visualFeedback) {
      await visualFeedback.moveToLocator(page, handleLocator, {
        durationMs: 90,
        settleMs: 20,
        target,
      });
    }
    await handleLocator.dragTo(track, {
      force: true,
      targetPosition: { x, y },
      timeout: 2_000,
    });
    await target.waitForTimeout(AGE_DRAG_SETTLE_MS);
    return true;
  } catch {
    return false;
  }
}

function estimateAgeRatio(age: number): number {
  return Math.max(
    0,
    Math.min(1, (age - DEFAULT_AGE_MIN) / (AGE_SLIDER_NUMERIC_MAX_ESTIMATE - DEFAULT_AGE_MIN)),
  );
}

function clampRatio(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function setAgeHandleToNumber(
  target: RecommendTarget,
  page: Page,
  handle: "min" | "max",
  targetAge: number,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<boolean> {
  const initialState = await readAgeState(target);
  const minRatio = initialState.minRatio ?? 0;
  const maxRatio = initialState.maxRatio ?? 1;
  let low = handle === "min" ? 0 : Math.min(1, minRatio + AGE_HANDLE_MIN_GAP_RATIO);
  let high = handle === "min" ? Math.max(0, maxRatio - AGE_HANDLE_MIN_GAP_RATIO) : 1;
  let ratio = clampRatio(estimateAgeRatio(targetAge), low, high);

  for (let attempt = 0; attempt < AGE_DRAG_ATTEMPTS; attempt += 1) {
    if (!(await dragAgeHandleToRatio(target, page, handle, ratio, visualFeedback))) {
      return false;
    }

    const state = await readAgeState(target);
    const currentAge = handle === "min" ? state.ageMin : state.ageMax;
    if (currentAge === targetAge) {
      return true;
    }

    if (currentAge === undefined) {
      if (handle === "max") {
        high = ratio;
      } else {
        low = ratio;
      }
    } else if (currentAge < targetAge) {
      low = ratio;
    } else {
      high = ratio;
    }

    const nextRatio = (low + high) / 2;
    if (Math.abs(nextRatio - ratio) < 0.001) {
      break;
    }
    ratio = clampRatio(nextRatio, low, high);
  }

  const finalState = await readAgeState(target);
  return handle === "min" ? finalState.ageMin === targetAge : finalState.ageMax === targetAge;
}

function isDesiredAgeState(
  state: RecommendAgeState,
  desiredMin: number,
  desiredMax: number | undefined,
): boolean {
  return state.ageMin === desiredMin && state.ageMax === desiredMax;
}

async function setRecommendAgeRange(
  target: RecommendTarget,
  page: Page,
  requested: ZhipinRecommendFilterRequest,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<
  | { readonly success: true; readonly state: RecommendAgeState }
  | { readonly success: false; readonly error: string }
> {
  const desiredMin = requested.ageMin ?? DEFAULT_AGE_MIN;
  const desiredMax = requested.ageMax;

  const resolution = await markAgeSlider(target);
  if (!resolution.ok) {
    return { success: false, error: resolution.error };
  }

  if (!(await dragAgeHandleToRatio(target, page, "max", 1, visualFeedback))) {
    return { success: false, error: "年龄上限无法重置为不限" };
  }

  if (!(await setAgeHandleToNumber(target, page, "min", desiredMin, visualFeedback))) {
    return { success: false, error: `年龄下限无法设置为 ${desiredMin}` };
  }

  if (desiredMax === undefined) {
    if (!(await dragAgeHandleToRatio(target, page, "max", 1, visualFeedback))) {
      return { success: false, error: "年龄上限无法设置为不限" };
    }
  } else if (!(await setAgeHandleToNumber(target, page, "max", desiredMax, visualFeedback))) {
    return { success: false, error: `年龄上限无法设置为 ${desiredMax}` };
  }

  const finalState = await readAgeState(target);
  if (!isDesiredAgeState(finalState, desiredMin, desiredMax)) {
    const actualMax = finalState.ageMax === undefined ? "不限" : String(finalState.ageMax);
    return {
      success: false,
      error: `年龄筛选未精确生效，当前为 ${finalState.ageMin ?? "未知"}-${actualMax}`,
    };
  }

  return { success: true, state: finalState };
}

async function detectAndCloseVipModalInTarget(target: RecommendTarget): Promise<boolean> {
  return await target.evaluate(() => {
    const normalizeText = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };
    const modalPattern =
      /(购买VIP|VIP账号|开通VIP|开启VIP|专享筛选特权|扫码支付|立即开通|支付金额)/;
    const roots = Array.from(document.body.querySelectorAll<HTMLElement>("div, section, aside"))
      .filter(
        (element) => isVisible(element) && modalPattern.test(normalizeText(element.textContent)),
      )
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.width * aRect.height - bRect.width * bRect.height;
      });
    const root = roots[0];
    if (!root) return false;

    const closeCandidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".boss-dialog__close, .dialog-close, .close-btn, [class*='close'], button, span, i",
      ),
    ).filter((element) => isVisible(element));

    for (const candidate of closeCandidates) {
      const text = normalizeText(candidate.textContent);
      const classes = typeof candidate.className === "string" ? candidate.className : "";
      if (text === "×" || text === "关闭" || /close/i.test(classes)) {
        candidate.click();
        break;
      }
    }

    return true;
  });
}

async function detectAndCloseVipModal(page: Page, target: RecommendTarget): Promise<boolean> {
  if (await detectAndCloseVipModalInTarget(target)) {
    return true;
  }

  if (target !== page && (await detectAndCloseVipModalInTarget(page))) {
    return true;
  }

  return false;
}

async function readSelectedOptionTexts(
  target: RecommendTarget,
  rowLabel: string,
  fallback: readonly string[],
): Promise<readonly string[]> {
  return await target.evaluate(
    (args: {
      panelSelector: string;
      rowLabel: string;
      fallback: readonly string[];
      selectedClassPattern: string;
      clickableOptionSelector: string;
    }) => {
      const normalizeText = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };
      const elementArea = (element: Element): number => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const isSelected = (element: Element): boolean => {
        const classes = typeof element.className === "string" ? element.className : "";
        const selectedClassPattern = new RegExp(args.selectedClassPattern, "i");
        return (
          selectedClassPattern.test(classes) ||
          element.getAttribute("aria-checked") === "true" ||
          element.getAttribute("aria-selected") === "true"
        );
      };

      const panel = Array.from(document.querySelectorAll<HTMLElement>(args.panelSelector))
        .filter((element) => isVisible(element))
        .sort((a, b) => elementArea(a) - elementArea(b))[0];
      if (!panel) return args.fallback;

      const row = Array.from(panel.querySelectorAll<HTMLElement>("div, li, dl, dd, section, ul"))
        .filter((element) => {
          const text = normalizeText(element.textContent);
          return isVisible(element) && text.includes(args.rowLabel);
        })
        .sort((a, b) => {
          const areaDelta = elementArea(a) - elementArea(b);
          if (areaDelta !== 0) return areaDelta;
          return normalizeText(a.textContent).length - normalizeText(b.textContent).length;
        })[0];
      if (!row) return args.fallback;

      const selected = Array.from(row.querySelectorAll<HTMLElement>(args.clickableOptionSelector))
        .filter((element) => isVisible(element) && isSelected(element))
        .map((element) => normalizeText(element.textContent))
        .filter((text) => text !== "" && text !== args.rowLabel);

      return Array.from(new Set(selected)).length > 0
        ? Array.from(new Set(selected))
        : args.fallback;
    },
    {
      panelSelector: ZHIPIN_SELECTORS.recommend.filterPanel,
      rowLabel,
      fallback,
      selectedClassPattern: SELECTED_CLASS_PATTERN,
      clickableOptionSelector: CLICKABLE_OPTION_SELECTOR,
    },
  );
}

async function readAppliedState(
  target: RecommendTarget,
  requested: ZhipinRecommendFilterRequest,
  ageState: RecommendAgeState,
): Promise<ZhipinRecommendFilterApplied> {
  const optionSelections = await Promise.all(
    ZHIPIN_RECOMMEND_FILTER_OPTION_FIELDS.map(async (field) => {
      const requestedSelection = requested.optionSelections.find(
        (item) => item.fieldKey === field.key,
      );
      const fallback = requestedSelection?.values ?? [];
      return {
        fieldKey: field.key,
        label: field.label,
        values: await readSelectedOptionTexts(target, field.label, fallback),
      };
    }),
  );
  const gender = optionSelections.find((item) => item.fieldKey === "gender")?.values[0];
  const activity = optionSelections.find((item) => item.fieldKey === "activity")?.values[0];

  return {
    ...(ageState.ageMin !== undefined ? { ageMin: ageState.ageMin } : {}),
    ...(ageState.ageMax !== undefined ? { ageMax: ageState.ageMax } : {}),
    optionSelections,
    ...(gender !== undefined ? { gender } : {}),
    ...(activity !== undefined ? { activity } : {}),
  };
}

async function clickFilterSubmit(
  target: RecommendTarget,
  page: Page,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<boolean> {
  const marked = await target.evaluate(
    (args: { panelSelector: string; markerAttribute: string }) => {
      const normalizeText = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };

      document
        .querySelectorAll(`[${args.markerAttribute}]`)
        .forEach((element) => element.removeAttribute(args.markerAttribute));

      const panel = Array.from(document.querySelectorAll<HTMLElement>(args.panelSelector)).filter(
        (element) => isVisible(element),
      )[0];
      if (!panel) return false;

      const button = Array.from(
        panel.querySelectorAll<HTMLElement>("button, a, span, div, [role='button']"),
      )
        .filter((element) => isVisible(element))
        .find((element) => normalizeText(element.textContent) === "确定");
      if (!button) return false;

      button.setAttribute(args.markerAttribute, "1");
      return true;
    },
    {
      panelSelector: ZHIPIN_SELECTORS.recommend.filterPanel,
      markerAttribute: "data-roll-recommend-filter-submit",
    },
  );

  if (!marked) return false;

  try {
    const submit = target.locator('[data-roll-recommend-filter-submit="1"]').first();
    await showClickFeedback(page, target, submit, visualFeedback);
    await submit.click({ timeout: 2_000 });
    await target.waitForSelector(ZHIPIN_SELECTORS.recommend.filterPanel, {
      state: "hidden",
      timeout: 4_000,
    });
    await target.waitForTimeout(600);
    return true;
  } catch {
    return false;
  }
}

async function clickFilterClear(
  target: RecommendTarget,
  page: Page,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<boolean> {
  const marked = await target.evaluate(
    (args: { panelSelector: string; markerAttribute: string }) => {
      const normalizeText = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };

      document
        .querySelectorAll(`[${args.markerAttribute}]`)
        .forEach((element) => element.removeAttribute(args.markerAttribute));

      const panel = Array.from(document.querySelectorAll<HTMLElement>(args.panelSelector)).filter(
        (element) => isVisible(element),
      )[0];
      if (!panel) return false;

      const button = Array.from(
        panel.querySelectorAll<HTMLElement>("button, a, span, div, [role='button']"),
      )
        .filter((element) => isVisible(element))
        .find((element) => normalizeText(element.textContent) === "清除");
      if (!button) return false;

      button.setAttribute(args.markerAttribute, "1");
      return true;
    },
    {
      panelSelector: ZHIPIN_SELECTORS.recommend.filterPanel,
      markerAttribute: "data-roll-recommend-filter-submit",
    },
  );

  if (!marked) return false;

  try {
    const clear = target.locator('[data-roll-recommend-filter-submit="1"]').first();
    await showClickFeedback(page, target, clear, visualFeedback);
    await clear.click({ timeout: 2_000 });
    await target.waitForTimeout(300);
    return true;
  } catch {
    return false;
  }
}

async function selectRecommendFilterValues(
  target: RecommendTarget,
  page: Page,
  selection: ZhipinRecommendFilterOptionSelection,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<boolean> {
  const values = Array.from(new Set(selection.values.map((value) => value.trim()))).filter(
    (value) => value.length > 0,
  );
  if (values.length === 0) {
    return true;
  }

  if (selection.selection === "single") {
    const value = values[0];
    return value !== undefined
      ? await selectRecommendFilterOption(target, page, selection.label, value, visualFeedback)
      : true;
  }

  if (values.includes(selection.clearValue)) {
    return await selectRecommendFilterOption(
      target,
      page,
      selection.label,
      selection.clearValue,
      visualFeedback,
    );
  }

  if (
    !(await selectRecommendFilterOption(
      target,
      page,
      selection.label,
      selection.clearValue,
      visualFeedback,
    ))
  ) {
    return false;
  }

  for (const value of values) {
    if (
      !(await selectRecommendFilterOption(target, page, selection.label, value, visualFeedback))
    ) {
      return false;
    }
  }

  return true;
}

async function openRecommendFilterPanel(
  target: RecommendTarget,
  page: Page,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<boolean> {
  const isPanelVisible = async (): Promise<boolean> => {
    try {
      const panel = target.locator(ZHIPIN_SELECTORS.recommend.filterPanel).first();
      return (await panel.count()) > 0 && (await panel.isVisible());
    } catch {
      return false;
    }
  };
  const markFallbackFilterButton = async (): Promise<boolean> => {
    return await target.evaluate(
      (args: {
        filterButtonSelector: string;
        markerAttribute: string;
        markerAttributes: readonly string[];
      }) => {
        const normalizeText = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim();
        const isVisible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        };
        const classText = (element: Element): string =>
          typeof element.className === "string" ? element.className : "";
        const scoreCandidate = (element: HTMLElement): number => {
          const classes = classText(element);
          const parentClasses = element.parentElement ? classText(element.parentElement) : "";
          const ancestorClasses =
            element.closest(".recommend-filter, .filter-label-wrap, .filter-wrap") !== null
              ? "recommend-filter"
              : "";
          let score = 0;
          for (const value of [classes, parentClasses, ancestorClasses]) {
            if (/recommend-filter/.test(value)) {
              score += 3;
            } else if (/filter-label/.test(value)) {
              score += 2;
            } else if (/filter/.test(value)) {
              score += 1;
            }
          }
          return score;
        };

        for (const attr of args.markerAttributes) {
          document
            .querySelectorAll(`[${attr}]`)
            .forEach((element) => element.removeAttribute(attr));
        }

        const selectorCandidates = Array.from(
          document.querySelectorAll<HTMLElement>(args.filterButtonSelector),
        );
        const textCandidates = Array.from(
          document.querySelectorAll<HTMLElement>("button, a, span, div, [role='button']"),
        ).filter((element) => /^筛选(?:·\d+)?$/.test(normalizeText(element.textContent)));

        const candidate = [...selectorCandidates, ...textCandidates]
          .filter((element) => isVisible(element))
          .sort((a, b) => {
            const scoreDelta = scoreCandidate(b) - scoreCandidate(a);
            if (scoreDelta !== 0) return scoreDelta;
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return aRect.width * aRect.height - bRect.width * bRect.height;
          })[0];

        if (!candidate) return false;
        candidate.setAttribute(args.markerAttribute, "1");
        return true;
      },
      {
        filterButtonSelector: ZHIPIN_SELECTORS.recommend.filterButton,
        markerAttribute: "data-roll-recommend-filter-button",
        markerAttributes: MARKER_ATTRIBUTES,
      },
    );
  };
  const clickFilterButton = async (): Promise<boolean> => {
    try {
      const filterButton = target.locator(ZHIPIN_SELECTORS.recommend.filterButton).first();
      if ((await filterButton.count()) > 0 && (await filterButton.isVisible())) {
        await filterButton.scrollIntoViewIfNeeded();
        await showClickFeedback(page, target, filterButton, visualFeedback);
        await filterButton.click({ timeout: 2_000 });
        return true;
      }
    } catch {
      // fall through to text-based marker
    }

    if (!(await markFallbackFilterButton())) {
      return false;
    }

    const filterButton = target.locator('[data-roll-recommend-filter-button="1"]').first();
    await showClickFeedback(page, target, filterButton, visualFeedback);
    await filterButton.click({ timeout: 2_000 });
    return true;
  };

  if (await isPanelVisible()) {
    return true;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissPreviousFilterPrompt(target);
    try {
      if (await clickFilterButton()) {
        await target.waitForSelector(ZHIPIN_SELECTORS.recommend.filterPanel, {
          state: "visible",
          timeout: 4_000,
        });
        await dismissPreviousFilterPrompt(target);
        return true;
      }
    } catch {
      // retry while the recommendation frame finishes rendering
    }
    await target.waitForTimeout(300);
  }

  return false;
}

async function applyRecommendFilterInTarget(
  page: Page,
  target: RecommendTarget,
  requested: ZhipinRecommendFilterRequest,
  visualFeedback: RecommendFilterVisualFeedback | undefined,
): Promise<ZhipinRecommendFilterApplyResult> {
  const surfaceReady = await waitForRecommendFilterSurface(target, 3_000);

  if (!(await openRecommendFilterPanel(target, page, visualFeedback))) {
    return buildResult(requested, surfaceReady ? "filter_not_found" : "recommend_not_ready", {
      error: surfaceReady ? "未找到或无法打开筛选按钮" : "推荐牛人页未就绪",
    });
  }

  if (await detectAndCloseVipModal(page, target)) {
    return buildResult(requested, "requires_vip", { error: "筛选条件触发 VIP 弹窗" });
  }

  if (
    requested.applyMode === "replace" &&
    !(await clickFilterClear(target, page, visualFeedback))
  ) {
    return buildResult(requested, "clear_failed", { error: "筛选清除失败" });
  }

  for (const selection of requested.optionSelections) {
    if (!(await selectRecommendFilterValues(target, page, selection, visualFeedback))) {
      if (await detectAndCloseVipModal(page, target)) {
        return buildResult(requested, "requires_vip", {
          error: `${selection.label}筛选触发 VIP 弹窗`,
        });
      }
      return buildResult(requested, "filter_not_found", {
        error: `未找到${selection.label}筛选项：${selection.values.join("、")}`,
      });
    }

    if (await detectAndCloseVipModal(page, target)) {
      return buildResult(requested, "requires_vip", {
        error: `${selection.label}筛选触发 VIP 弹窗`,
      });
    }
  }

  let ageState: RecommendAgeState = {};
  if (shouldApplyRecommendAgeRange(requested)) {
    const ageResult = await setRecommendAgeRange(target, page, requested, visualFeedback);
    if (!ageResult.success) {
      return buildResult(requested, "age_not_applied", { error: ageResult.error });
    }
    ageState = ageResult.state;
  }

  if (await detectAndCloseVipModal(page, target)) {
    return buildResult(requested, "requires_vip", { error: "年龄筛选触发 VIP 弹窗" });
  }

  const applied = await readAppliedState(target, requested, ageState);
  if (!(await clickFilterSubmit(target, page, visualFeedback))) {
    return buildResult(requested, "submit_failed", { applied, error: "筛选确认失败" });
  }

  const filterButtonText = await getFilterButtonText(target);
  return buildResult(requested, "applied", {
    applied,
    ...(filterButtonText !== undefined ? { filterButtonText } : {}),
  });
}

export async function applyRecommendFilter(
  page: Page,
  target: RecommendTarget,
  requested: ZhipinRecommendFilterRequest,
  visualFeedback?: RecommendFilterVisualFeedback,
): Promise<ZhipinRecommendFilterApplyResult> {
  const primaryResult = await applyRecommendFilterInTarget(page, target, requested, visualFeedback);
  if (
    target !== page &&
    (primaryResult.status === "filter_not_found" || primaryResult.status === "recommend_not_ready")
  ) {
    const fallbackResult = await applyRecommendFilterInTarget(
      page,
      page,
      requested,
      visualFeedback,
    );
    if (
      fallbackResult.status !== "filter_not_found" &&
      fallbackResult.status !== "recommend_not_ready"
    ) {
      return fallbackResult;
    }
  }

  return primaryResult;
}
