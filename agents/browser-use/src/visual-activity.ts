import type { Page } from "@roll-agent/browser";

type PageLocator = ReturnType<Page["locator"]>;
export type VisualTarget = Page | NonNullable<ReturnType<Page["frame"]>>;

type VisualRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const VISUAL_ACTIVITY_TONES = ["info", "success", "error"] as const;
export type VisualActivityTone = (typeof VISUAL_ACTIVITY_TONES)[number];

type VisualActivityTheme = {
  readonly accent: string;
  readonly accentSoft: string;
  readonly accentGlow: string;
  readonly capsuleBg: string;
  readonly capsuleBorder: string;
  readonly text: string;
  readonly dot: string;
};

type VisualActivityOptions = {
  readonly label: string;
  readonly target?: VisualTarget;
  readonly tone?: VisualActivityTone;
};

type VisualHighlightOptions = {
  readonly label?: string;
  readonly padding?: number;
  readonly target?: VisualTarget;
  readonly tone?: VisualActivityTone;
};

type VisualCompletionOptions = {
  readonly label: string;
  readonly lingerMs?: number;
  readonly status?: "success" | "error";
  readonly target?: VisualTarget;
};

const VISUAL_ACTIVITY_THEMES = {
  info: {
    accent: "#14b8a6",
    accentSoft: "rgba(20, 184, 166, 0.42)",
    accentGlow: "rgba(20, 184, 166, 0.18)",
    capsuleBg: "rgba(15, 23, 42, 0.82)",
    capsuleBorder: "rgba(45, 212, 191, 0.38)",
    text: "#F8FAFC",
    dot: "#2DD4BF",
  },
  success: {
    accent: "#22c55e",
    accentSoft: "rgba(34, 197, 94, 0.42)",
    accentGlow: "rgba(34, 197, 94, 0.18)",
    capsuleBg: "rgba(10, 24, 16, 0.86)",
    capsuleBorder: "rgba(74, 222, 128, 0.38)",
    text: "#F0FDF4",
    dot: "#4ADE80",
  },
  error: {
    accent: "#f59e0b",
    accentSoft: "rgba(245, 158, 11, 0.42)",
    accentGlow: "rgba(245, 158, 11, 0.2)",
    capsuleBg: "rgba(41, 24, 10, 0.88)",
    capsuleBorder: "rgba(251, 191, 36, 0.4)",
    text: "#FFFBEB",
    dot: "#FBBF24",
  },
} as const satisfies Record<VisualActivityTone, VisualActivityTheme>;

const DEFAULT_REGION_PADDING = 14;
const DEFAULT_COMPLETION_LINGER_MS = 720;

let visualActivityEnabledOverride: boolean | undefined;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function resolveTheme(tone: VisualActivityTone = "info"): VisualActivityTheme {
  return VISUAL_ACTIVITY_THEMES[tone];
}

export function isVisualActivityEnabled(): boolean {
  if (visualActivityEnabledOverride !== undefined) {
    return visualActivityEnabledOverride;
  }

  return parseBooleanEnv(process.env["BROWSER_VISUAL_ACTIVITY"]) ?? true;
}

export function setVisualActivityEnabledForTests(value: boolean | undefined): void {
  visualActivityEnabledOverride = value;
}

async function readLocatorRect(
  locator: PageLocator,
  padding = DEFAULT_REGION_PADDING,
): Promise<VisualRect | null> {
  return await locator.evaluate(
    (element, extraPadding: number) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      const viewportWidth = globalThis.innerWidth;
      const viewportHeight = globalThis.innerHeight;
      const safePadding = Math.max(extraPadding, 0);
      const left = Math.max(rect.left - safePadding, 0);
      const top = Math.max(rect.top - safePadding, 0);
      const right = Math.min(rect.right + safePadding, viewportWidth);
      const bottom = Math.min(rect.bottom + safePadding, viewportHeight);

      return {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.max(Math.round(right - left), 0),
        height: Math.max(Math.round(bottom - top), 0),
      };
    },
    padding,
  );
}

