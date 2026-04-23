import type { Page } from "@roll-agent/browser";
import {
  beginVisualActivity,
  clearVisualActivity,
  completeVisualActivity,
  highlightVisualRegionForLocator,
  highlightVisualRegionForSelector,
} from "./visual-activity.ts";
import type { VisualActivityTone, VisualTarget } from "./visual-activity.ts";

type PageLocator = ReturnType<Page["locator"]>;

type VisualActivityHighlightOptions = {
  readonly label?: string;
  readonly padding?: number;
  readonly tone?: VisualActivityTone;
};

function isFrameTarget(
  target: VisualTarget,
): target is Exclude<VisualTarget, Page> {
  return typeof (target as { page?: unknown }).page === "function";
}

function resolveOwnerPage(target: VisualTarget): Page {
  return isFrameTarget(target) ? target.page() : target;
}

export class VisualActivitySession {
  page: Page;
  target: VisualTarget;

  constructor(initialTarget: VisualTarget) {
    this.page = resolveOwnerPage(initialTarget);
    this.target = initialTarget;
  }

  async retarget(nextTarget: VisualTarget): Promise<boolean> {
    if (nextTarget === this.target) {
      this.page = resolveOwnerPage(nextTarget);
      this.target = nextTarget;
      return true;
    }

    const previousPage = this.page;
    const previousTarget = this.target;
    await clearVisualActivity(previousPage, { target: previousTarget });
    this.page = resolveOwnerPage(nextTarget);
    this.target = nextTarget;
    return true;
  }

  async begin(label: string, tone: VisualActivityTone = "info"): Promise<boolean> {
    return await beginVisualActivity(this.page, {
      label,
      tone,
      target: this.target,
    });
  }

  async highlightSelector(
    selector: string,
    options: VisualActivityHighlightOptions = {},
  ): Promise<boolean> {
    return await highlightVisualRegionForSelector(this.page, selector, {
      ...options,
      target: this.target,
    });
  }

  async highlightLocator(
    locator: PageLocator,
    options: VisualActivityHighlightOptions = {},
  ): Promise<boolean> {
    return await highlightVisualRegionForLocator(this.page, locator, {
      ...options,
      target: this.target,
    });
  }

  async succeed(label: string, lingerMs?: number): Promise<boolean> {
    return await completeVisualActivity(this.page, {
      label,
      ...(lingerMs !== undefined ? { lingerMs } : {}),
      status: "success",
      target: this.target,
    });
  }

  async fail(label: string, lingerMs?: number): Promise<boolean> {
    return await completeVisualActivity(this.page, {
      label,
      ...(lingerMs !== undefined ? { lingerMs } : {}),
      status: "error",
      target: this.target,
    });
  }

  async clear(): Promise<boolean> {
    return await clearVisualActivity(this.page, { target: this.target });
  }
}
