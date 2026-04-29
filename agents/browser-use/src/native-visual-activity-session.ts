import { isVisualActivityEnabled } from "./visual-activity.ts";
import type { VisualActivityTone } from "./visual-activity.ts";
import { isVisualCursorEnabled } from "./visual-cursor.ts";
import type { NativeMouseMotionObserver, NativeMouseMotionPreview } from "./native-mouse-motion.ts";

type NativeVisualTarget = {
  evaluateJson<T = unknown>(expression: string): Promise<T>;
};

type NativeVisualHighlightOptions = {
  readonly label?: string;
  readonly padding?: number;
  readonly tone?: VisualActivityTone;
};

const DEFAULT_REGION_PADDING = 14;
const DEFAULT_COMPLETION_LINGER_MS = 720;

function buildNativeVisualScript(args: unknown): string {
  return `(() => {
    const args = ${JSON.stringify(args)};
    const activityRootId = "roll-agent-visual-activity-root";
    const activityViewportId = "roll-agent-visual-activity-viewport";
    const activityRegionId = "roll-agent-visual-activity-region";
    const activityCapsuleId = "roll-agent-visual-activity-capsule";
    const activityDotId = "roll-agent-visual-activity-dot";
    const activityLabelId = "roll-agent-visual-activity-label";
    const cursorRootId = "roll-agent-visual-cursor-root";
    const cursorPointerId = "roll-agent-visual-cursor-pointer";
    const cursorStateKey = "__rollVisualCursorState";

    const themes = {
      info: {
        accent: "#14b8a6",
        accentSoft: "rgba(20, 184, 166, 0.42)",
        accentGlow: "rgba(20, 184, 166, 0.18)",
        capsuleBg: "rgba(15, 23, 42, 0.82)",
        capsuleBorder: "rgba(45, 212, 191, 0.38)",
        text: "#F8FAFC",
        dot: "#2DD4BF"
      },
      success: {
        accent: "#22c55e",
        accentSoft: "rgba(34, 197, 94, 0.42)",
        accentGlow: "rgba(34, 197, 94, 0.18)",
        capsuleBg: "rgba(10, 24, 16, 0.86)",
        capsuleBorder: "rgba(74, 222, 128, 0.38)",
        text: "#F0FDF4",
        dot: "#4ADE80"
      },
      error: {
        accent: "#f59e0b",
        accentSoft: "rgba(245, 158, 11, 0.42)",
        accentGlow: "rgba(245, 158, 11, 0.2)",
        capsuleBg: "rgba(41, 24, 10, 0.88)",
        capsuleBorder: "rgba(251, 191, 36, 0.4)",
        text: "#FFFBEB",
        dot: "#FBBF24"
      }
    };

    const readRect = (selector, padding) => {
      if (!selector) return null;
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const safePadding = Math.max(padding ?? 0, 0);
      const left = Math.max(rect.left - safePadding, 0);
      const top = Math.max(rect.top - safePadding, 0);
      const right = Math.min(rect.right + safePadding, window.innerWidth);
      const bottom = Math.min(rect.bottom + safePadding, window.innerHeight);
      return {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.max(Math.round(right - left), 0),
        height: Math.max(Math.round(bottom - top), 0),
        centerX: Math.round(rect.left + rect.width / 2),
        centerY: Math.round(rect.top + rect.height / 2)
      };
    };

    const ensureActivityRoot = () => {
      let root = document.getElementById(activityRootId);
      if (root) return root;
      root = document.createElement("div");
      root.id = activityRootId;
      root.style.position = "fixed";
      root.style.inset = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483646";

      const viewport = document.createElement("div");
      viewport.id = activityViewportId;
      viewport.style.position = "fixed";
      viewport.style.inset = "10px";
      viewport.style.borderRadius = "20px";
      viewport.style.opacity = "0";
      viewport.style.transition = "opacity 180ms ease";

      const region = document.createElement("div");
      region.id = activityRegionId;
      region.style.position = "fixed";
      region.style.left = "0";
      region.style.top = "0";
      region.style.width = "0";
      region.style.height = "0";
      region.style.borderRadius = "18px";
      region.style.opacity = "0";
      region.style.transform = "translate(-9999px, -9999px)";
      region.style.transition =
        "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), width 220ms ease, height 220ms ease, opacity 180ms ease";

      const capsule = document.createElement("div");
      capsule.id = activityCapsuleId;
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
      capsule.style.fontSize = "13px";
      capsule.style.fontWeight = "600";
      capsule.style.lineHeight = "18px";
      capsule.style.whiteSpace = "nowrap";

      const dot = document.createElement("div");
      dot.id = activityDotId;
      dot.style.width = "8px";
      dot.style.height = "8px";
      dot.style.borderRadius = "999px";

      const label = document.createElement("div");
      label.id = activityLabelId;
      label.setAttribute("aria-live", "polite");

      capsule.append(dot, label);
      root.append(viewport, region, capsule);
      document.documentElement.append(root);
      return root;
    };

    const applyTheme = (themeName) => {
      const theme = themes[themeName] ?? themes.info;
      const viewport = document.getElementById(activityViewportId);
      const region = document.getElementById(activityRegionId);
      const capsule = document.getElementById(activityCapsuleId);
      const dot = document.getElementById(activityDotId);
      if (!viewport || !region || !capsule || !dot) return;
      viewport.style.border = "1px solid " + theme.accentSoft;
      viewport.style.boxShadow =
        "inset 0 0 0 1px " + theme.accentSoft + ", 0 0 52px " + theme.accentGlow;
      region.style.border = "1px solid " + theme.accentSoft;
      region.style.background = theme.accentGlow;
      region.style.boxShadow =
        "0 0 0 1px " + theme.accentSoft + ", 0 16px 42px " + theme.accentGlow;
      capsule.style.border = "1px solid " + theme.capsuleBorder;
      capsule.style.background = theme.capsuleBg;
      capsule.style.color = theme.text;
      capsule.style.boxShadow =
        "0 18px 46px rgba(15, 23, 42, 0.24), 0 0 0 1px " + theme.capsuleBorder;
      dot.style.background = theme.dot;
      dot.style.boxShadow = "0 0 0 5px " + theme.accentGlow;
    };

    const renderActivity = () => {
      if (!args.activity) return;
      ensureActivityRoot();
      applyTheme(args.activity.tone ?? "info");
      const viewport = document.getElementById(activityViewportId);
      const region = document.getElementById(activityRegionId);
      const capsule = document.getElementById(activityCapsuleId);
      const label = document.getElementById(activityLabelId);
      if (!viewport || !region || !capsule || !label) return;

      if (args.activity.mode === "clear") {
        viewport.style.opacity = "0";
        region.style.opacity = "0";
        region.style.transform = "translate(-9999px, -9999px)";
        capsule.style.opacity = "0";
        capsule.style.transform = "translate(-50%, -8px)";
        return;
      }

      if (typeof args.activity.label === "string") {
        label.textContent = args.activity.label;
      }

      viewport.style.opacity = args.activity.mode === "complete" ? "0.9" : "0.72";
      capsule.style.opacity = "1";
      capsule.style.transform = "translate(-50%, 0)";

      const rect = args.activity.selector
        ? readRect(args.activity.selector, args.activity.padding ?? 14)
        : null;
      if (rect) {
        region.style.width = rect.width + "px";
        region.style.height = rect.height + "px";
        region.style.transform = "translate(" + rect.x + "px, " + rect.y + "px)";
        region.style.opacity = "1";
      } else {
        region.style.opacity = "0";
        region.style.transform = "translate(-9999px, -9999px)";
      }

      if (args.activity.mode === "complete") {
        window.setTimeout(() => {
          viewport.style.opacity = "0";
          region.style.opacity = "0";
          capsule.style.opacity = "0";
          capsule.style.transform = "translate(-50%, -8px)";
        }, Math.max(args.activity.lingerMs ?? 720, 0));
      }
    };

    const ensureCursorRoot = () => {
      let root = document.getElementById(cursorRootId);
      if (root) return root;
      root = document.createElement("div");
      root.id = cursorRootId;
      root.style.position = "fixed";
      root.style.left = "0";
      root.style.top = "0";
      root.style.width = "0";
      root.style.height = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483647";

      const pointer = document.createElement("div");
      pointer.id = cursorPointerId;
      pointer.setAttribute("aria-hidden", "true");
      pointer.style.position = "fixed";
      pointer.style.left = "0";
      pointer.style.top = "0";
      pointer.style.width = "24px";
      pointer.style.height = "24px";
      pointer.style.opacity = "0";
      pointer.style.transform = "translate(-9999px, -9999px)";
      pointer.style.willChange = "transform, opacity";
      pointer.style.filter = "drop-shadow(0 4px 8px rgba(15, 23, 42, 0.28))";
      pointer.innerHTML =
        '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M4 2L18 14L11.4 15.3L14.6 22L10.7 23.5L7.6 16.8L3 21V2Z" fill="#FFFFFF" stroke="#0F172A" stroke-width="1.5" stroke-linejoin="round"/>' +
        '</svg>';

      root.append(pointer);
      document.documentElement.append(root);
      return root;
    };

    const readCursorPath = () => {
      if (!Array.isArray(args.cursor?.path?.points)) return null;
      const points = args.cursor.path.points
        .map((point) => {
          const x = Number(point?.x);
          const y = Number(point?.y);
          return Number.isFinite(x) && Number.isFinite(y)
            ? { centerX: Math.round(x), centerY: Math.round(y) }
            : null;
        })
        .filter((point) => point !== null);
      return points.length > 0 ? points : null;
    };

    const renderCursor = () => {
      const path = readCursorPath();
      const point = path ? path[path.length - 1] : null;
      if (!point) return;
      ensureCursorRoot();
      const pointer = document.getElementById(cursorPointerId);
      if (!pointer) return;
      const targetX = point.centerX - 2;
      const targetY = point.centerY - 2;
      if (path && path.length > 1 && typeof pointer.animate === "function") {
        for (const animation of pointer.getAnimations()) {
          animation.cancel();
        }
        pointer.style.opacity = "1";
        const keyframes = path.map((entry) => ({
          transform: "translate(" + (entry.centerX - 2) + "px, " + (entry.centerY - 2) + "px)"
        }));
        const duration = Math.max(args.cursor.path.durationMs ?? 180, 0);
        const animation = pointer.animate(keyframes, {
          duration,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards"
        });
        animation.onfinish = () => {
          pointer.style.transform = "translate(" + targetX + "px, " + targetY + "px)";
        };
        window[cursorStateKey] = { x: point.centerX, y: point.centerY };
        return;
      }
      pointer.style.transition = "opacity 120ms ease";
      pointer.style.opacity = "1";
      pointer.style.transform = "translate(" + targetX + "px, " + targetY + "px)";
      window[cursorStateKey] = { x: point.centerX, y: point.centerY };
    };

    renderActivity();
    renderCursor();
    return true;
  })()`;
}