async function renderActivityFrame(
  target: VisualTarget,
  input: {
    readonly mode: "begin" | "highlight" | "complete" | "clear";
    readonly label?: string;
    readonly theme?: VisualActivityTheme;
    readonly rect?: VisualRect;
    readonly lingerMs?: number;
  },
): Promise<void> {
  await target.evaluate((args) => {
    const styleId = "roll-agent-visual-activity-style";
    const rootId = "roll-agent-visual-activity-root";
    const viewportId = "roll-agent-visual-activity-viewport";
    const regionId = "roll-agent-visual-activity-region";
    const shineId = "roll-agent-visual-activity-region-shine";
    const capsuleId = "roll-agent-visual-activity-capsule";
    const dotId = "roll-agent-visual-activity-dot";
    const labelId = "roll-agent-visual-activity-label";
    const stateKey = "__rollVisualActivityTimers";

    const ensureStyle = (): void => {
      if (document.getElementById(styleId)) {
        return;
      }

      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        @keyframes roll-visual-activity-breathe {
          0%, 100% { transform: translate(-50%, 0px) scale(1); }
          50% { transform: translate(-50%, -1px) scale(1.01); }
        }
        @keyframes roll-visual-activity-scan {
          0% { transform: translateX(-140%) skewX(-18deg); }
          100% { transform: translateX(200%) skewX(-18deg); }
        }
      `;
      document.head.append(style);
    };

    const ensureRoot = (): HTMLElement => {
      const existing = document.getElementById(rootId);
      if (existing) {
        return existing;
      }

      const root = document.createElement("div");
      root.id = rootId;
      root.style.position = "fixed";
      root.style.inset = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483646";

      const viewport = document.createElement("div");
      viewport.id = viewportId;
      viewport.setAttribute("aria-hidden", "true");
      viewport.style.position = "fixed";
      viewport.style.inset = "10px";
      viewport.style.borderRadius = "20px";
      viewport.style.opacity = "0";
      viewport.style.transform = "scale(0.995)";
      viewport.style.transition = "opacity 180ms ease, transform 220ms ease";

      const region = document.createElement("div");
      region.id = regionId;
      region.setAttribute("aria-hidden", "true");
      region.style.position = "fixed";
      region.style.left = "0";
      region.style.top = "0";
      region.style.width = "0";
      region.style.height = "0";
      region.style.borderRadius = "18px";
      region.style.opacity = "0";
      region.style.overflow = "hidden";
      region.style.transform = "translate(-9999px, -9999px)";
      region.style.transition =
        "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), width 220ms ease, height 220ms ease, opacity 180ms ease";

      const shine = document.createElement("div");
      shine.id = shineId;
      shine.setAttribute("aria-hidden", "true");
      shine.style.position = "absolute";
      shine.style.inset = "0";
      shine.style.animation = "roll-visual-activity-scan 1.6s linear infinite";
      shine.style.opacity = "0.9";
      region.append(shine);

      const capsule = document.createElement("div");
      capsule.id = capsuleId;
      capsule.setAttribute("aria-hidden", "true");
      capsule.style.position = "fixed";
      capsule.style.left = "50%";
      capsule.style.top = "20px";
      capsule.style.display = "inline-flex";
      capsule.style.alignItems = "center";
      capsule.style.gap = "10px";
      capsule.style.padding = "10px 14px";
      capsule.style.borderRadius = "999px";
      capsule.style.opacity = "0";
      capsule.style.transform = "translate(-50%, -8px)";
      capsule.style.transition = "opacity 180ms ease, transform 220ms ease";
      capsule.style.backdropFilter = "blur(12px)";
      capsule.style.animation = "roll-visual-activity-breathe 1.8s ease-in-out infinite";
      capsule.style.fontSize = "13px";
      capsule.style.fontWeight = "600";
      capsule.style.lineHeight = "18px";
      capsule.style.letterSpacing = "0.01em";
      capsule.style.whiteSpace = "nowrap";

      const dot = document.createElement("div");
      dot.id = dotId;
      dot.setAttribute("aria-hidden", "true");
      dot.style.width = "8px";
      dot.style.height = "8px";
      dot.style.borderRadius = "999px";
      dot.style.flex = "0 0 auto";

      const label = document.createElement("div");
      label.id = labelId;
      label.setAttribute("aria-live", "polite");

      capsule.append(dot, label);
      root.append(viewport, region, capsule);
      document.documentElement.append(root);
      return root;
    };

    const hideEverything = (
      viewport: HTMLElement,
      region: HTMLElement,
      capsule: HTMLElement,
      immediate = false,
    ): void => {
      if (immediate) {
        viewport.style.transition = "none";
        region.style.transition = "none";
        capsule.style.transition = "none";
      }

      viewport.style.opacity = "0";
      viewport.style.transform = "scale(0.995)";
      region.style.opacity = "0";
      capsule.style.opacity = "0";
      capsule.style.transform = "translate(-50%, -8px)";
      region.style.transform = "translate(-9999px, -9999px)";

      if (immediate) {
        requestAnimationFrame(() => {
          viewport.style.transition = "opacity 180ms ease, transform 220ms ease";
          region.style.transition =
            "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), width 220ms ease, height 220ms ease, opacity 180ms ease";
          capsule.style.transition = "opacity 180ms ease, transform 220ms ease";
        });
      }
    };

    ensureStyle();
    ensureRoot();

    const viewport = document.getElementById(viewportId) as HTMLElement | null;
    const region = document.getElementById(regionId) as HTMLElement | null;
    const shine = document.getElementById(shineId) as HTMLElement | null;
    const capsule = document.getElementById(capsuleId) as HTMLElement | null;
    const dot = document.getElementById(dotId) as HTMLElement | null;
    const label = document.getElementById(labelId) as HTMLElement | null;
    if (!viewport || !region || !shine || !capsule || !dot || !label) {
      return;
    }

    const timers = ((window as typeof window & {
      [stateKey]:
        | {
            hideTimer?: ReturnType<typeof globalThis.setTimeout> | undefined;
          }
        | undefined;
    })[stateKey] ??= {});
    if (timers.hideTimer !== undefined) {
      globalThis.clearTimeout(timers.hideTimer);
      delete timers.hideTimer;
    }

    if (args.mode === "clear") {
      hideEverything(viewport, region, capsule, true);
      return;
    }

    const theme = args.theme;
    if (theme !== undefined) {
      viewport.style.border = `1px solid ${theme.accentSoft}`;
      viewport.style.boxShadow = `inset 0 0 0 1px ${theme.accentSoft}, 0 0 52px ${theme.accentGlow}`;
      capsule.style.border = `1px solid ${theme.capsuleBorder}`;
      capsule.style.background = theme.capsuleBg;
      capsule.style.color = theme.text;
      capsule.style.boxShadow = `0 18px 46px rgba(15, 23, 42, 0.24), 0 0 0 1px ${theme.capsuleBorder}`;
      dot.style.background = theme.dot;
      dot.style.boxShadow = `0 0 0 5px ${theme.accentGlow}`;
      region.style.border = `1px solid ${theme.accentSoft}`;
      region.style.background = theme.accentGlow;
      region.style.boxShadow = `0 0 0 1px ${theme.accentSoft}, 0 16px 42px ${theme.accentGlow}`;
      shine.style.background =
        "linear-gradient(115deg, transparent 0%, rgba(255,255,255,0.08) 24%, rgba(255,255,255,0.42) 50%, transparent 76%)";
    }

    if (args.label !== undefined) {
      label.textContent = args.label;
    }

    capsule.style.opacity = "1";
    capsule.style.transform = "translate(-50%, 0)";
    viewport.style.opacity = args.mode === "complete" ? "0.9" : "0.72";
    viewport.style.transform = "scale(1)";

    if (args.mode === "begin") {
      region.style.opacity = "0";
      region.style.transform = "translate(-9999px, -9999px)";
      return;
    }

    if (args.rect !== undefined) {
      region.style.width = `${args.rect.width}px`;
      region.style.height = `${args.rect.height}px`;
      region.style.transform = `translate(${args.rect.x}px, ${args.rect.y}px)`;
      region.style.opacity = "1";
    }

    if (args.mode !== "complete") {
      return;
    }

    const lingerMs = Math.max(args.lingerMs ?? 0, 0);
    timers.hideTimer = globalThis.setTimeout(() => {
      hideEverything(viewport, region, capsule);
      delete timers.hideTimer;
    }, lingerMs);
  }, input);
}

export async function beginVisualActivity(
  page: Page,
  options: VisualActivityOptions,
): Promise<boolean> {
  if (!isVisualActivityEnabled() || page.isClosed()) {
    return false;
  }

  try {
    await renderActivityFrame(options.target ?? page, {
      mode: "begin",
      label: options.label,
      theme: resolveTheme(options.tone ?? "info"),
    });
    return true;
  } catch {
    return false;
  }
}

export async function highlightVisualRegionForLocator(
  page: Page,
  locator: PageLocator,
  options: VisualHighlightOptions = {},
): Promise<boolean> {
  if (!isVisualActivityEnabled() || page.isClosed()) {
    return false;
  }

  try {
    await locator.scrollIntoViewIfNeeded();
    const rect = await readLocatorRect(locator, options.padding ?? DEFAULT_REGION_PADDING);
    if (!rect) {
      return false;
    }

    await renderActivityFrame(options.target ?? page, {
      mode: "highlight",
      ...(options.label !== undefined ? { label: options.label } : {}),
      theme: resolveTheme(options.tone ?? "info"),
      rect,
    });
    return true;
  } catch {
    return false;
  }
}

export async function highlightVisualRegionForSelector(
  page: Page,
  selector: string,
  options?: VisualHighlightOptions,
): Promise<boolean> {
  return await highlightVisualRegionForLocator(page, page.locator(selector).first(), options);
}

export async function completeVisualActivity(
  page: Page,
  options: VisualCompletionOptions,
): Promise<boolean> {
  if (!isVisualActivityEnabled() || page.isClosed()) {
    return false;
  }

  try {
    await renderActivityFrame(options.target ?? page, {
      mode: "complete",
      label: options.label,
      theme: resolveTheme(options.status === "error" ? "error" : "success"),
      lingerMs: options.lingerMs ?? DEFAULT_COMPLETION_LINGER_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function clearVisualActivity(
  page: Page,
  options: { readonly target?: VisualTarget } = {},
): Promise<boolean> {
  if (!isVisualActivityEnabled() || page.isClosed()) {
    return false;
  }

  try {
    await renderActivityFrame(options.target ?? page, { mode: "clear" });
    return true;
  } catch {
    return false;
  }
}
