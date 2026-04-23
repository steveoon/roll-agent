import type { Page } from "@roll-agent/browser";

type PageLocator = ReturnType<Page["locator"]>;
type VisualTarget = Page | NonNullable<ReturnType<Page["frame"]>>;

type CursorPoint = {
  readonly x: number;
  readonly y: number;
};

type CursorMoveOptions = {
  readonly durationMs?: number;
  readonly settleMs?: number;
  readonly target?: VisualTarget;
};

type CursorClickOptions = {
  readonly pulseDurationMs?: number;
  readonly target?: VisualTarget;
};

const DEFAULT_MOVE_DURATION_MS = 180;
const DEFAULT_SETTLE_MS = 60;
const CLICK_PULSE_DURATION_MS = 280;
const VISUAL_CURSOR_ROOT_ID = "roll-agent-visual-cursor-root";
const VISUAL_CURSOR_STATE_KEY = "__rollVisualCursorState";

let visualCursorEnabledOverride: boolean | undefined;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function isVisualCursorEnabled(): boolean {
  if (visualCursorEnabledOverride !== undefined) {
    return visualCursorEnabledOverride;
  }

  return parseBooleanEnv(process.env["BROWSER_VISUAL_CURSOR"]) ?? true;
}

export function setVisualCursorEnabledForTests(value: boolean | undefined): void {
  visualCursorEnabledOverride = value;
}

async function readLocatorPoint(locator: PageLocator): Promise<CursorPoint | null> {
  return await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  });
}

async function renderCursorFrame(
  target: VisualTarget,
  args: {
    readonly point: CursorPoint;
    readonly durationMs: number;
    readonly clickPulse: boolean;
    readonly pulseDurationMs: number;
  },
): Promise<void> {
  await target.evaluate(
    (input) => {
      const rootId = "roll-agent-visual-cursor-root";
      const pointerId = "roll-agent-visual-cursor-pointer";
      const stateKey = "__rollVisualCursorState";

      const ensureRoot = (): HTMLElement => {
        const existing = document.getElementById(rootId);
        if (existing) {
          return existing;
        }

        const root = document.createElement("div");
        root.id = rootId;
        root.style.position = "fixed";
        root.style.left = "0";
        root.style.top = "0";
        root.style.width = "0";
        root.style.height = "0";
        root.style.pointerEvents = "none";
        root.style.zIndex = "2147483647";

        const pointer = document.createElement("div");
        pointer.id = pointerId;
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
          '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" ' +
          'xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M4 2L18 14L11.4 15.3L14.6 22L10.7 23.5L7.6 16.8L3 21V2Z" ' +
          'fill="#FFFFFF" stroke="#0F172A" stroke-width="1.5" stroke-linejoin="round"/>' +
          "</svg>";

        root.append(pointer);
        document.documentElement.append(root);
        return root;
      };

      const root = ensureRoot();
      const pointer = root.querySelector(`#${pointerId}`) as HTMLElement | null;
      if (!pointer) {
        return;
      }

      const stateRecord = (window as typeof window & {
        [stateKey]: { x: number; y: number } | undefined;
      })[stateKey];
      const point = input.point;
      const durationMs = input.durationMs;
      const targetX = point.x - 2;
      const targetY = point.y - 2;

      if (!stateRecord) {
        pointer.style.transition = "opacity 120ms ease";
        pointer.style.transform = `translate(${targetX}px, ${targetY}px)`;
      } else {
        pointer.style.transition =
          `transform ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1), opacity 120ms ease`;
      }

      pointer.style.opacity = "1";
      pointer.style.transform = `translate(${targetX}px, ${targetY}px)`;

      (window as typeof window & {
        [stateKey]: { x: number; y: number };
      })[stateKey] = { x: point.x, y: point.y };

      if (!input.clickPulse) {
        return;
      }

      const pulse = document.createElement("div");
      pulse.setAttribute("aria-hidden", "true");
      pulse.style.position = "fixed";
      pulse.style.left = "0";
      pulse.style.top = "0";
      pulse.style.width = "18px";
      pulse.style.height = "18px";
      pulse.style.borderRadius = "9999px";
      pulse.style.border = "2px solid rgba(20, 184, 166, 0.95)";
      pulse.style.background = "rgba(20, 184, 166, 0.18)";
      pulse.style.pointerEvents = "none";
      pulse.style.opacity = "0.9";
      pulse.style.transform = `translate(${point.x - 9}px, ${point.y - 9}px) scale(0.55)`;
      pulse.style.transition =
        `transform ${input.pulseDurationMs}ms ease, opacity ${input.pulseDurationMs}ms ease`;
      root.append(pulse);

      requestAnimationFrame(() => {
        pulse.style.opacity = "0";
        pulse.style.transform = `translate(${point.x - 18}px, ${point.y - 18}px) scale(2)`;
      });

      globalThis.setTimeout(() => {
        pulse.remove();
      }, input.pulseDurationMs + 40);
    },
    {
      point: args.point,
      durationMs: args.durationMs,
      clickPulse: args.clickPulse,
      pulseDurationMs: args.pulseDurationMs,
    },
  );
}

