import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
  NativeCdpController,
  NativeCdpFrameTree,
} from "@roll-agent/browser";
import { matchesPlatformHost } from "../../platforms.ts";
import { getContextManager, getRuntime } from "../../runtime-holder.ts";
import type {
  DynamicListCollectionStopReason,
  DynamicListScrollResult,
  DynamicListSnapshot,
  ScrollDirection,
} from "../shared/dynamic-list-scroller.ts";
import type { ChatListItem } from "./chat-navigation.ts";
import { getZhipinListSurfaceConfig, type ZhipinListSurface } from "./list-surfaces.ts";
import { ZHIPIN_SELECTORS } from "./selectors.ts";
import type { UsernameEvidence } from "./username.ts";
import { ZHIPIN_USERNAME_LENGTH_LIMIT } from "./username.ts";

const CHAT_ITEM_SELECTOR = '.user-list.b-scroll-stable [role="listitem"], .geek-item';
const CHAT_LIST_SELECTOR =
  '.user-list.b-scroll-stable, .user-list.b-scroll-stable [role="listitem"], .geek-item';
const RECOMMEND_CARD_SELECTOR = ".candidate-card-wrap";
const RECOMMEND_FALLBACK_CARD_SELECTOR = "[data-geek], .geek-item";
const RECOMMEND_LIST_SELECTOR = `${RECOMMEND_CARD_SELECTOR}, ${RECOMMEND_FALLBACK_CARD_SELECTOR}`;
const ZHIPIN_RECOMMEND_URL_MARKERS = ["/web/chat/recommend"] as const;
const NATIVE_SELECTOR_POLL_MS = 250;
const NATIVE_SCROLL_PAUSE_MS = 300;
const NATIVE_RECOMMEND_SCROLL_SETTLE_MS = 900;
const NATIVE_RECOMMEND_BOUNDARY_SETTLE_MS = 1_200;
const NATIVE_RECOMMEND_BOUNDARY_LOAD_RETRIES = 4;
const NATIVE_RECOMMEND_MAX_NO_NEW_ROUNDS = 4;
const NATIVE_CLICK_SETTLE_MS = 250;
const NATIVE_WHEEL_SCROLL_DISTANCE = 520;

type NativeScrollResult = {
  readonly ok: boolean;
  readonly before: number;
  readonly after: number;
  readonly max: number;
};

export type ZhipinNativePagePortOptions = {
  readonly target: BrowserInspectablePage;
  readonly controller: NativeCdpController;
};

export type ReadNativeChatCandidatesOptions = {
  readonly targetCount?: number;
  readonly autoScroll?: boolean;
  readonly maxScrolls?: number;
};

export type NativeRecommendCandidateCard = {
  readonly index: number;
  readonly candidateId: string;
  readonly name: string;
  readonly age: string;
  readonly experience: string;
  readonly education: string;
  readonly workStatus: string;
  readonly company: string;
  readonly currentPosition: string;
  readonly expectedLocation: string;
  readonly expectedPosition: string;
  readonly expectedSalary: string;
  readonly tags: string[];
  readonly buttonText: string;
};

export type ReadNativeRecommendCandidatesOptions = {
  readonly targetCount?: number;
  readonly autoScroll?: boolean;
  readonly maxScrolls?: number;
};

export type NativeDynamicListCollectionResult<TItem> = DynamicListScrollResult & {
  readonly items: readonly TItem[];
  readonly uniqueCount: number;
  readonly duplicateCount: number;
  readonly noNewRounds: number;
  readonly stopReason: DynamicListCollectionStopReason;
};

type NativeClickTarget = {
  readonly found: boolean;
  readonly x: number;
  readonly y: number;
};

type NativeClickOptions = {
  readonly onTargetResolved?: (target: NativeClickTarget) => Promise<void>;
};

type NativePageResolutionOptions = {
  readonly requireChatPage?: boolean;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatPageUrl(url: string): boolean {
  return url.includes("/web/chat/index");
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requireBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function toChatListItems(value: unknown): ChatListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item, index) => {
    const candidate = isRecord(item) ? item : {};
    return {
      conversationId: requireString(candidate["conversationId"]),
      candidateId: requireString(candidate["candidateId"]),
      name: requireString(candidate["name"]),
      index:
        typeof candidate["index"] === "number" && Number.isInteger(candidate["index"])
          ? candidate["index"]
          : index,
      position: requireString(candidate["position"]),
      hasUnread: requireBoolean(candidate["hasUnread"]),
      unreadCount:
        typeof candidate["unreadCount"] === "number" && Number.isInteger(candidate["unreadCount"])
          ? candidate["unreadCount"]
          : 0,
      lastMessageTime: requireString(candidate["lastMessageTime"]),
      messagePreview: requireString(candidate["messagePreview"]),
    };
  });
}

function toUsernameEvidence(value: unknown): UsernameEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const text = item["text"];
    const strategy = item["strategy"];
    const priority = item["priority"];
    const source = item["source"];
    const xRatio = item["xRatio"];

    if (
      typeof text !== "string" ||
      (strategy !== "role-link" &&
        strategy !== "role-button" &&
        strategy !== "leaf-text" &&
        strategy !== "css-fallback") ||
      typeof priority !== "number" ||
      typeof source !== "string"
    ) {
      return [];
    }

    return [
      {
        text,
        strategy,
        priority,
        source,
        ...(typeof xRatio === "number" ? { xRatio } : {}),
      },
    ];
  });
}

function toNativeRecommendCandidates(value: unknown): NativeRecommendCandidateCard[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item, index) => {
    const candidate = isRecord(item) ? item : {};
    const tags = candidate["tags"];

    return {
      index:
        typeof candidate["index"] === "number" && Number.isInteger(candidate["index"])
          ? candidate["index"]
          : index,
      candidateId: requireString(candidate["candidateId"]),
      name: requireString(candidate["name"]),
      age: requireString(candidate["age"]),
      experience: requireString(candidate["experience"]),
      education: requireString(candidate["education"]),
      workStatus: requireString(candidate["workStatus"]),
      company: requireString(candidate["company"]),
      currentPosition: requireString(candidate["currentPosition"]),
      expectedLocation: requireString(candidate["expectedLocation"]),
      expectedPosition: requireString(candidate["expectedPosition"]),
      expectedSalary: requireString(candidate["expectedSalary"]),
      tags: Array.isArray(tags) ? tags.map((tag) => requireString(tag)).filter(Boolean) : [],
      buttonText: requireString(candidate["buttonText"]),
    };
  });
}

