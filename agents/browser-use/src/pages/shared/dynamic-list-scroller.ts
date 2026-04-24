import type { Page } from "@roll-agent/browser";

export type DynamicListTarget = Pick<Page, "evaluate" | "waitForTimeout">;

export type ScrollDirection = "up" | "down";

export type DynamicListScrollConfig = {
  readonly containerSelectors: readonly string[];
  readonly itemSelector: string;
};

export type DynamicListScrollOptions = {
  readonly direction?: ScrollDirection;
  readonly steps?: number;
  readonly distance?: number;
  readonly settleMs?: number;
  readonly stopOnBoundary?: boolean;
};

export type DynamicListSnapshot = {
  readonly containerFound: boolean;
  readonly containerLabel: string;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly itemCount: number;
  readonly atStart: boolean;
  readonly atEnd: boolean;
};

export type DynamicListScrollResult = {
  readonly success: boolean;
  readonly direction: ScrollDirection;
  readonly stepsRequested: number;
  readonly stepsCompleted: number;
  readonly reachedBoundary: boolean;
  readonly before: DynamicListSnapshot;
  readonly after: DynamicListSnapshot;
};

export type DynamicListCollectionOptions = DynamicListScrollOptions & {
  readonly targetCount?: number;
  readonly maxNoNewRounds?: number;
  readonly boundaryLoadRetries?: number;
  readonly boundarySettleMs?: number;
};

export const DYNAMIC_LIST_COLLECTION_STOP_REASONS = [
  "target-count",
  "boundary",
  "no-new-items",
  "max-steps",
] as const;

export type DynamicListCollectionStopReason =
  (typeof DYNAMIC_LIST_COLLECTION_STOP_REASONS)[number];

export type DynamicListCollectionResult<TItem> = DynamicListScrollResult & {
  readonly items: readonly TItem[];
  readonly uniqueCount: number;
  readonly duplicateCount: number;
  readonly noNewRounds: number;
  readonly stopReason: DynamicListCollectionStopReason;
};

const DEFAULT_STEPS = 4;
const DEFAULT_SETTLE_MS = 700;
const DEFAULT_MAX_NO_NEW_ROUNDS = 2;
const DEFAULT_BOUNDARY_LOAD_RETRIES = 2;

function getDirection(options: DynamicListScrollOptions): ScrollDirection {
  return options.direction ?? "down";
}

function getSteps(options: DynamicListScrollOptions): number {
  const steps = options.steps ?? DEFAULT_STEPS;
  return Math.max(0, Math.floor(steps));
}

function getSettleMs(options: DynamicListScrollOptions): number {
  return Math.max(0, Math.floor(options.settleMs ?? DEFAULT_SETTLE_MS));
}

function reachedBoundary(snapshot: DynamicListSnapshot, direction: ScrollDirection): boolean {
  return direction === "up" ? snapshot.atStart : snapshot.atEnd;
}

export async function inspectDynamicList(
  target: DynamicListTarget,
  config: DynamicListScrollConfig,
): Promise<DynamicListSnapshot> {
  return await target.evaluate((args: DynamicListScrollConfig) => {
    const isScrollable = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      if (overflowY === "hidden" || overflowY === "clip") return false;
      return element.scrollHeight > element.clientHeight + 2;
    };

    const findContainer = (): { element: Element; label: string; found: boolean } => {
      for (const selector of args.containerSelectors) {
        const candidate = document.querySelector(selector);
        if (candidate && isScrollable(candidate)) {
          return { element: candidate, label: selector, found: true };
        }
      }

      const firstItem = document.querySelector(args.itemSelector);
      let current = firstItem?.parentElement ?? null;
      while (current && current !== document.body && current !== document.documentElement) {
        if (isScrollable(current)) {
          return { element: current, label: "item-ancestor", found: true };
        }
        current = current.parentElement;
      }

      const scrollingElement = document.scrollingElement ?? document.documentElement;
      return {
        element: scrollingElement,
        label: "document",
        found: scrollingElement.scrollHeight > scrollingElement.clientHeight + 2,
      };
    };

    const { element, label, found } = findContainer();
    const scrollTop = Math.max(0, element.scrollTop);
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const atStart = scrollTop <= 2;
    const atEnd = scrollTop >= maxScrollTop - 2;

    return {
      containerFound: found,
      containerLabel: label,
      scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      itemCount: document.querySelectorAll(args.itemSelector).length,
      atStart,
      atEnd,
    };
  }, config);
}