export class NativeVisualActivitySession implements NativeMouseMotionObserver {
  private readonly target: NativeVisualTarget;

  constructor(target: NativeVisualTarget) {
    this.target = target;
  }

  async begin(label: string, tone: VisualActivityTone = "info"): Promise<boolean> {
    if (!isVisualActivityEnabled()) {
      return false;
    }

    return await this.render({
      activity: {
        mode: "begin",
        label,
        tone,
      },
    });
  }

  async highlightSelector(
    selector: string,
    options: NativeVisualHighlightOptions = {},
  ): Promise<boolean> {
    const payload = {
      ...(isVisualActivityEnabled()
        ? {
            activity: {
              mode: "highlight",
              selector,
              label: options.label,
              padding: options.padding ?? DEFAULT_REGION_PADDING,
              tone: options.tone ?? "info",
            },
          }
        : {}),
    };

    if (!("activity" in payload)) {
      return false;
    }

    return await this.render(payload);
  }

  async previewMouseMotion(preview: NativeMouseMotionPreview): Promise<void> {
    if (!isVisualCursorEnabled() || preview.points.length === 0) {
      return;
    }

    await this.render({
      cursor: {
        path: {
          points: preview.points,
          durationMs: preview.durationMs,
        },
      },
    });
  }

  async succeed(label: string, lingerMs = DEFAULT_COMPLETION_LINGER_MS): Promise<boolean> {
    if (!isVisualActivityEnabled()) {
      return false;
    }

    return await this.render({
      activity: {
        mode: "complete",
        label,
        tone: "success",
        lingerMs,
      },
    });
  }

  async fail(label: string, lingerMs = DEFAULT_COMPLETION_LINGER_MS): Promise<boolean> {
    if (!isVisualActivityEnabled()) {
      return false;
    }

    return await this.render({
      activity: {
        mode: "complete",
        label,
        tone: "error",
        lingerMs,
      },
    });
  }

  async clear(): Promise<boolean> {
    if (!isVisualActivityEnabled()) {
      return false;
    }

    return await this.render({
      activity: {
        mode: "clear",
      },
    });
  }

  private async render(args: unknown): Promise<boolean> {
    try {
      return await this.target.evaluateJson<boolean>(buildNativeVisualScript(args));
    } catch {
      return false;
    }
  }
}