function toNativeClickTarget(value: unknown): NativeClickTarget {
  if (!isRecord(value)) {
    return {
      found: false,
      x: 0,
      y: 0,
    };
  }

  return {
    found: requireBoolean(value["found"]),
    x: requireNumber(value["x"]),
    y: requireNumber(value["y"]),
  };
}

function toDynamicListSnapshot(value: unknown): DynamicListSnapshot {
  if (!isRecord(value)) {
    return {
      containerFound: false,
      containerLabel: "",
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      itemCount: 0,
      atStart: true,
      atEnd: true,
    };
  }

  return {
    containerFound: requireBoolean(value["containerFound"]),
    containerLabel: requireString(value["containerLabel"]),
    scrollTop: requireNumber(value["scrollTop"]),
    scrollHeight: requireNumber(value["scrollHeight"]),
    clientHeight: requireNumber(value["clientHeight"]),
    itemCount: requireNumber(value["itemCount"]),
    atStart: requireBoolean(value["atStart"]),
    atEnd: requireBoolean(value["atEnd"]),
  };
}

function flattenFrameTree(tree: NativeCdpFrameTree): NativeCdpFrameTree[] {
  return [tree, ...(tree.childFrames ?? []).flatMap((child) => flattenFrameTree(child))];
}

function dedupeChatItems(items: ReadonlyArray<ChatListItem>): ChatListItem[] {
  const seen = new Set<string>();
  const deduped: ChatListItem[] = [];

  for (const item of items) {
    const key =
      item.conversationId.length > 0
        ? `conversation:${item.conversationId}`
        : `fallback:${item.name}:${item.messagePreview}:${item.index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function getRecommendCandidateKey(candidate: NativeRecommendCandidateCard): string | undefined {
  if (candidate.candidateId.length > 0) return candidate.candidateId;
  if (candidate.name.length === 0) return undefined;
  return [
    candidate.name,
    candidate.age,
    candidate.experience,
    candidate.expectedLocation,
    candidate.expectedPosition,
    candidate.expectedSalary,
  ].join("|");
}

function resolveSelectedNativePage(
  ctxManager: BrowserContextManager,
  pages: ReadonlyArray<BrowserInspectablePage>,
  options: NativePageResolutionOptions,
): BrowserInspectablePage {
  const zhipinPages = pages.filter((page) => matchesPlatformHost(page.url, "zhipin"));
  const selected = zhipinPages.find((page) => ctxManager.isNativePageSelected(page.targetId));

  if (options.requireChatPage) {
    if (selected && isChatPageUrl(selected.url)) {
      return selected;
    }

    const chatPages = zhipinPages.filter((page) => isChatPageUrl(page.url));
    if (chatPages.length === 1) {
      const chatPage = chatPages[0];
      if (chatPage) {
        return chatPage;
      }
    }

    if (selected) {
      throw new Error("Selected BOSS page is not a chat page; switch to chat page first.");
    }
    if (chatPages.length > 1) {
      throw new Error("Multiple BOSS chat pages found; select the target tab first.");
    }
    throw new Error("No BOSS chat page found; switch to chat page first.");
  }

  if (selected) {
    return selected;
  }
  if (zhipinPages.length === 1) {
    const page = zhipinPages[0];
    if (page) {
      return page;
    }
  }
  if (zhipinPages.length > 1) {
    throw new Error("Multiple BOSS pages found; select the target tab first.");
  }
  throw new Error("No BOSS page found.");
}

export async function openZhipinNativePagePort(
  options: NativePageResolutionOptions = {},
  deps: {
    readonly ctxManager?: BrowserContextManager;
    readonly runtime?: BrowserRuntime;
  } = {},
): Promise<ZhipinNativePagePort> {
  const ctxManager = deps.ctxManager ?? getContextManager();
  const runtime = deps.runtime ?? getRuntime();
  const target = resolveSelectedNativePage(ctxManager, await ctxManager.listNativePages(), options);
  const controller = await runtime.connectNativePage(target);
  return new ZhipinNativePagePort({ target, controller });
}

export class ZhipinNativePagePort {
  private readonly target: BrowserInspectablePage;
  private readonly controller: NativeCdpController;
  private recommendFrameContextId: number | undefined;
  private recommendFrameContextFrameId: string | undefined;

  constructor(options: ZhipinNativePagePortOptions) {
    this.target = options.target;
    this.controller = options.controller;
  }

  get targetId(): string {
    return this.target.targetId;
  }

  async inspectPage(): Promise<BrowserInspectablePage> {
    return {
      ...this.target,
      url: await this.url().catch(() => this.target.url),
      title: await this.title().catch(() => this.target.title),
    };
  }

  async url(): Promise<string> {
    return await this.evaluateJson<string>("location.href");
  }

  async title(): Promise<string> {
    return await this.evaluateJson<string>("document.title");
  }

  async waitForSelector(selector: string, timeoutMs = 5_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (
        await this.evaluateJson<boolean>(
          `document.querySelector(${JSON.stringify(selector)}) !== null`,
        ).catch(() => false)
      ) {
        return true;
      }
      await delay(NATIVE_SELECTOR_POLL_MS);
    }

    return false;
  }

  async evaluateJson<T = unknown>(expression: string): Promise<T> {
    return await this.controller.evaluateJson<T>(expression);
  }

  async bringToFront(): Promise<void> {
    await this.controller.bringToFront();
  }

  async isChatSurfaceOpen(): Promise<boolean> {
    return await this.evaluateJson<boolean>(
      `location.href.includes("/web/chat/index") ||
        document.querySelector("#container.chat-container-private") !== null ||
        document.querySelector(${JSON.stringify(CHAT_LIST_SELECTOR)}) !== null`,
    );
  }

  async waitForChatSurface(timeoutMs = 8_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isChatSurfaceOpen().catch(() => false)) {
        return true;
      }
      await delay(NATIVE_SELECTOR_POLL_MS);
    }
    return false;
  }

  async isRecommendSurfaceOpen(): Promise<boolean> {
    const recommendFrameSelector = [
      ZHIPIN_SELECTORS.recommend.iframe,
      'iframe[name="recommendFrame"]',
      'iframe[src*="recommend"]',
    ].join(", ");

    return await this.evaluateJson<boolean>(
      `(() => {
        const href = location.href;
        const recommendUrlMarkers = ${JSON.stringify(ZHIPIN_RECOMMEND_URL_MARKERS)};
        const hasRecommendUrl = recommendUrlMarkers.some((marker) => href.includes(marker));
        if (hasRecommendUrl) {
          return true;
        }

        if (href.includes("/web/chat/index")) {
          return false;
        }

        const recommendFrame = document.querySelector(${JSON.stringify(recommendFrameSelector)});
        return recommendFrame !== null;
      })()`,
    );
  }

  async waitForRecommendSurface(timeoutMs = 8_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isRecommendSurfaceOpen().catch(() => false)) {
        return true;
      }
      await delay(NATIVE_SELECTOR_POLL_MS);
    }
    return false;
  }

  private async resolveRecommendFrameContextId(): Promise<number | undefined> {
    const frameTree = await this.controller.getFrameTree().catch(() => undefined);
    if (frameTree === undefined) {
      return undefined;
    }

    const frames = flattenFrameTree(frameTree).map((entry) => entry.frame);
    const namedFrame = frames.find((candidate) => candidate.name === "recommendFrame");
    const urlMatchedChildFrame = frames.find(
      (candidate) => candidate.id !== frameTree.frame.id && candidate.url.includes("recommend"),
    );
    const frame = namedFrame ?? urlMatchedChildFrame;
    if (frame === undefined) {
      return undefined;
    }

    if (
      this.recommendFrameContextId !== undefined &&
      this.recommendFrameContextFrameId === frame.id
    ) {
      return this.recommendFrameContextId;
    }

    const contextId = await this.controller.createIsolatedWorld(frame.id).catch(() => undefined);
    if (contextId === undefined) {
      return undefined;
    }

    this.recommendFrameContextId = contextId;
    this.recommendFrameContextFrameId = frame.id;
    return contextId;
  }

  private async evaluateRecommendFrameJson<T = unknown>(
    expression: string,
  ): Promise<T | undefined> {
    const contextId = await this.resolveRecommendFrameContextId();
    if (contextId === undefined) {
      return undefined;
    }

    return await this.controller.evaluateJson<T>(expression, { contextId }).catch(() => undefined);
  }

  async hasRecommendList(): Promise<boolean> {
    if (!(await this.isRecommendSurfaceOpen().catch(() => false))) {
      return false;
    }

    const expression = `document.querySelector(${JSON.stringify(RECOMMEND_LIST_SELECTOR)}) !== null`;
    if (await this.evaluateJson<boolean>(expression).catch(() => false)) {
      return true;
    }

    return (await this.evaluateRecommendFrameJson<boolean>(expression)) ?? false;
  }

  async waitForRecommendList(timeoutMs = 10_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!(await this.isRecommendSurfaceOpen().catch(() => false))) {
        await delay(NATIVE_SELECTOR_POLL_MS);
        continue;
      }
      if (await this.hasRecommendList().catch(() => false)) {
        return true;
      }
      await delay(NATIVE_SELECTOR_POLL_MS);
    }
    return await this.hasRecommendList().catch(() => false);
  }

  async clickSidebarSection(
    section: "chat" | "recommend",
    options: NativeClickOptions = {},
  ): Promise<boolean> {
    const selector =
      section === "chat" ? ZHIPIN_SELECTORS.nav.chatLink : ZHIPIN_SELECTORS.nav.recommendLink;
    const directClick = await this.controller.locator(selector).click({
      settleMs: NATIVE_CLICK_SETTLE_MS,
      ...(options.onTargetResolved !== undefined
        ? { onTargetResolved: options.onTargetResolved }
        : {}),
    });
    if (directClick.success) {
      return true;
    }

    const target = toNativeClickTarget(
      await this.evaluateJson(
        `(() => {
          const labels = ${JSON.stringify(section === "chat" ? ["沟通", "消息"] : ["推荐牛人"])};
          const normalizedLabels = labels.map((label) => label.replace(/\\s+/g, ""));
          const interactiveSelector = 'a, button, [role="link"], [role="button"]';
          const textSelector = 'span, div, li, a, button, [role="link"], [role="button"]';
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const normalizeText = (element) =>
            (element.textContent ?? "").replace(/\\s+/g, "").trim();
          const matchesExactLabel = (element) => {
            const text = normalizeText(element);
            return normalizedLabels.some((label) => text === label);
          };
          const matchesInteractiveLabel = (element) => {
            const text = normalizeText(element);
            return normalizedLabels.some(
              (label) =>
                text === label ||
                text.startsWith(label) ||
                (text.includes(label) && text.length <= label.length + 8),
            );
          };
          const area = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width * rect.height;
          };
          const readCenter = (element) => {
            element.scrollIntoView({ block: "center", inline: "center" });
            const rect = element.getBoundingClientRect();
            return {
              found: true,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2)
            };
          };

          const sidebar = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.nav.sidebar)}) ?? document;
          const interactiveTargets = Array.from(sidebar.querySelectorAll(interactiveSelector))
            .filter((element) => visible(element) && matchesInteractiveLabel(element))
            .sort((left, right) => area(left) - area(right));
          if (interactiveTargets[0]) {
            return readCenter(interactiveTargets[0]);
          }

          const exactTextTargets = Array.from(sidebar.querySelectorAll(textSelector))
            .filter((element) => visible(element) && matchesExactLabel(element))
            .sort((left, right) => area(left) - area(right));
          if (exactTextTargets[0]) {
            return readCenter(exactTextTargets[0]);
          }

          return { found: false, x: 0, y: 0 };
        })()`,
      ),
    );

    if (!target.found) {
      return false;
    }

    await options.onTargetResolved?.(target);
    await this.controller.dispatchMouseEvent({
      type: "mouseMoved",
      x: target.x,
      y: target.y,
      buttons: 0,
    });
    await this.controller.dispatchMouseEvent({
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.controller.dispatchMouseEvent({
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await delay(NATIVE_CLICK_SETTLE_MS);
    return true;
  }

  async scrollSurface(
    surface: ZhipinListSurface,
    options: {
      readonly direction?: ScrollDirection;
      readonly steps?: number;
      readonly distance?: number;
      readonly settleMs?: number;
    } = {},
  ): Promise<DynamicListScrollResult> {
    const config = getZhipinListSurfaceConfig(surface);
    const direction = options.direction ?? config.defaultDirection;
    const stepsRequested = Math.max(0, Math.floor(options.steps ?? 1));
    const settleMs = Math.max(0, Math.floor(options.settleMs ?? 700));
    const before = await this.inspectSurface(surface);
    let after = before;
    let stepsCompleted = 0;

    for (let step = 0; step < stepsRequested; step += 1) {
      if (surface === "chat-list" && after.itemCount > 0) {
        const wheelSnapshot = await this.scrollSurfaceWithWheel(
          surface,
          direction,
          options.distance,
        );
        if (wheelSnapshot === undefined) {
          break;
        }
        after = wheelSnapshot;
        stepsCompleted += 1;
        if (settleMs > 0) {
          await delay(settleMs);
          const settled = await this.inspectSurface(surface);
          after = settled.containerFound || !after.containerFound ? settled : after;
        }
        continue;
      }

      if ((direction === "up" && after.atStart) || (direction === "down" && after.atEnd)) {
        if (after.itemCount <= 0) {
          break;
        }
        const wheelSnapshot = await this.scrollSurfaceWithWheel(
          surface,
          direction,
          options.distance,
        );
        if (wheelSnapshot === undefined) {
          break;
        }
        after = wheelSnapshot;
        stepsCompleted += 1;
        if (settleMs > 0) {
          await delay(settleMs);
          const settled = await this.inspectSurface(surface);
          after = settled.containerFound || !after.containerFound ? settled : after;
        }
        continue;
      }

      after = await this.scrollSurfaceOnce(surface, direction, options.distance);
      stepsCompleted += 1;
      if (settleMs > 0) {
        await delay(settleMs);
        const settled = await this.inspectSurface(surface);
        after = settled.containerFound || !after.containerFound ? settled : after;
      }
    }

    return {
      success: before.containerFound || after.containerFound || stepsCompleted > 0,
      direction,
      stepsRequested,
      stepsCompleted,
      reachedBoundary: direction === "up" ? after.atStart : after.atEnd,
      before,
      after,
    };
  }

  async readChatCandidates(options: ReadNativeChatCandidatesOptions = {}): Promise<ChatListItem[]> {
    const targetCount = options.targetCount ?? 20;
    const maxScrolls = options.autoScroll ? (options.maxScrolls ?? 3) : 0;
    const snapshots: ChatListItem[] = [];

    for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
      snapshots.push(...(await this.readVisibleChatCandidates()));
      const deduped = dedupeChatItems(snapshots);
      if (deduped.length >= targetCount || attempt === maxScrolls) {
        return deduped;
      }

      const scrollResult = await this.scrollChatList();
      if (!scrollResult.ok) {
        return deduped;
      }
      await delay(NATIVE_SCROLL_PAUSE_MS);
    }

    return dedupeChatItems(snapshots);
  }

  async readRecommendCandidates(
    options: ReadNativeRecommendCandidatesOptions = {},
  ): Promise<NativeDynamicListCollectionResult<NativeRecommendCandidateCard>> {
    const targetCount = options.targetCount;
    const maxScrolls = options.autoScroll ? (options.maxScrolls ?? 4) : 0;
    const before = await this.inspectSurface("recommend-list");
    let after = before;
    const itemsByKey = new Map<string, NativeRecommendCandidateCard>();
    let stepsCompleted = 0;
    let duplicateCount = 0;
    let noNewRounds = 0;
    let stopReason: DynamicListCollectionStopReason = "max-steps";

    const mergeItems = async (): Promise<number> => {
      let added = 0;
      const items = await this.readVisibleRecommendCandidates();
      for (const item of items) {
        const key = getRecommendCandidateKey(item);
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

    for (let step = 0; step < maxScrolls; step += 1) {
      if (targetCount !== undefined && itemsByKey.size >= targetCount) {
        stopReason = "target-count";
        break;
      }

      if (after.atEnd) {
        let changedAtBoundary = false;
        for (let attempt = 0; attempt < NATIVE_RECOMMEND_BOUNDARY_LOAD_RETRIES; attempt += 1) {
          await delay(NATIVE_RECOMMEND_BOUNDARY_SETTLE_MS);
          const added = await mergeItems();
          const next = await this.inspectSurface("recommend-list");
          const changed =
            added > 0 ||
            next.scrollHeight > after.scrollHeight ||
            next.itemCount > after.itemCount ||
            !next.atEnd;
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

      if (noNewRounds >= NATIVE_RECOMMEND_MAX_NO_NEW_ROUNDS) {
        stopReason = "no-new-items";
        break;
      }

      const scrollResult = await this.scrollSurface("recommend-list", {
        direction: "down",
        steps: 1,
        settleMs: NATIVE_RECOMMEND_SCROLL_SETTLE_MS,
      });
      after = scrollResult.after;
      stepsCompleted += scrollResult.stepsCompleted;

      const added = await mergeItems();
      noNewRounds = added > 0 ? 0 : noNewRounds + 1;
    }

    if (targetCount !== undefined && itemsByKey.size >= targetCount) {
      stopReason = "target-count";
    } else if (stepsCompleted >= maxScrolls) {
      stopReason = "max-steps";
    }

    const items = [...itemsByKey.values()];
    return {
      success: before.containerFound,
      direction: "down",
      stepsRequested: maxScrolls,
      stepsCompleted,
      reachedBoundary: after.atEnd,
      before,
      after,
      items,
      uniqueCount: items.length,
      duplicateCount,
      noNewRounds,
      stopReason,
    };
  }

  async readUsernameEvidence(): Promise<UsernameEvidence[]> {
    return toUsernameEvidence(
      await this.evaluateJson(
        `(() => {
          const limit = ${ZHIPIN_USERNAME_LENGTH_LIMIT};
          const evidence = [];
          const viewportWidth = window.innerWidth || 1280;
          const push = (entry) => {
            const text = String(entry.text ?? "").trim();
            if (text.length > 0 && text.length <= limit) {
              evidence.push({ ...entry, text });
            }
          };
          const scope =
            document.querySelector("header") ??
            document.querySelector("#header") ??
            document.querySelector('[role="banner"]') ??
            document.querySelector('[role="navigation"]') ??
            document.body;

          if (scope) {
            for (const element of Array.from(scope.querySelectorAll('a, [role="link"]'))) {
              const text = element.textContent?.trim() ?? "";
              const rect = element.getBoundingClientRect();
              push({
                text,
                strategy: "role-link",
                priority: 1,
                source: "role:link",
                xRatio: (rect.x + rect.width / 2) / viewportWidth
              });
            }
            for (const element of Array.from(scope.querySelectorAll('button, [role="button"]'))) {
              const text = element.textContent?.trim() ?? "";
              const rect = element.getBoundingClientRect();
              push({
                text,
                strategy: "role-button",
                priority: 1,
                source: "role:button",
                xRatio: (rect.x + rect.width / 2) / viewportWidth
              });
            }

            const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const text = walker.currentNode.textContent?.trim() ?? "";
              push({
                text,
                strategy: "leaf-text",
                priority: 3,
                source: "leaf-text"
              });
            }
          }

          for (const selector of ${JSON.stringify([
            ZHIPIN_SELECTORS.username.primary,
            ...ZHIPIN_SELECTORS.username.fallbacks,
          ])}) {
            try {
              push({
                text: document.querySelector(selector)?.textContent?.trim() ?? "",
                strategy: "css-fallback",
                priority: 4,
                source: selector
              });
            } catch {
              // Ignore invalid selectors from site-specific fallback list.
            }
          }

          return evidence;
        })()`,
      ),
    );
  }

  close(): void {
    this.controller.close();
  }

  private async readVisibleChatCandidates(): Promise<ChatListItem[]> {
    return toChatListItems(
      await this.evaluateJson(
        `(() => {
          const items = Array.from(document.querySelectorAll(${JSON.stringify(CHAT_ITEM_SELECTOR)}));
          return items.map((item, idx) => {
            const conversationId =
              item.getAttribute("data-id") ??
              item.closest('[role="listitem"]')?.getAttribute("key") ??
              "";
            const candidateId =
              item.getAttribute("data-geek") ??
              item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
              conversationId;
            const nameEl = item.querySelector(
              '[class*="name"], .nickname, .geek-name, .candidate-name'
            );
            const name = nameEl?.textContent?.trim() ?? "";
            const position = item.querySelector(".source-job")?.textContent?.trim() ?? "";
            const badgeEl = item.querySelector(".badge-count");
            const unreadCount = parseInt(badgeEl?.textContent?.trim() ?? "0", 10) || 0;
            const hasUnread = unreadCount > 0 || item.querySelector(".red-dot") !== null;
            const lastMessageTime =
              item.querySelector(".time, .time-shadow")?.textContent?.trim() ?? "";
            const messagePreview = (
              item.querySelector(".push-text, .chat-last-msg")?.textContent?.trim() ?? ""
            ).slice(0, 100);

            return {
              conversationId,
              candidateId,
              name,
              index: idx,
              position,
              hasUnread,
              unreadCount,
              lastMessageTime,
              messagePreview,
            };
          });
        })()`,
      ),
    );
  }

  private async readVisibleRecommendCandidates(): Promise<NativeRecommendCandidateCard[]> {
    if (!(await this.isRecommendSurfaceOpen().catch(() => false))) {
      return [];
    }

    const expression = `(() => {
          const iframe = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.iframe)});
          const href = location.href;
          const recommendUrlMarkers = ${JSON.stringify(ZHIPIN_RECOMMEND_URL_MARKERS)};
          const hasRecommendUrl = recommendUrlMarkers.some((marker) => href.includes(marker));
          if (!hasRecommendUrl && href.includes("/web/chat/index")) {
            return [];
          }

          const hasRecommendShell =
            document.querySelector(".recommendV2, .recommend-list-wrap, .recommend-list, .candidate-list, .recommend-filter, .candidate-card-wrap") !== null;
          if (!hasRecommendUrl && !iframe && !hasRecommendShell) {
            return [];
          }

          const root = iframe?.contentDocument ?? document;
          let items = Array.from(root.querySelectorAll(${JSON.stringify(RECOMMEND_CARD_SELECTOR)}));
          if (items.length === 0 && (hasRecommendUrl || iframe || hasRecommendShell)) {
            items = Array.from(root.querySelectorAll(${JSON.stringify(RECOMMEND_FALLBACK_CARD_SELECTOR)}));
          }

          return items.map((item, idx) => {
            const candidateId =
              item.getAttribute("data-geek") ??
              item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
              "";
            const name = item.querySelector(".name")?.textContent?.trim() ?? "";

            let age = "";
            let experience = "";
            let education = "";
            let workStatus = "";
            const baseInfoEl = item.querySelector(".base-info.join-text-wrap, .base-info");
            if (baseInfoEl) {
              let textParts = Array.from(baseInfoEl.querySelectorAll(":scope > *"))
                .map((child) => child.textContent?.trim() ?? "")
                .filter(Boolean);

              if (textParts.length <= 1) {
                textParts = [];
                baseInfoEl.childNodes.forEach((node) => {
                  if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent?.trim() ?? "";
                    if (text) textParts.push(text);
                  }
                });
              }

              if (textParts.length <= 1) {
                textParts = (baseInfoEl.textContent?.trim() ?? "")
                  .split(/[丨·|]/)
                  .map((text) => text.trim())
                  .filter(Boolean);
              }

              for (const part of textParts) {
                if (!age && part.includes("岁")) {
                  age = part;
                } else if (!experience && (part.includes("年") || part.includes("应届") || part.includes("在校"))) {
                  experience = part;
                } else if (!education && /(初中|高中|中专|中技|大专|本科|硕士|博士)/.test(part)) {
                  education = part;
                } else if (!workStatus && /(在职|离职|在校)/.test(part)) {
                  workStatus = part;
                }
              }
            }

            const workExpEl =
              item.querySelector(".timeline-wrap.work-exps .content.join-text-wrap") ??
              item.querySelector(".timeline-wrap.work-exps .content");
            const workParts = (workExpEl?.textContent?.trim() ?? "")
              .split("·")
              .map((text) => text.trim());
            const company = workParts[0] ?? "";
            const currentPosition = workParts[1] ?? "";

            let expectedLocation = "";
            let expectedPosition = "";
            const expectRow = item.querySelector(".row-flex:not(.geek-desc)");
            if (expectRow) {
              const labelText = expectRow.querySelector(".label")?.textContent ?? "";
              const contentEl = expectRow.querySelector(".content");
              if ((labelText.includes("期望") || labelText.includes("最近关注")) && contentEl) {
                const parts = (contentEl.textContent?.trim() ?? "")
                  .split("·")
                  .map((text) => text.trim());
                expectedLocation = parts[0] ?? "";
                expectedPosition = parts[1] ?? "";
              }
            }
            if (!expectedLocation) {
              const expectEl =
                item.querySelector(".timeline-wrap.expect .content.join-text-wrap") ??
                item.querySelector(".timeline-wrap.expect .content");
              if (expectEl) {
                const parts = (expectEl.textContent?.trim() ?? "")
                  .split("·")
                  .map((text) => text.trim());
                expectedLocation = parts[0] ?? "";
                expectedPosition = parts[1] ?? "";
              }
            }

            const tags = Array.from(
              item.querySelectorAll(".tags-wrap .tag-item, .tags-wrap .tag, .tags-wrap span")
            )
              .map((tag) => tag.textContent?.trim() ?? "")
              .filter(Boolean);

            return {
              index: idx,
              candidateId,
              name,
              age,
              experience,
              education,
              workStatus,
              company,
              currentPosition,
              expectedLocation,
              expectedPosition,
              expectedSalary: item.querySelector(".salary-wrap")?.textContent?.trim() ?? "",
              tags,
              buttonText: item.querySelector("button.btn.btn-greet")?.textContent?.trim() ?? "",
            };
          });
        })()`;
    const mainItems = toNativeRecommendCandidates(await this.evaluateJson(expression));
    if (mainItems.length > 0) {
      return mainItems;
    }

    const frameValue = await this.evaluateRecommendFrameJson(expression);
    return toNativeRecommendCandidates(frameValue);
  }

  private async inspectSurface(surface: ZhipinListSurface): Promise<DynamicListSnapshot> {
    const config = getZhipinListSurfaceConfig(surface);
    const expression = `(() => {
          const surface = ${JSON.stringify(surface)};
          const containerSelectors = ${JSON.stringify(config.containerSelectors)};
          const itemSelector = ${JSON.stringify(config.itemSelector)};
          const iframe = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.iframe)});
          const href = location.href;
          const recommendUrlMarkers = ${JSON.stringify(ZHIPIN_RECOMMEND_URL_MARKERS)};
          const hasRecommendUrl = recommendUrlMarkers.some((marker) => href.includes(marker));
          if (surface === "recommend-list" && !hasRecommendUrl && href.includes("/web/chat/index")) {
            return {
              containerFound: false,
              containerLabel: "",
              scrollTop: 0,
              scrollHeight: 0,
              clientHeight: 0,
              itemCount: 0,
              atStart: true,
              atEnd: true
            };
          }

          const hasRecommendShell =
            document.querySelector(".recommendV2, .recommend-list-wrap, .recommend-list, .candidate-list, .recommend-filter, .candidate-card-wrap") !== null;
          if (surface === "recommend-list" && !hasRecommendUrl && !iframe && !hasRecommendShell) {
            return {
              containerFound: false,
              containerLabel: "",
              scrollTop: 0,
              scrollHeight: 0,
              clientHeight: 0,
              itemCount: 0,
              atStart: true,
              atEnd: true
            };
          }

          const root = surface === "recommend-list" ? (iframe?.contentDocument ?? document) : document;
          const readItemCount = () => {
            if (surface === "chat-list") {
              const chatList = root.querySelector(".user-list.b-scroll-stable");
              const roleItems = chatList?.querySelectorAll('[role="listitem"]');
              if (roleItems && roleItems.length > 0) return roleItems.length;
            }
            return root.querySelectorAll(itemSelector).length;
          };
          const itemCount = readItemCount();
          const isVisible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          const isScrollable = (element) => {
            if (!isVisible(element)) return false;
            const view = element.ownerDocument?.defaultView ?? window;
            const style = view.getComputedStyle(element);
            if (style.overflowY === "hidden" || style.overflowY === "clip") return false;
            return element.scrollHeight > element.clientHeight + 2;
          };
          const labelFor = (element, fallback) => {
            if (element === document.scrollingElement) return "document";
            if (element === root.scrollingElement) return root === document ? "document" : "frame-document";
            return (
              element.id ||
              Array.from(element.classList ?? []).join(".") ||
              fallback ||
              element.tagName.toLowerCase()
            );
          };
          const targets = [];
          const pushTarget = (element, fallback) => {
            if (element && !isVisible(element)) return;
            if (!element || targets.some((target) => target.element === element)) return;
            targets.push({ element, label: labelFor(element, fallback) });
          };
          const readCssPixel = (value) => {
            const parsed = Number.parseFloat(value);
            return Number.isFinite(parsed) ? parsed : 0;
          };
          const findChatListElement = (element) => {
            if (surface !== "chat-list") return null;
            if (element.matches?.(".user-list.b-scroll-stable")) return element;
            return (
              element.querySelector?.(".user-list.b-scroll-stable") ??
              element.closest?.(".user-list.b-scroll-stable") ??
              null
            );
          };
          const readChatListSnapshot = (target) => {
            const list = findChatListElement(target.element);
            if (!list || itemCount <= 0 || !isVisible(list)) return null;

            const nativeScrollTop = Math.max(0, list.scrollTop);
            const nativeScrollHeight = Math.max(0, list.scrollHeight);
            const nativeClientHeight = Math.max(0, list.clientHeight);
            const nativeMaxScrollTop = Math.max(0, nativeScrollHeight - nativeClientHeight);
            if (nativeScrollHeight > nativeClientHeight + 2) {
              return {
                containerFound: true,
                containerLabel: labelFor(list, ".user-list.b-scroll-stable"),
                scrollTop: Math.round(nativeScrollTop),
                scrollHeight: Math.round(nativeScrollHeight),
                clientHeight: Math.round(nativeClientHeight),
                itemCount,
                atStart: nativeScrollTop <= 1,
                atEnd: nativeScrollTop >= nativeMaxScrollTop - 1
              };
            }

            const listRect = list.getBoundingClientRect();
            if (listRect.width <= 0 || listRect.height <= 0) return null;
            const group = list.querySelector('[role="group"]');
            if (!group) return null;

            const view = list.ownerDocument?.defaultView ?? window;
            const groupStyle = view.getComputedStyle(group);
            const paddingTop = Math.max(0, readCssPixel(groupStyle.paddingTop));
            const paddingBottom = Math.max(0, readCssPixel(groupStyle.paddingBottom));
            const roleItems = Array.from(list.querySelectorAll('[role="listitem"]'));
            const renderedItems =
              roleItems.length > 0 ? roleItems : Array.from(list.querySelectorAll(".geek-item"));
            const renderedHeight = renderedItems.reduce((sum, item) => {
              const rect = item.getBoundingClientRect();
              return sum + Math.max(0, rect.height);
            }, 0);
            const virtualHeight = Math.max(
              Math.round(paddingTop + renderedHeight + paddingBottom),
              Math.round(listRect.height)
            );
            return {
              containerFound: true,
              containerLabel: labelFor(list, ".user-list.b-scroll-stable") + ":virtual",
              scrollTop: Math.round(paddingTop),
              scrollHeight: virtualHeight,
              clientHeight: Math.round(listRect.height),
              itemCount,
              atStart: paddingTop <= 1,
              atEnd: paddingBottom <= 1
            };
          };

          for (const selector of containerSelectors) {
            try {
              for (const element of Array.from(root.querySelectorAll(selector))) {
                pushTarget(element, selector);
              }
            } catch {}
          }

          const firstVisibleItem = Array.from(root.querySelectorAll(itemSelector)).find(isVisible);
          let current = firstVisibleItem?.parentElement ?? null;
          while (current && current !== root.body && current !== root.documentElement) {
            pushTarget(current, "item-ancestor");
            current = current.parentElement;
          }

          if (surface === "recommend-list" && root !== document) {
            const outerFrame = iframe ?? window.frameElement;
            let outer = outerFrame?.parentElement ?? null;
            while (outer && outer !== document.body && outer !== document.documentElement) {
              pushTarget(outer, "iframe-ancestor");
              outer = outer.parentElement;
            }
            pushTarget(document.scrollingElement, "document");
            pushTarget(document.documentElement, "documentElement");
            pushTarget(document.body, "body");
          }
          pushTarget(root.scrollingElement, root === document ? "document" : "frame-document");

          for (const target of targets) {
            const chatListSnapshot = readChatListSnapshot(target);
            if (chatListSnapshot) return chatListSnapshot;
          }

          const scrollTarget = targets.find((target) => isScrollable(target.element));
          if (!scrollTarget) {
            return {
              containerFound: false,
              containerLabel: targets[0]?.label ?? "",
              scrollTop: 0,
              scrollHeight: 0,
              clientHeight: 0,
              itemCount,
              atStart: true,
              atEnd: true
            };
          }

          const scrollable = scrollTarget.element;
          const max = Math.max(0, scrollable.scrollHeight - scrollable.clientHeight);
          return {
            containerFound: true,
            containerLabel: scrollTarget.label,
            scrollTop: scrollable.scrollTop,
            scrollHeight: scrollable.scrollHeight,
            clientHeight: scrollable.clientHeight,
            itemCount,
            atStart: scrollable.scrollTop <= 1,
              atEnd: scrollable.scrollTop >= max - 1
          };
        })()`;
    const mainSnapshot = toDynamicListSnapshot(await this.evaluateJson(expression));
    if (surface !== "recommend-list" || mainSnapshot.itemCount > 0) {
      return mainSnapshot;
    }

    const frameValue = await this.evaluateRecommendFrameJson(expression);
    const frameSnapshot = toDynamicListSnapshot(frameValue);
    return frameSnapshot.itemCount > 0 ? frameSnapshot : mainSnapshot;
  }

  private async scrollSurfaceWithWheel(
    surface: ZhipinListSurface,
    direction: ScrollDirection,
    distance: number | undefined,
  ): Promise<DynamicListSnapshot | undefined> {
    const config = getZhipinListSurfaceConfig(surface);
    await this.bringToFront();

    const target = toNativeClickTarget(
      await this.evaluateJson(
        `(() => {
          const nativeWheelTarget = true;
          const surface = ${JSON.stringify(surface)};
          const containerSelectors = ${JSON.stringify(config.containerSelectors)};
          const itemSelector = ${JSON.stringify(config.itemSelector)};
          const iframe = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.iframe)});
          const root = surface === "recommend-list" ? (iframe?.contentDocument ?? document) : document;
          const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
          const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
          const targets = [];
          const pushTarget = (element) => {
            if (!element || targets.includes(element)) return;
            targets.push(element);
          };

          for (const selector of containerSelectors) {
            try {
              for (const element of Array.from(root.querySelectorAll(selector))) {
                pushTarget(element);
              }
            } catch {}
          }

          const firstItem = Array.from(root.querySelectorAll(itemSelector)).find((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          pushTarget(firstItem);
          let current = firstItem?.parentElement ?? null;
          while (current && current !== root.body && current !== root.documentElement) {
            pushTarget(current);
            current = current.parentElement;
          }

          const readPoint = (element) => {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            let left = rect.left;
            let top = rect.top;
            if (root !== document && iframe) {
              const frameRect = iframe.getBoundingClientRect();
              left += frameRect.left;
              top += frameRect.top;
            }
            const x = Math.round(Math.min(Math.max(left + rect.width / 2, 4), Math.max(4, viewportWidth - 4)));
            const y = Math.round(Math.min(Math.max(top + rect.height / 2, 4), Math.max(4, viewportHeight - 4)));
            return { found: true, x, y };
          };

          for (const element of targets) {
            const point = readPoint(element);
            if (point) return point;
          }

          return { found: false, x: 0, y: 0 };
        })()`,
      ),
    );

    if (!target.found) {
      return undefined;
    }

    await this.controller.dispatchMouseEvent({
      type: "mouseMoved",
      x: target.x,
      y: target.y,
      buttons: 0,
    });
    await this.controller.dispatchMouseEvent({
      type: "mouseWheel",
      x: target.x,
      y: target.y,
      buttons: 0,
      deltaX: 0,
      deltaY:
        direction === "up"
          ? -(distance ?? NATIVE_WHEEL_SCROLL_DISTANCE)
          : (distance ?? NATIVE_WHEEL_SCROLL_DISTANCE),
    });
    await delay(120);

    const snapshot = await this.inspectSurface(surface);
    if (snapshot.containerFound) {
      return snapshot;
    }

    return {
      ...snapshot,
      containerFound: true,
      containerLabel: snapshot.containerLabel.length > 0 ? snapshot.containerLabel : "native-wheel",
      atStart: direction === "up" ? false : snapshot.atStart,
      atEnd: direction === "down" ? false : snapshot.atEnd,
    };
  }

  private async scrollSurfaceOnce(
    surface: ZhipinListSurface,
    direction: ScrollDirection,
    distance: number | undefined,
  ): Promise<DynamicListSnapshot> {
    const config = getZhipinListSurfaceConfig(surface);
    const expression = `(() => {
          const surface = ${JSON.stringify(surface)};
          const direction = ${JSON.stringify(direction)};
          const explicitDistance = ${distance !== undefined ? JSON.stringify(distance) : "undefined"};
          const containerSelectors = ${JSON.stringify(config.containerSelectors)};
          const itemSelector = ${JSON.stringify(config.itemSelector)};
          const iframe = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.iframe)});
          const href = location.href;
          const recommendUrlMarkers = ${JSON.stringify(ZHIPIN_RECOMMEND_URL_MARKERS)};
          const hasRecommendUrl = recommendUrlMarkers.some((marker) => href.includes(marker));
          if (surface === "recommend-list" && !hasRecommendUrl && href.includes("/web/chat/index")) {
            return {
              containerFound: false,
              containerLabel: "",
              scrollTop: 0,
              scrollHeight: 0,
              clientHeight: 0,
              itemCount: 0,
              atStart: true,
              atEnd: true
            };
          }

          const hasRecommendShell =
            document.querySelector(".recommendV2, .recommend-list-wrap, .recommend-list, .candidate-list, .recommend-filter, .candidate-card-wrap") !== null;
          if (surface === "recommend-list" && !hasRecommendUrl && !iframe && !hasRecommendShell) {
            return {
              containerFound: false,
              containerLabel: "",
              scrollTop: 0,
              scrollHeight: 0,
              clientHeight: 0,
              itemCount: 0,
              atStart: true,
              atEnd: true
            };
          }

          const root = surface === "recommend-list" ? (iframe?.contentDocument ?? document) : document;
          const itemCount = root.querySelectorAll(itemSelector).length;
          const isVisible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const isScrollable = (element) => {
            if (!isVisible(element)) return false;
            const view = element.ownerDocument?.defaultView ?? window;
            const style = view.getComputedStyle(element);
            if (style.overflowY === "hidden" || style.overflowY === "clip") return false;
            return element.scrollHeight > element.clientHeight + 2;
          };
          const labelFor = (element, fallback) => {
            if (element === document.scrollingElement) return "document";
            if (element === root.scrollingElement) return root === document ? "document" : "frame-document";
            return (
              element.id ||
              Array.from(element.classList ?? []).join(".") ||
              fallback ||
              element.tagName.toLowerCase()
            );
          };
          const targets = [];
          const pushTarget = (element, fallback) => {
            if (element && !isVisible(element)) return;
            if (!element || targets.some((target) => target.element === element)) return;
            targets.push({ element, label: labelFor(element, fallback) });
          };

          for (const selector of containerSelectors) {
            try {
              for (const element of Array.from(root.querySelectorAll(selector))) {
                pushTarget(element, selector);
              }
            } catch {}
          }

          const firstVisibleItem = Array.from(root.querySelectorAll(itemSelector)).find(isVisible);
          let current = firstVisibleItem?.parentElement ?? null;
          while (current && current !== root.body && current !== root.documentElement) {
            pushTarget(current, "item-ancestor");
            current = current.parentElement;
          }

          if (surface === "recommend-list" && root !== document) {
            const outerFrame = iframe ?? window.frameElement;
            let outer = outerFrame?.parentElement ?? null;
            while (outer && outer !== document.body && outer !== document.documentElement) {
              pushTarget(outer, "iframe-ancestor");
              outer = outer.parentElement;
            }
            pushTarget(document.scrollingElement, "document");
            pushTarget(document.documentElement, "documentElement");
            pushTarget(document.body, "body");
          }
          pushTarget(root.scrollingElement, root === document ? "document" : "frame-document");

          const scrollTarget = targets.find((target) => isScrollable(target.element));
          if (!scrollTarget) {
            return {
              containerFound: false,
              containerLabel: targets[0]?.label ?? "",
              scrollTop: 0,
              scrollHeight: 0,
              clientHeight: 0,
              itemCount,
              atStart: true,
              atEnd: true
            };
          }

          const scrollable = scrollTarget.element;
          const max = Math.max(0, scrollable.scrollHeight - scrollable.clientHeight);
          const amount = explicitDistance ?? Math.max(320, Math.floor(scrollable.clientHeight * 0.85));
          scrollable.scrollTop =
            direction === "up"
              ? Math.max(0, scrollable.scrollTop - amount)
              : Math.min(max, scrollable.scrollTop + amount);

          return {
            containerFound: true,
            containerLabel: scrollTarget.label,
            scrollTop: scrollable.scrollTop,
            scrollHeight: scrollable.scrollHeight,
            clientHeight: scrollable.clientHeight,
            itemCount,
            atStart: scrollable.scrollTop <= 1,
              atEnd: scrollable.scrollTop >= max - 1
          };
        })()`;

    const mainSnapshot = toDynamicListSnapshot(await this.evaluateJson(expression));
    if (surface !== "recommend-list" || mainSnapshot.itemCount > 0) {
      return mainSnapshot;
    }

    const frameValue = await this.evaluateRecommendFrameJson(expression);
    const frameSnapshot = toDynamicListSnapshot(frameValue);
    return frameSnapshot.itemCount > 0 ? frameSnapshot : mainSnapshot;
  }

  private async scrollChatList(): Promise<NativeScrollResult> {
    const result = await this.scrollSurface("chat-list", {
      direction: "down",
      steps: 1,
      settleMs: 0,
    });
    return {
      ok: result.success && result.stepsCompleted > 0,
      before: result.before.scrollTop,
      after: result.after.scrollTop,
      max: Math.max(0, result.after.scrollHeight - result.after.clientHeight),
    };
  }
}