export async function scrollDynamicList(
  target: DynamicListTarget,
  config: DynamicListScrollConfig,
  options: DynamicListScrollOptions = {},
): Promise<DynamicListScrollResult> {
  const direction = getDirection(options);
  const stepsRequested = getSteps(options);
  const settleMs = getSettleMs(options);
  const stopOnBoundary = options.stopOnBoundary ?? true;
  const before = await inspectDynamicList(target, config);
  let after = before;
  let stepsCompleted = 0;

  for (let step = 0; step < stepsRequested; step++) {
    if (stopOnBoundary && reachedBoundary(after, direction)) {
      break;
    }

    after = await target.evaluate(
      (
        args: DynamicListScrollConfig & {
          direction: ScrollDirection;
          distance: number | undefined;
        },
      ) => {
        const isScrollable = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          const overflowY = style.overflowY;
          if (overflowY === "hidden" || overflowY === "clip") return false;
          return element.scrollHeight > element.clientHeight + 2;
        };

        const findContainer = (): { element: Element; label: string; found: boolean } => {
          for (const selector of args.containerSelectors) {
            const candidate = document.querySelector(selector);
            if (candidate && isScrollable(candidate)) {
              return { element: candidate, label: selector, found: true };
            }
          }

          const firstItem = document.querySelector(args.itemSelector);
          let current = firstItem?.parentElement ?? null;
          while (current && current !== document.body && current !== document.documentElement) {
            if (isScrollable(current)) {
              return { element: current, label: "item-ancestor", found: true };
            }
            current = current.parentElement;
          }

          const scrollingElement = document.scrollingElement ?? document.documentElement;
          return {
            element: scrollingElement,
            label: "document",
            found: scrollingElement.scrollHeight > scrollingElement.clientHeight + 2,
          };
        };

        const { element, label, found } = findContainer();
        const distance = args.distance ?? Math.max(120, Math.floor(element.clientHeight * 0.85));
        const delta = args.direction === "up" ? -distance : distance;
        element.scrollBy({ top: delta, behavior: "auto" });

        const scrollTop = Math.max(0, element.scrollTop);
        const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
        return {
          containerFound: found,
          containerLabel: label,
          scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          itemCount: document.querySelectorAll(args.itemSelector).length,
          atStart: scrollTop <= 2,
          atEnd: scrollTop >= maxScrollTop - 2,
        };
      },
      {
        ...config,
        direction,
        distance: options.distance,
      },
    );
    stepsCompleted += 1;
    if (settleMs > 0) {
      await target.waitForTimeout(settleMs);
    }
    after = await inspectDynamicList(target, config);
  }

  return {
    success: before.containerFound || after.containerFound,
    direction,
    stepsRequested,
    stepsCompleted,
    reachedBoundary: reachedBoundary(after, direction),
    before,
    after,
  };
}

export async function collectDynamicListItems<TItem>(
  target: DynamicListTarget,
  config: DynamicListScrollConfig,
  readItems: () => Promise<readonly TItem[]>,
  getItemKey: (item: TItem) => string | undefined,
  options: DynamicListCollectionOptions = {},
): Promise<DynamicListCollectionResult<TItem>> {
  const direction = getDirection(options);
  const stepsRequested = getSteps(options);
  const settleMs = getSettleMs(options);
  const targetCount = options.targetCount;
  const maxNoNewRounds = options.maxNoNewRounds ?? DEFAULT_MAX_NO_NEW_ROUNDS;
  const boundaryLoadRetries = Math.max(
    0,
    Math.floor(options.boundaryLoadRetries ?? DEFAULT_BOUNDARY_LOAD_RETRIES),
  );
  const boundarySettleMs = Math.max(0, Math.floor(options.boundarySettleMs ?? settleMs));
  const before = await inspectDynamicList(target, config);
  const itemsByKey = new Map<string, TItem>();
  let duplicateCount = 0;
  let noNewRounds = 0;
  let after = before;
  let stepsCompleted = 0;
  let stopReason: DynamicListCollectionStopReason = "max-steps";

  const mergeItems = async (): Promise<number> => {
    let added = 0;
    const items = await readItems();
    for (const item of items) {
      const key = getItemKey(item);
      if (key === undefined || key.length === 0) {
        continue;
      }
      if (itemsByKey.has(key)) {
        duplicateCount += 1;
        continue;
      }
      itemsByKey.set(key, item);
      added += 1;
    }
    return added;
  };

  await mergeItems();

  for (let step = 0; step < stepsRequested; step++) {
    if (targetCount !== undefined && itemsByKey.size >= targetCount) {
      stopReason = "target-count";
      break;
    }
    if (reachedBoundary(after, direction)) {
      let changedAtBoundary = false;
      for (let attempt = 0; attempt < boundaryLoadRetries; attempt++) {
        if (boundarySettleMs > 0) {
          await target.waitForTimeout(boundarySettleMs);
        }
        const added = await mergeItems();
        const next = await inspectDynamicList(target, config);
        const changed =
          added > 0 ||
          next.scrollHeight > after.scrollHeight ||
          next.itemCount > after.itemCount ||
          !reachedBoundary(next, direction);
        after = next;
        if (changed) {
          if (added > 0) {
            noNewRounds = 0;
          }
          changedAtBoundary = true;
          break;
        }
      }
      if (!changedAtBoundary) {
        stopReason = "boundary";
        break;
      }
      if (targetCount !== undefined && itemsByKey.size >= targetCount) {
        stopReason = "target-count";
        break;
      }
    }
    if (noNewRounds >= maxNoNewRounds) {
      stopReason = "no-new-items";
      break;
    }

    const scrollResult = await scrollDynamicList(target, config, {
      direction,
      steps: 1,
      settleMs,
      ...(options.distance !== undefined ? { distance: options.distance } : {}),
      ...(options.stopOnBoundary !== undefined ? { stopOnBoundary: options.stopOnBoundary } : {}),
    });
    stepsCompleted += scrollResult.stepsCompleted;
    after = scrollResult.after;

    const added = await mergeItems();
    noNewRounds = added > 0 ? 0 : noNewRounds + 1;
  }

  if (targetCount !== undefined && itemsByKey.size >= targetCount) {
    stopReason = "target-count";
  } else if (stepsCompleted >= stepsRequested) {
    stopReason = "max-steps";
  }

  return {
    success: before.containerFound || after.containerFound,
    direction,
    stepsRequested,
    stepsCompleted,
    reachedBoundary: reachedBoundary(after, direction),
    before,
    after,
    items: [...itemsByKey.values()],
    uniqueCount: itemsByKey.size,
    duplicateCount,
    noNewRounds,
    stopReason,
  };
}