function getCursorTargets(page: Page): VisualTarget[] {
  const targets: VisualTarget[] = [page];
  const frames = typeof page.frames === "function" ? page.frames() : [];
  targets.push(...frames);
  return targets;
}

async function clearCursorFrame(target: VisualTarget): Promise<void> {
  await target.evaluate(
    ({
      rootId,
      stateKey,
    }: {
      readonly rootId: string;
      readonly stateKey: string;
    }) => {
      document.getElementById(rootId)?.remove();
      delete (window as typeof window & Record<string, unknown>)[stateKey];
    },
    {
      rootId: VISUAL_CURSOR_ROOT_ID,
      stateKey: VISUAL_CURSOR_STATE_KEY,
    },
  );
}

export async function clearVisualCursor(
  page: Page,
  options: { readonly preserveTarget?: VisualTarget } = {},
): Promise<boolean> {
  if (page.isClosed()) {
    return false;
  }

  let cleared = false;
  for (const target of getCursorTargets(page)) {
    if (target === options.preserveTarget) {
      continue;
    }

    try {
      await clearCursorFrame(target);
      cleared = true;
    } catch {
      // ignore detached frames / stale contexts
    }
  }
  return cleared;
}

export async function moveVisualCursorToLocator(
  page: Page,
  locator: PageLocator,
  options: CursorMoveOptions = {},
): Promise<boolean> {
  if (!isVisualCursorEnabled() || page.isClosed()) {
    return false;
  }

  try {
    await locator.scrollIntoViewIfNeeded();
    const point = await readLocatorPoint(locator);
    if (!point) {
      return false;
    }

    const durationMs = options.durationMs ?? DEFAULT_MOVE_DURATION_MS;
    const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    const target = options.target ?? page;
    await clearVisualCursor(page, { preserveTarget: target });
    await renderCursorFrame(options.target ?? page, {
      point,
      durationMs,
      clickPulse: false,
      pulseDurationMs: CLICK_PULSE_DURATION_MS,
    });
    await page.waitForTimeout(Math.max(durationMs + settleMs, 0));
    return true;
  } catch {
    return false;
  }
}

export async function showVisualClickOnLocator(
  page: Page,
  locator: PageLocator,
  options: CursorClickOptions = {},
): Promise<boolean> {
  if (!isVisualCursorEnabled() || page.isClosed()) {
    return false;
  }

  try {
    const point = await readLocatorPoint(locator);
    if (!point) {
      return false;
    }

    const pulseDurationMs = options.pulseDurationMs ?? CLICK_PULSE_DURATION_MS;
    const target = options.target ?? page;
    await clearVisualCursor(page, { preserveTarget: target });
    await renderCursorFrame(target, {
      point,
      durationMs: 0,
      clickPulse: true,
      pulseDurationMs,
    });
    await page.waitForTimeout(pulseDurationMs);
    return true;
  } catch {
    return false;
  }
}

export async function moveVisualCursorToSelector(
  page: Page,
  selector: string,
  options?: CursorMoveOptions,
): Promise<boolean> {
  return await moveVisualCursorToLocator(page, page.locator(selector).first(), options);
}

export async function showVisualClickOnSelector(page: Page, selector: string): Promise<boolean> {
  return await showVisualClickOnLocator(page, page.locator(selector).first());
}
