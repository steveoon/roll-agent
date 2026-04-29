import type {
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserRuntime,
  NativeCdpController,
  NativeCdpFrameTree,
} from "@roll-agent/browser";
import {
  NativeMouseMotionController,
  type NativeMouseMotionObserver,
  type NativeMousePoint,
} from "../../native-mouse-motion.ts";
import { matchesPlatformHost } from "../../platforms.ts";
import { getContextManager, getRuntime } from "../../runtime-holder.ts";
import type {
  DynamicListCollectionStopReason,
  DynamicListScrollResult,
  DynamicListSnapshot,
  ScrollDirection,
} from "../shared/dynamic-list-scroller.ts";
import {
  selectChatCandidate,
  type ChatListItem,
  type ChatTarget,
  type OpenChatResult,
} from "./chat-navigation.ts";
import { getZhipinListSurfaceConfig, type ZhipinListSurface } from "./list-surfaces.ts";
import type {
  ZhipinRecommendFilterApplied,
  ZhipinRecommendFilterApplyResult,
  ZhipinRecommendFilterRequest,
} from "./recommend-filter.ts";
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
const NATIVE_CLICK_PRESS_MS = 90;
const NATIVE_WHEEL_SCROLL_DISTANCE = 520;
const NATIVE_DEFAULT_AGE_MIN = 16;
const NATIVE_AGE_SLIDER_NUMERIC_MAX_ESTIMATE = 50;
const NATIVE_AGE_DRAG_SETTLE_MS = 650;
const NATIVE_AGE_DRAG_ATTEMPTS = 10;
const NATIVE_AGE_HANDLE_MIN_GAP_RATIO = 0.015;
const NATIVE_CLICKABLE_OPTION_SELECTOR =
  "button, a, label, li, span, div, [role='button'], [role='radio']";

type NativeScrollResult = {
  readonly ok: boolean;
  readonly before: number;
  readonly after: number;
  readonly max: number;
};

type NativeRecommendAgeState = {
  readonly ageMin?: number;
  readonly ageMax?: number;
  readonly minRatio?: number;
  readonly maxRatio?: number;
};

type NativeAgeSliderResolution =
  | {
      readonly ok: true;
      readonly current: NativeRecommendAgeState;
      readonly trackLeft: number;
      readonly trackTop: number;
      readonly trackWidth: number;
      readonly trackHeight: number;
      readonly minHandleX: number;
      readonly minHandleY: number;
      readonly maxHandleX: number;
      readonly maxHandleY: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
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

export type OpenNativeChatOptions = ChatTarget & {
  readonly preferUnread?: boolean;
  readonly maxScrolls?: number;
  readonly motionObserver?: NativeMouseMotionObserver;
};

export type NativeChatMessage = {
  readonly index: number;
  readonly sender: "candidate" | "recruiter" | "system";
  readonly messageType: "text" | "system" | "resume" | "wechat-exchange";
  readonly content: string;
  readonly time: string;
};

export type NativeChatPanelInfo = {
  readonly candidateName: string;
};

export type NativeSelectedChatTarget = {
  readonly conversationId: string;
  readonly candidateId: string;
  readonly candidateName: string;
};

export type NativeCandidateInfo = {
  readonly name: string;
  readonly age: string;
  readonly experience: string;
  readonly education: string;
  readonly communicationPosition: string;
  readonly expectedJobText: string;
  readonly expectedSalary: string;
  readonly tags: readonly string[];
};

export type NativeCandidateChatDetails = {
  readonly selectedTarget: NativeSelectedChatTarget | null;
  readonly activePanel: NativeChatPanelInfo | null;
  readonly candidateInfo: NativeCandidateInfo;
  readonly messages: readonly NativeChatMessage[];
};

export type NativeRecommendCardInspection = {
  readonly found: boolean;
  readonly cardSelector: string;
  readonly candidateId: string;
  readonly name: string;
  readonly hasGreetButton: boolean;
  readonly error?: string;
};

export type NativeRecommendGreetResult = NativeRecommendCardInspection & {
  readonly clicked: boolean;
};

export type NativeWechatExchangeResult = {
  readonly success: boolean;
  readonly exchanged: boolean;
  readonly wechatNumber?: string;
  readonly error?: string;
};

export type NativeSendReplyResult = {
  readonly success: boolean;
  readonly error?: string;
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

type NativeFrameOffset = {
  readonly found: boolean;
  readonly left: number;
  readonly top: number;
};

type NativeClickOptions = {
  readonly motionObserver?: NativeMouseMotionObserver;
  readonly preClickDelayMs?: number;
  readonly pressDurationMs?: number;
  readonly settleMs?: number;
};

type NativePageResolutionOptions = {
  readonly requireChatPage?: boolean;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toNativeMousePoint(target: NativeClickTarget): NativeMousePoint {
  return {
    x: target.x,
    y: target.y,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatPageUrl(url: string): boolean {
  return url.includes("/web/chat/index");
}

function normalizeCandidateName(name: string): string {
  return name.trim().toLocaleLowerCase("zh-CN");
}

function namesCompatible(expectedName: string, actualName: string): boolean {
  const expected = normalizeCandidateName(expectedName);
  const actual = normalizeCandidateName(actualName);
  return (
    expected.length > 0 &&
    actual.length > 0 &&
    (expected === actual || expected.includes(actual) || actual.includes(expected))
  );
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

function toNativeSelectedChatTarget(value: unknown): NativeSelectedChatTarget | null {
  if (!isRecord(value)) {
    return null;
  }

  const conversationId = requireString(value["conversationId"]);
  const candidateId = requireString(value["candidateId"]);
  if (conversationId.length === 0 || candidateId.length === 0) {
    return null;
  }

  return {
    conversationId,
    candidateId,
    candidateName: requireString(value["candidateName"]),
  };
}

function toNativeChatPanelInfo(value: unknown): NativeChatPanelInfo | null {
  if (!isRecord(value)) {
    return null;
  }

  const candidateName = requireString(value["candidateName"]);
  return candidateName.length > 0 ? { candidateName } : null;
}

function toNativeChatMessages(value: unknown): NativeChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }

    const sender = item["sender"];
    const messageType = item["messageType"];
    if (sender !== "candidate" && sender !== "recruiter" && sender !== "system") {
      return [];
    }
    if (
      messageType !== "text" &&
      messageType !== "system" &&
      messageType !== "resume" &&
      messageType !== "wechat-exchange"
    ) {
      return [];
    }

    return [
      {
        index:
          typeof item["index"] === "number" && Number.isInteger(item["index"])
            ? item["index"]
            : index,
        sender,
        messageType,
        content: requireString(item["content"]),
        time: requireString(item["time"]),
      },
    ];
  });
}

function toNativeCandidateInfo(value: unknown): NativeCandidateInfo {
  const candidateInfo = isRecord(value) ? value : {};
  const tags = candidateInfo["tags"];

  return {
    name: requireString(candidateInfo["name"]),
    age: requireString(candidateInfo["age"]),
    experience: requireString(candidateInfo["experience"]),
    education: requireString(candidateInfo["education"]),
    communicationPosition: requireString(candidateInfo["communicationPosition"]),
    expectedJobText: requireString(candidateInfo["expectedJobText"]),
    expectedSalary: requireString(candidateInfo["expectedSalary"]),
    tags: Array.isArray(tags) ? tags.map((tag) => requireString(tag)).filter(Boolean) : [],
  };
}

function toNativeCandidateChatDetails(value: unknown): NativeCandidateChatDetails {
  const payload = isRecord(value) ? value : {};

  return {
    selectedTarget: toNativeSelectedChatTarget(payload["selectedTarget"]),
    activePanel: toNativeChatPanelInfo(payload["activePanel"]),
    candidateInfo: toNativeCandidateInfo(payload["candidateInfo"]),
    messages: toNativeChatMessages(payload["messages"]),
  };
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

function toNativeFrameOffset(value: unknown): NativeFrameOffset {
  if (!isRecord(value)) {
    return { found: false, left: 0, top: 0 };
  }

  return {
    found: requireBoolean(value["found"]),
    left: requireNumber(value["left"]),
    top: requireNumber(value["top"]),
  };
}

function toNativeRecommendCardInspection(value: unknown): NativeRecommendCardInspection {
  if (!isRecord(value)) {
    return {
      found: false,
      cardSelector: RECOMMEND_CARD_SELECTOR,
      candidateId: "",
      name: "",
      hasGreetButton: false,
    };
  }

  return {
    found: requireBoolean(value["found"]),
    cardSelector: requireString(value["cardSelector"]) || RECOMMEND_CARD_SELECTOR,
    candidateId: requireString(value["candidateId"]),
    name: requireString(value["name"]),
    hasGreetButton: requireBoolean(value["hasGreetButton"]),
    ...(typeof value["error"] === "string" ? { error: value["error"] } : {}),
  };
}

function toNativeRecommendAgeState(value: unknown): NativeRecommendAgeState {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...(typeof value["ageMin"] === "number" ? { ageMin: value["ageMin"] } : {}),
    ...(typeof value["ageMax"] === "number" ? { ageMax: value["ageMax"] } : {}),
    ...(typeof value["minRatio"] === "number" ? { minRatio: value["minRatio"] } : {}),
    ...(typeof value["maxRatio"] === "number" ? { maxRatio: value["maxRatio"] } : {}),
  };
}

function toNativeAgeSliderResolution(value: unknown): NativeAgeSliderResolution {
  if (!isRecord(value) || value["ok"] !== true) {
    return {
      ok: false,
      error: isRecord(value) ? requireString(value["error"]) || "未找到年龄滑块" : "未找到年龄滑块",
    };
  }

  return {
    ok: true,
    current: toNativeRecommendAgeState(value["current"]),
    trackLeft: requireNumber(value["trackLeft"]),
    trackTop: requireNumber(value["trackTop"]),
    trackWidth: requireNumber(value["trackWidth"]),
    trackHeight: requireNumber(value["trackHeight"]),
    minHandleX: requireNumber(value["minHandleX"]),
    minHandleY: requireNumber(value["minHandleY"]),
    maxHandleX: requireNumber(value["maxHandleX"]),
    maxHandleY: requireNumber(value["maxHandleY"]),
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
  private readonly mouse: NativeMouseMotionController;
  private recommendFrameContextId: number | undefined;
  private recommendFrameContextFrameId: string | undefined;

  constructor(options: ZhipinNativePagePortOptions) {
    this.target = options.target;
    this.controller = options.controller;
    this.mouse = new NativeMouseMotionController(options.controller);
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

  private async readRecommendFrameOffset(): Promise<NativeFrameOffset> {
    return toNativeFrameOffset(
      await this.evaluateJson(
        `(() => {
          const iframe =
            document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.iframe)}) ??
            document.querySelector('iframe[name="recommendFrame"]') ??
            document.querySelector('iframe[src*="recommend"]');
          if (!iframe) {
            return { found: false, left: 0, top: 0 };
          }
          const rect = iframe.getBoundingClientRect();
          return { found: rect.width > 0 && rect.height > 0, left: rect.left, top: rect.top };
        })()`,
      ).catch(() => undefined),
    );
  }

  private async resolveRecommendClickTarget(expression: string): Promise<NativeClickTarget> {
    const mainTarget = toNativeClickTarget(
      await this.evaluateJson(expression).catch(() => undefined),
    );
    if (mainTarget.found) {
      return mainTarget;
    }

    const frameTarget = toNativeClickTarget(await this.evaluateRecommendFrameJson(expression));
    if (!frameTarget.found) {
      return frameTarget;
    }

    const offset = await this.readRecommendFrameOffset();
    if (!offset.found) {
      return frameTarget;
    }

    return {
      found: true,
      x: Math.round(frameTarget.x + offset.left),
      y: Math.round(frameTarget.y + offset.top),
    };
  }

  private async dispatchNativeClick(
    target: NativeClickTarget,
    options: NativeClickOptions = {},
  ): Promise<boolean> {
    if (!target.found) {
      return false;
    }

    await this.mouse.click(toNativeMousePoint(target), {
      ...(options.motionObserver !== undefined ? { motionObserver: options.motionObserver } : {}),
      ...(options.preClickDelayMs !== undefined
        ? { preClickDelayMs: options.preClickDelayMs }
        : {}),
      pressDurationMs: options.pressDurationMs ?? NATIVE_CLICK_PRESS_MS,
      settleMs: options.settleMs ?? NATIVE_CLICK_SETTLE_MS,
    });
    return true;
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

    const target = toNativeClickTarget(
      await this.evaluateJson(
        `(() => {
          const selector = ${JSON.stringify(selector)};
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
          const selectorTargets = Array.from(document.querySelectorAll(selector))
            .filter((element) => visible(element))
            .sort((left, right) => area(left) - area(right));
          if (selectorTargets[0]) {
            return readCenter(selectorTargets[0]);
          }

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

    return await this.dispatchNativeClick(target, options);
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

  async openChat(options: OpenNativeChatOptions): Promise<OpenChatResult> {
    await this.bringToFront().catch(() => {});

    if (!(await this.isChatSurfaceOpen().catch(() => false))) {
      const clicked = await this.clickSidebarSection("chat", {
        ...(options.motionObserver !== undefined ? { motionObserver: options.motionObserver } : {}),
      });
      if (!clicked || !(await this.waitForChatSurface())) {
        return {
          found: false,
          conversationId: "",
          candidateId: "",
          name: options.candidateName ?? "",
          index: options.index ?? -1,
          position: "",
          hasUnread: false,
          unreadCount: 0,
          lastMessageTime: "",
          messagePreview: "",
          error: "消息列表未加载",
        };
      }
    }

    const maxScrolls = Math.max(0, Math.floor(options.maxScrolls ?? 4));
    const hasExplicitTarget =
      options.conversationId !== undefined ||
      options.candidateName !== undefined ||
      options.index !== undefined;
    const snapshots: ChatListItem[] = [];

    for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
      snapshots.push(...(await this.readVisibleChatCandidates()));
      const candidates = dedupeChatItems(snapshots);
      const selected =
        options.preferUnread === true && !hasExplicitTarget
          ? candidates.find((candidate) => candidate.hasUnread)
          : selectChatCandidate(candidates, options);

      if (selected !== undefined) {
        const clicked = await this.clickChatCandidate(selected, {
          ...(options.motionObserver !== undefined
            ? { motionObserver: options.motionObserver }
            : {}),
        });
        if (!clicked) {
          return {
            ...selected,
            found: false,
            error: `未能点击候选人: ${selected.name || selected.conversationId}`,
          };
        }
        await delay(NATIVE_CLICK_SETTLE_MS);
        let ready = await this.waitForNativeChatReady(selected);
        if (!ready) {
          const retried = await this.clickChatCandidate(selected, {
            ...(options.motionObserver !== undefined
              ? { motionObserver: options.motionObserver }
              : {}),
          });
          if (retried) {
            await delay(NATIVE_CLICK_SETTLE_MS);
            ready = await this.waitForNativeChatReady(selected);
          }
        }
        if (!ready) {
          return {
            ...selected,
            found: false,
            error: `打开候选人聊天后，右侧会话未同步切换到 ${selected.name || selected.conversationId}`,
          };
        }
        return { ...selected, found: true };
      }

      if (attempt >= maxScrolls) {
        break;
      }

      const scrollResult = await this.scrollChatList();
      if (!scrollResult.ok) {
        break;
      }
      await delay(NATIVE_SCROLL_PAUSE_MS);
    }

    return {
      found: false,
      conversationId: "",
      candidateId: "",
      name: options.candidateName ?? "",
      index: options.index ?? -1,
      position: "",
      hasUnread: false,
      unreadCount: 0,
      lastMessageTime: "",
      messagePreview: "",
      error: `未找到候选人: ${options.candidateName ?? `index ${options.index ?? 0}`}`,
    };
  }

  async readSelectedChatTarget(): Promise<NativeSelectedChatTarget | null> {
    return toNativeSelectedChatTarget(
      await this.evaluateJson(
        `(() => {
          const selected = document.querySelector(".geek-item.selected");
          if (!selected) {
            return null;
          }

          const conversationId =
            selected.getAttribute("data-id") ??
            selected.closest('[role="listitem"]')?.getAttribute("key") ??
            "";
          const candidateId =
            selected.getAttribute("data-geek") ??
            selected.querySelector("[data-geek]")?.getAttribute("data-geek") ??
            conversationId;
          const candidateName =
            selected
              .querySelector('[class*="name"], .nickname, .geek-name, .candidate-name')
              ?.textContent?.trim() ?? "";

          return { conversationId, candidateId, candidateName };
        })()`,
      ),
    );
  }

  async readActiveChatPanel(): Promise<NativeChatPanelInfo | null> {
    return toNativeChatPanelInfo(
      await this.evaluateJson(
        `(() => {
          const rootSelectors = [".chat-conversation", ".conversation-box", ".conversation-message"];
          const nameSelectors = [
            ".base-info-single-detial .name-box",
            ".base-info-content .name-box",
            ".base-info-single-container .name-box",
            ".base-info-content .base-name",
            ".chat-user-name",
            ".name-box",
            ".base-name",
          ];

          for (const rootSelector of rootSelectors) {
            const root = document.querySelector(rootSelector);
            if (!root) continue;

            for (const nameSelector of nameSelectors) {
              const candidateName = root.querySelector(nameSelector)?.textContent?.trim() ?? "";
              if (candidateName.length > 0) {
                return { candidateName };
              }
            }
          }

          return null;
        })()`,
      ),
    );
  }

  async waitForChatMessages(timeoutMs = 8_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const ready = await this.evaluateJson<boolean>(
        `document.querySelector(".chat-message-list .message-item, .conversation-message .message-item") !== null`,
      ).catch(() => false);
      if (ready) {
        return true;
      }
      await delay(NATIVE_SELECTOR_POLL_MS);
    }

    return await this.evaluateJson<boolean>(
      `document.querySelector(".chat-message-list .message-item, .conversation-message .message-item") !== null`,
    ).catch(() => false);
  }

  async readCandidateChatDetails(maxMessages: number): Promise<NativeCandidateChatDetails> {
    const safeMaxMessages = Math.max(0, Math.floor(maxMessages));
    return toNativeCandidateChatDetails(
      await this.evaluateJson(
        `(() => {
          const maxMsgs = ${JSON.stringify(safeMaxMessages)};
          const selected = document.querySelector(".geek-item.selected");
          const selectedTarget = selected
            ? {
                conversationId:
                  selected.getAttribute("data-id") ??
                  selected.closest('[role="listitem"]')?.getAttribute("key") ??
                  "",
                candidateId:
                  selected.getAttribute("data-geek") ??
                  selected.querySelector("[data-geek]")?.getAttribute("data-geek") ??
                  selected.getAttribute("data-id") ??
                  selected.closest('[role="listitem"]')?.getAttribute("key") ??
                  "",
                candidateName:
                  selected
                    .querySelector('[class*="name"], .nickname, .geek-name, .candidate-name')
                    ?.textContent?.trim() ?? ""
              }
            : null;

          const conversationRoot =
            document.querySelector(".chat-conversation") ??
            document.querySelector(".conversation-box") ??
            document;

          const nameSelectors = [
            ".base-info-single-detial .name-box",
            ".base-info-content .name-box",
            ".base-info-single-container .name-box",
            ".base-info-content .base-name",
            ".chat-user-name",
            ".name-box",
            ".base-name"
          ];
          let activePanel = null;
          for (const nameSelector of nameSelectors) {
            const candidateName =
              conversationRoot.querySelector(nameSelector)?.textContent?.trim() ?? "";
            if (candidateName.length > 0) {
              activePanel = { candidateName };
              break;
            }
          }

          const detailArea = conversationRoot.querySelector(
            ".base-info-single-detial, .base-info-content, .base-info-single-container"
          );
          const name =
            detailArea
              ?.querySelector(".name-box, .base-name, .chat-user-name, .geek-name")
              ?.textContent?.trim() ?? "";

          const infoItems = detailArea
            ? detailArea.querySelectorAll(":scope > div")
            : conversationRoot.querySelectorAll(".geek-info-item, .base-info-item");
          const infoTexts = [];
          infoItems.forEach((el) => {
            const text = el.textContent?.trim();
            if (text) infoTexts.push(text);
          });
          const fullInfo = infoTexts.join(" ");

          const ageMatch = fullInfo.match(/(\\d{2,3})岁/);
          const age = ageMatch ? ageMatch[1] + "岁" : "";
          const expMatch = fullInfo.match(/(\\d+年(?:以上)?|应届生|在校生)/);
          const experience = expMatch?.[1] ?? "";
          const education = fullInfo.match(/(初中|高中|中专|大专|本科|硕士|博士)/)?.[1] ?? "";

          let communicationPosition = "";
          const posNameEl = conversationRoot.querySelector(".position-name");
          if (posNameEl) {
            const cloned = posNameEl.cloneNode(true);
            cloned.querySelectorAll(".popover-wrap, .tooltip-job").forEach((element) => element.remove());
            communicationPosition = cloned.textContent?.trim() ?? "";
          }

          let expectedJobText = "";
          const expectValue = conversationRoot.querySelector(".position-item.expect .value.job");
          if (expectValue) {
            expectedJobText = expectValue.textContent?.trim() ?? "";
          }
          const expectedSalary =
            conversationRoot
              .querySelector(".position-item.expect .high-light-orange")
              ?.textContent?.trim() ?? "";

          const tags = [];
          if (detailArea) {
            detailArea
              .querySelectorAll(".geek-tag, .base-info-item .high-light-boss")
              .forEach((element) => {
                const text = element.textContent?.trim();
                if (text && !text.includes("更换职位") && text.length < 20) tags.push(text);
              });
          }

          const msgItems = conversationRoot.querySelectorAll(
            ".chat-message-list > .message-item, .conversation-message .message-item"
          );
          const timeRegex = /\\d{1,2}:\\d{2}(?::\\d{2})?|\\d{4}-\\d{2}-\\d{2}/;
          const messages = [];
          let msgIdx = 0;

          msgItems.forEach((item) => {
            if (msgIdx >= maxMsgs) return;

            const hasFriend = item.querySelector(".item-friend") !== null;
            const hasMyself = item.querySelector(".item-myself") !== null;
            const hasSystem = item.querySelector(".item-system") !== null;
            const hasResume = item.querySelector(".item-resume") !== null;
            const hasDialog = item.querySelector(".message-dialog-center") !== null;

            let sender = "system";
            let messageType = "text";
            if (hasFriend) {
              sender = "candidate";
            } else if (hasMyself) {
              sender = "recruiter";
            } else if (hasSystem || hasDialog) {
              sender = "system";
              messageType = "system";
            }
            if (hasResume) messageType = "resume";

            const cardEl = item.querySelector(".message-card-top-wrap, [class*='d-top-text']");
            if (cardEl) {
              const cardText = cardEl.textContent ?? "";
              if (cardText.includes("微信") || cardText.includes("WeChat")) {
                messageType = "wechat-exchange";
              }
            }

            const timeEl = item.querySelector(".message-time .time, .message-time");
            const timeMatch = (timeEl?.textContent ?? "").match(timeRegex);
            const time = timeMatch ? timeMatch[0] : "";

            let content = "";
            if (messageType === "wechat-exchange" && cardEl) {
              const cardText = cardEl.textContent ?? "";
              const digitMatch = cardText.match(/\\b(\\d{8,15})\\b/);
              const wxMatch = cardText.match(/微信[：:号]*\\s*([a-zA-Z0-9_-]{5,20})/);
              if (digitMatch) content = "[微信号: " + digitMatch[1] + "]";
              else if (wxMatch) content = "[微信号: " + wxMatch[1] + "]";
              else content = "[交换微信]";
            } else if (cardEl) {
              const titleEl = item.querySelector(".message-card-top-title");
              const descEl = item.querySelector(".dialog-content, .message-card-top-text");
              content = (titleEl?.textContent?.trim() ?? descEl?.textContent?.trim() ?? "").trim();
            } else {
              const textEl = item.querySelector(".text span, .text-content, .text");
              if (textEl) {
                content = (textEl.textContent?.trim() ?? "")
                  .replace(timeRegex, "")
                  .replace("已读", "")
                  .trim();
              }
            }

            if (content || messageType !== "text") {
              messages.push({ index: msgIdx, sender, messageType, content, time });
              msgIdx += 1;
            }
          });

          return {
            selectedTarget,
            activePanel,
            candidateInfo: {
              name,
              age,
              experience,
              education,
              communicationPosition,
              expectedJobText,
              expectedSalary,
              tags
            },
            messages
          };
        })()`,
      ),
    );
  }

  async inspectRecommendCard(index: number): Promise<NativeRecommendCardInspection> {
    const safeIndex = Math.max(0, Math.floor(index));
    const expression = this.buildRecommendCardInspectionExpression(safeIndex);
    const mainResult = toNativeRecommendCardInspection(
      await this.evaluateJson(expression).catch(() => undefined),
    );
    if (mainResult.found) {
      return mainResult;
    }

    const frameResult = toNativeRecommendCardInspection(
      await this.evaluateRecommendFrameJson(expression),
    );
    return frameResult.found ? frameResult : mainResult;
  }

  async clickRecommendGreet(
    index: number,
    options: NativeClickOptions = {},
  ): Promise<NativeRecommendGreetResult> {
    const inspection = await this.inspectRecommendCard(index);
    if (!inspection.found || !inspection.hasGreetButton) {
      return {
        ...inspection,
        clicked: false,
        ...(!inspection.found && inspection.error === undefined ? { error: "索引超出范围" } : {}),
        ...(inspection.found && !inspection.hasGreetButton ? { error: "未找到打招呼按钮" } : {}),
      };
    }

    const target = await this.resolveRecommendClickTarget(
      this.buildRecommendGreetClickExpression(Math.max(0, Math.floor(index))),
    );
    const clicked = await this.dispatchNativeClick(target, options);
    return {
      ...inspection,
      clicked,
      ...(clicked ? {} : { error: "未能点击打招呼按钮" }),
    };
  }

  async exchangeWechat(options: NativeClickOptions = {}): Promise<NativeWechatExchangeResult> {
    const wechatButtonTarget = toNativeClickTarget(
      await this.evaluateJson(
        `(() => {
          const selectors = [
            ".chat-conversation .conversation-operate .operate-exchange-left span.operate-btn",
            ".chat-conversation .conversation-operate span.operate-btn",
            ".conversation-box .conversation-operate .operate-exchange-left span.operate-btn",
            ".conversation-box .conversation-operate span.operate-btn",
            ".conversation-operate .operate-exchange-left span.operate-btn",
            ".conversation-operate .operate-exchange-left span"
          ];
          const normalize = (text) => (text ?? "").replace(/\\s+/g, "").trim();
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          for (const selector of selectors) {
            for (const element of Array.from(document.querySelectorAll(selector))) {
              if (normalize(element.textContent) !== "换微信" || !visible(element)) continue;
              element.scrollIntoView({ block: "center", inline: "center" });
              const rect = element.getBoundingClientRect();
              return {
                found: true,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2)
              };
            }
          }
          return { found: false, x: 0, y: 0 };
        })()`,
      ).catch(() => undefined),
    );
    if (!(await this.dispatchNativeClick(wechatButtonTarget, options))) {
      return { success: false, exchanged: false, error: "未找到当前聊天输入区的「换微信」按钮" };
    }

    if (!(await this.waitForWechatExchangeDialog())) {
      return { success: false, exchanged: false, error: "确认对话框未弹出" };
    }

    const confirmTarget = toNativeClickTarget(
      await this.evaluateJson(
        `(() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const normalize = (text) => (text ?? "").replace(/\\s+/g, "").trim();
          const tooltip = document.querySelector(".exchange-tooltip");
          const selectorGroups = tooltip
            ? [
                [tooltip, ".btn-box .boss-btn-primary.boss-btn"],
                [tooltip, ".btn-box span.boss-btn-primary"],
                [tooltip, "span.boss-btn-primary"],
                [tooltip, ".boss-btn-primary"]
              ]
            : [];
          for (const [root, selector] of selectorGroups) {
            const button = root.querySelector(selector);
            if (button && visible(button)) {
              const rect = button.getBoundingClientRect();
              return {
                found: true,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2)
              };
            }
          }

          for (const container of Array.from(document.querySelectorAll("div, section, aside"))) {
            const text = container.textContent ?? "";
            if (!text.includes("交换微信") || !visible(container)) continue;
            const buttons = container.querySelectorAll(
              "span.boss-btn-primary, button.boss-btn-primary, span.boss-btn, button.boss-btn"
            );
            for (const button of Array.from(buttons)) {
              if (normalize(button.textContent) !== "确定" || !visible(button)) continue;
              const rect = button.getBoundingClientRect();
              return {
                found: true,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2)
              };
            }
          }
          return { found: false, x: 0, y: 0 };
        })()`,
      ).catch(() => undefined),
    );
    if (!(await this.dispatchNativeClick(confirmTarget, options))) {
      return { success: false, exchanged: false, error: "未找到确认按钮" };
    }

    await delay(1_800);
    const wechatNumber = await this.readWechatNumber();
    return {
      success: true,
      exchanged: true,
      ...(wechatNumber !== undefined ? { wechatNumber } : {}),
    };
  }

  async sendChatReply(
    message: string,
    options: NativeClickOptions = {},
  ): Promise<NativeSendReplyResult> {
    const inputTarget = toNativeClickTarget(
      await this.evaluateJson(
        `(() => {
          const selectors = ["#boss-chat-editor-input", "textarea.chat-input", ".chat-input"];
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (!element || !visible(element)) continue;
            element.scrollIntoView({ block: "center", inline: "center" });
            const rect = element.getBoundingClientRect();
            return {
              found: true,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2)
            };
          }
          return { found: false, x: 0, y: 0 };
        })()`,
      ).catch(() => undefined),
    );
    if (!(await this.dispatchNativeClick(inputTarget, options))) {
      return { success: false, error: "未找到聊天输入框" };
    }

    await this.selectAllFocusedText();
    await this.controller.dispatchKeyEvent({
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await this.controller.dispatchKeyEvent({
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await this.controller.insertText(message);
    await delay(250);

    const sendTarget = toNativeClickTarget(
      await this.evaluateJson(
        `(() => {
          const selectors = [
            ".submit-content .submit.active",
            ".submit-content .submit",
            ".submit-content",
            ".btn-send"
          ];
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (!button || !visible(button)) continue;
            const rect = button.getBoundingClientRect();
            return {
              found: true,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2)
            };
          }
          for (const span of Array.from(document.querySelectorAll("span, button"))) {
            if ((span.textContent ?? "").replace(/\\s+/g, "").trim() !== "发送" || !visible(span)) {
              continue;
            }
            const rect = span.getBoundingClientRect();
            return {
              found: true,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2)
            };
          }
          return { found: false, x: 0, y: 0 };
        })()`,
      ).catch(() => undefined),
    );
    if (!(await this.dispatchNativeClick(sendTarget, options))) {
      return { success: false, error: "未找到发送按钮" };
    }

    await delay(800);
    return { success: true };
  }

  async applyRecommendFilter(
    requested: ZhipinRecommendFilterRequest,
    options: NativeClickOptions = {},
  ): Promise<ZhipinRecommendFilterApplyResult> {
    const surfaceReady = await this.waitForRecommendFilterSurface(3_000);
    if (!(await this.openRecommendFilterPanel(options))) {
      return {
        status: surfaceReady ? "filter_not_found" : "recommend_not_ready",
        requested,
        error: surfaceReady ? "未找到或无法打开筛选按钮" : "推荐牛人页未就绪",
      };
    }

    if (await this.detectVipModal()) {
      return { status: "requires_vip", requested, error: "筛选条件触发 VIP 弹窗" };
    }

    if (!(await this.clickRecommendFilterOption("性别", requested.gender, options))) {
      return {
        status: "filter_not_found",
        requested,
        error: `未找到性别筛选项：${requested.gender}`,
      };
    }

    if (!(await this.clickRecommendFilterOption("活跃度", requested.activity, options))) {
      return {
        status: "filter_not_found",
        requested,
        error: `未找到活跃度筛选项：${requested.activity}`,
      };
    }

    const ageResult = await this.setRecommendAgeRange(requested, options);
    if (!ageResult.success) {
      return { status: "age_not_applied", requested, error: ageResult.error };
    }

    if (await this.detectVipModal()) {
      return { status: "requires_vip", requested, error: "年龄筛选触发 VIP 弹窗" };
    }

    const applied = await this.readNativeAppliedFilterState(requested, ageResult.state);
    if (!(await this.clickRecommendFilterSubmit(options))) {
      return { status: "submit_failed", requested, applied, error: "筛选确认失败" };
    }

    const filterButtonText = await this.readRecommendFilterButtonText();
    return {
      status: "applied",
      requested,
      applied,
      ...(filterButtonText !== undefined ? { filterButtonText } : {}),
    };
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

  private buildRecommendCardInspectionExpression(index: number): string {
    return `(() => {
      const index = ${JSON.stringify(index)};
      const primarySelector = ${JSON.stringify(RECOMMEND_CARD_SELECTOR)};
      const fallbackSelector = ${JSON.stringify(RECOMMEND_FALLBACK_CARD_SELECTOR)};
      const iframe = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.iframe)});
      const href = location.href;
      const recommendUrlMarkers = ${JSON.stringify(ZHIPIN_RECOMMEND_URL_MARKERS)};
      const hasRecommendUrl = recommendUrlMarkers.some((marker) => href.includes(marker));
      if (!hasRecommendUrl && href.includes("/web/chat/index")) {
        return {
          found: false,
          cardSelector: primarySelector,
          candidateId: "",
          name: "",
          hasGreetButton: false,
          error: "推荐列表未加载"
        };
      }

      const root = iframe?.contentDocument ?? document;
      const primaryCards = Array.from(root.querySelectorAll(primarySelector));
      const cardSelector = primaryCards.length > 0 ? primarySelector : fallbackSelector;
      const cards = primaryCards.length > 0 ? primaryCards : Array.from(root.querySelectorAll(cardSelector));
      if (cards.length <= index) {
        return {
          found: false,
          cardSelector,
          candidateId: "",
          name: "",
          hasGreetButton: false,
          error: "索引超出范围"
        };
      }

      const item = cards[index];
      const candidateId =
        item.getAttribute("data-geek") ??
        item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
        "";
      const name = item.querySelector(".name")?.textContent?.trim() ?? "";
      const greetButton =
        item.querySelector("button.btn.btn-greet") ??
        item.querySelector("button.btn-greet") ??
        item.querySelector(".btn-greet") ??
        item.querySelector(".op-btn");
      const rect = greetButton?.getBoundingClientRect();
      const hasGreetButton = Boolean(rect && rect.width > 0 && rect.height > 0);

      return { found: true, cardSelector, candidateId, name, hasGreetButton };
    })()`;
  }

  private buildRecommendGreetClickExpression(index: number): string {
    return `(() => {
      const index = ${JSON.stringify(index)};
      const primarySelector = ${JSON.stringify(RECOMMEND_CARD_SELECTOR)};
      const fallbackSelector = ${JSON.stringify(RECOMMEND_FALLBACK_CARD_SELECTOR)};
      const iframe = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.iframe)});
      const root = iframe?.contentDocument ?? document;
      const primaryCards = Array.from(root.querySelectorAll(primarySelector));
      const cards =
        primaryCards.length > 0
          ? primaryCards
          : Array.from(root.querySelectorAll(fallbackSelector));
      const item = cards[index];
      if (!item) return { found: false, x: 0, y: 0 };
      const button =
        item.querySelector("button.btn.btn-greet") ??
        item.querySelector("button.btn-greet") ??
        item.querySelector(".btn-greet") ??
        item.querySelector(".op-btn");
      if (!button) return { found: false, x: 0, y: 0 };
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { found: false, x: 0, y: 0 };
      return {
        found: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };
    })()`;
  }

  private async waitForWechatExchangeDialog(timeoutMs = 5_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const found = await this.evaluateJson<boolean>(
        `(() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const tooltip = document.querySelector(".exchange-tooltip");
          if (tooltip && visible(tooltip)) return true;
          for (const element of Array.from(document.querySelectorAll("div, section, aside"))) {
            const text = element.textContent ?? "";
            if (
              text.includes("交换微信") &&
              element.querySelector(".boss-btn-primary, .boss-btn") &&
              visible(element)
            ) {
              return true;
            }
          }
          return false;
        })()`,
      ).catch(() => false);
      if (found) {
        return true;
      }
      await delay(450);
    }
    return false;
  }

  private async readWechatNumber(): Promise<string | undefined> {
    const value = await this.evaluateJson<string | null>(
      `(() => {
        const cardSelectors = [
          ".message-card-top-wrap",
          '[class*="d-top-text"]',
          ".message-card-top-title"
        ];
        const parse = (text) => {
          const digitMatch = text.match(/\\b(\\d{8,15})\\b/);
          if (digitMatch) return digitMatch[1];
          const wxMatch = text.match(/微信[：:号]*\\s*([a-zA-Z0-9_-]{5,20})/);
          if (wxMatch) return wxMatch[1];
          const letterMatch = text.match(/\\b([a-zA-Z][a-zA-Z0-9_-]{5,19})\\b/);
          if (letterMatch && !["微信", "WeChat"].includes(letterMatch[1])) {
            return letterMatch[1];
          }
          return null;
        };

        for (const selector of cardSelectors) {
          const cards = Array.from(document.querySelectorAll(selector));
          for (let index = cards.length - 1; index >= 0; index -= 1) {
            const parsed = parse(cards[index]?.textContent ?? "");
            if (parsed) return parsed;
          }
        }

        const msgItems = Array.from(document.querySelectorAll(".message-item"));
        for (let index = msgItems.length - 1; index >= 0; index -= 1) {
          const card = msgItems[index]?.querySelector('.message-card-top-wrap, [class*="d-top-text"]');
          if (!card) continue;
          const parsed = parse(card.textContent ?? "");
          if (parsed) return parsed;
        }
        return null;
      })()`,
    ).catch(() => null);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private async selectAllFocusedText(): Promise<void> {
    const modifierVariants = [4, 2];
    for (const modifiers of modifierVariants) {
      await this.controller.dispatchKeyEvent({
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers,
      });
      await this.controller.dispatchKeyEvent({
        type: "keyUp",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers,
      });
      await delay(40);
    }
  }

  private async waitForRecommendFilterSurface(timeoutMs = 10_000): Promise<boolean> {
    const expression = `(() => {
      return document.querySelector(${JSON.stringify(
        `${ZHIPIN_SELECTORS.recommend.filterButton}, ${RECOMMEND_CARD_SELECTOR}, ${ZHIPIN_SELECTORS.recommend.candidateItem}`,
      )}) !== null;
    })()`;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (
        (await this.evaluateJson<boolean>(expression).catch(() => false)) ||
        ((await this.evaluateRecommendFrameJson<boolean>(expression)) ?? false)
      ) {
        return true;
      }
      await delay(NATIVE_SELECTOR_POLL_MS);
    }
    return false;
  }

  private async isRecommendFilterPanelVisible(): Promise<boolean> {
    const expression = `(() => {
      const panel = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.filterPanel)});
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`;
    return (
      (await this.evaluateJson<boolean>(expression).catch(() => false)) ||
      ((await this.evaluateRecommendFrameJson<boolean>(expression)) ?? false)
    );
  }

  private async openRecommendFilterPanel(options: NativeClickOptions): Promise<boolean> {
    if (await this.isRecommendFilterPanelVisible()) {
      return true;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.dismissPreviousFilterPrompt(options);
      const target = await this.resolveRecommendClickTarget(
        `(() => {
          const filterButtonSelector = ${JSON.stringify(ZHIPIN_SELECTORS.recommend.filterButton)};
          const normalize = (text) => (text ?? "").replace(/\\s+/g, " ").trim();
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const classText = (element) =>
            typeof element.className === "string" ? element.className : "";
          const scoreCandidate = (element) => {
            const classes = classText(element);
            const parentClasses = element.parentElement ? classText(element.parentElement) : "";
            const ancestorClasses =
              element.closest(".recommend-filter, .filter-label-wrap, .filter-wrap") !== null
                ? "recommend-filter"
                : "";
            let score = 0;
            for (const value of [classes, parentClasses, ancestorClasses]) {
              if (/recommend-filter/.test(value)) score += 3;
              else if (/filter-label/.test(value)) score += 2;
              else if (/filter/.test(value)) score += 1;
            }
            return score;
          };
          const selectorCandidates = Array.from(document.querySelectorAll(filterButtonSelector));
          const textCandidates = Array.from(
            document.querySelectorAll("button, a, span, div, [role='button']")
          ).filter((element) => /^筛选(?:·\\d+)?$/.test(normalize(element.textContent)));
          const candidate = [...selectorCandidates, ...textCandidates]
            .filter(visible)
            .sort((a, b) => {
              const scoreDelta = scoreCandidate(b) - scoreCandidate(a);
              if (scoreDelta !== 0) return scoreDelta;
              const aRect = a.getBoundingClientRect();
              const bRect = b.getBoundingClientRect();
              return aRect.width * aRect.height - bRect.width * bRect.height;
            })[0];
          if (!candidate) return { found: false, x: 0, y: 0 };
          candidate.scrollIntoView({ block: "center", inline: "center" });
          const rect = candidate.getBoundingClientRect();
          return {
            found: true,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        })()`,
      );
      if (await this.dispatchNativeClick(target, options)) {
        const openedAt = Date.now();
        while (Date.now() - openedAt < 4_000) {
          if (await this.isRecommendFilterPanelVisible()) {
            await this.dismissPreviousFilterPrompt(options);
            return true;
          }
          await delay(NATIVE_SELECTOR_POLL_MS);
        }
      }
      await delay(300);
    }

    return false;
  }

  private async dismissPreviousFilterPrompt(options: NativeClickOptions): Promise<boolean> {
    const target = await this.resolveRecommendClickTarget(
      `(() => {
        const normalize = (text) => (text ?? "").replace(/\\s+/g, " ").trim();
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const roots = Array.from(document.body.querySelectorAll("div, section, aside"))
          .filter((element) => visible(element))
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return aRect.width * aRect.height - bRect.width * bRect.height;
          });
        for (const root of roots) {
          const text = normalize(root.textContent);
          if (!text.includes("是否应用上次") && !text.includes("上次的筛选条件")) continue;
          const candidates = Array.from(
            root.querySelectorAll("button, a, span, div, [role='button']")
          ).filter(visible);
          for (const candidate of candidates) {
            const buttonText = normalize(candidate.textContent);
            if (/^(取消|不应用|否|关闭|稍后)$/.test(buttonText)) {
              const rect = candidate.getBoundingClientRect();
              return {
                found: true,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2)
              };
            }
          }
        }
        return { found: false, x: 0, y: 0 };
      })()`,
    );
    return await this.dispatchNativeClick(target, options);
  }

  private async clickRecommendFilterOption(
    rowLabel: string,
    optionLabel: string,
    options: NativeClickOptions,
  ): Promise<boolean> {
    const target = await this.resolveRecommendClickTarget(
      `(() => {
        const panelSelector = ${JSON.stringify(ZHIPIN_SELECTORS.recommend.filterPanel)};
        const rowLabel = ${JSON.stringify(rowLabel)};
        const optionLabel = ${JSON.stringify(optionLabel)};
        const clickableSelector = ${JSON.stringify(NATIVE_CLICKABLE_OPTION_SELECTOR)};
        const normalize = (text) => (text ?? "").replace(/\\s+/g, "").trim();
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const area = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width * rect.height;
        };
        const resolveClickable = (element, row) => {
          let current = element;
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

        const panel = Array.from(document.querySelectorAll(panelSelector))
          .filter(visible)
          .sort((a, b) => area(a) - area(b))[0];
        if (!panel) return { found: false, x: 0, y: 0 };

        const rows = Array.from(panel.querySelectorAll("div, li, dl, dd, section, ul"))
          .filter((element) => {
            const text = normalize(element.textContent);
            return visible(element) && text.includes(rowLabel) && text.includes(optionLabel);
          })
          .sort((a, b) => {
            const areaDelta = area(a) - area(b);
            if (areaDelta !== 0) return areaDelta;
            return normalize(a.textContent).length - normalize(b.textContent).length;
          });

        for (const row of rows) {
          const option = Array.from(row.querySelectorAll(clickableSelector))
            .filter((element) => visible(element) && normalize(element.textContent) === optionLabel)
            .sort((a, b) => area(a) - area(b))[0];
          if (!option) continue;
          const clickable = resolveClickable(option, row);
          clickable.scrollIntoView({ block: "center", inline: "center" });
          const rect = clickable.getBoundingClientRect();
          return {
            found: true,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        }

        return { found: false, x: 0, y: 0 };
      })()`,
    );
    return await this.dispatchNativeClick(target, options);
  }

  private async detectVipModal(): Promise<boolean> {
    const expression = `(() => {
      const normalize = (text) => (text ?? "").replace(/\\s+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const modalPattern =
        /(购买VIP|VIP账号|开通VIP|开启VIP|专享筛选特权|扫码支付|立即开通|支付金额)/;
      return Array.from(document.body.querySelectorAll("div, section, aside"))
        .some((element) => visible(element) && modalPattern.test(normalize(element.textContent)));
    })()`;
    return (
      (await this.evaluateJson<boolean>(expression).catch(() => false)) ||
      ((await this.evaluateRecommendFrameJson<boolean>(expression)) ?? false)
    );
  }

  private async readNativeAgeState(): Promise<NativeRecommendAgeState> {
    const expression = `(() => {
      const panelSelector = ${JSON.stringify(ZHIPIN_SELECTORS.recommend.filterPanel)};
      const normalize = (text) => (text ?? "").replace(/\\s+/g, "").trim();
      const parseAgeValue = (text) => {
        if (text.includes("不限")) return undefined;
        const match = text.match(/\\d+/);
        return match ? Number.parseInt(match[0], 10) : undefined;
      };
      const parseAgeState = (text) => {
        const normalized = normalize(text);
        const ageText = normalized.includes("年龄")
          ? normalized.slice(normalized.indexOf("年龄") + "年龄".length)
          : normalized;
        const numbers = Array.from(ageText.matchAll(/\\d+/g), (match) =>
          Number.parseInt(match[0], 10)
        ).filter((value) => Number.isInteger(value));
        const ageMin = numbers[0];
        const ageMax = ageText.includes("不限") ? undefined : numbers[1];
        return {
          ...(ageMin !== undefined ? { ageMin } : {}),
          ...(ageMax !== undefined ? { ageMax } : {})
        };
      };
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const area = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const classText = (element) =>
        typeof element.className === "string" ? element.className : "";
      const preferRailTrack = (elements) =>
        [...elements].sort((a, b) => {
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
      const looksLikeSlider = (element) => {
        const classes = classText(element);
        const role = element.getAttribute("role") ?? "";
        return /slider|range|track|bar/i.test(classes) || role === "slider";
      };
      const looksLikeHandle = (element) => {
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
      const readRatio = (dot, track) => {
        const styleLeft = dot.style.left;
        if (styleLeft.endsWith("%")) {
          const parsed = Number.parseFloat(styleLeft);
          if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed / 100));
        }
        const dotRect = dot.getBoundingClientRect();
        const trackRect = track.getBoundingClientRect();
        if (trackRect.width <= 0) return undefined;
        return Math.max(
          0,
          Math.min(1, (dotRect.left + dotRect.width / 2 - trackRect.left) / trackRect.width)
        );
      };
      const ratioToAge = (ratio) =>
        Math.round(
          ${JSON.stringify(NATIVE_DEFAULT_AGE_MIN)} +
            Math.max(0, Math.min(1, ratio)) *
              (${JSON.stringify(NATIVE_AGE_SLIDER_NUMERIC_MAX_ESTIMATE)} -
                ${JSON.stringify(NATIVE_DEFAULT_AGE_MIN)})
        );
      const panel = Array.from(document.querySelectorAll(panelSelector))
        .filter(visible)
        .sort((a, b) => area(a) - area(b))[0];
      if (!panel) return {};
      const row = Array.from(panel.querySelectorAll("div, li, section, dl, dd"))
        .filter((element) => {
          const text = normalize(element.textContent);
          return (
            visible(element) &&
            text.includes("年龄") &&
            (/\\d+|不限/.test(text) ||
              Array.from(element.querySelectorAll("*")).some(
                (child) => looksLikeSlider(child) || looksLikeHandle(child),
              ))
          );
        })
        .sort((a, b) => {
          const areaDelta = area(a) - area(b);
          if (areaDelta !== 0) return areaDelta;
          return normalize(a.textContent).length - normalize(b.textContent).length;
        })[0];
      if (!row) return {};
      const dots = Array.from(row.querySelectorAll(".vue-slider-dot"))
        .filter(visible)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const track = preferRailTrack(
        Array.from(row.querySelectorAll(".vue-slider-rail, .vue-slider")).filter(visible)
      )[0];
      if (dots.length >= 2) {
        const minDot = dots[0];
        const maxDot = dots[dots.length - 1];
        const minText = normalize(minDot?.querySelector(".vue-slider-dot-tooltip-text")?.textContent);
        const maxText = normalize(maxDot?.querySelector(".vue-slider-dot-tooltip-text")?.textContent);
        const rowText = normalize(row.textContent);
        const rowState = parseAgeState(rowText);
        const minRatio = track && minDot ? readRatio(minDot, track) : undefined;
        const maxRatio = track && maxDot ? readRatio(maxDot, track) : undefined;
        const ageMin =
          parseAgeValue(minText) ??
          rowState.ageMin ??
          (minRatio !== undefined ? ratioToAge(minRatio) : undefined);
        let ageMax = parseAgeValue(maxText) ?? rowState.ageMax;
        if (
          ageMax === undefined &&
          !maxText.includes("不限") &&
          !rowText.includes("不限") &&
          maxRatio !== undefined
        ) {
          ageMax = ratioToAge(maxRatio);
        }
        return {
          ...(ageMin !== undefined ? { ageMin } : {}),
          ...(ageMax !== undefined ? { ageMax } : {}),
          ...(minRatio !== undefined ? { minRatio } : {}),
          ...(maxRatio !== undefined ? { maxRatio } : {})
        };
      }
      return parseAgeState(normalize(row.textContent));
    })()`;
    const mainState = toNativeRecommendAgeState(
      await this.evaluateJson(expression).catch(() => undefined),
    );
    if (mainState.ageMin !== undefined || mainState.ageMax !== undefined) {
      return mainState;
    }
    return toNativeRecommendAgeState(await this.evaluateRecommendFrameJson(expression));
  }

  private async resolveNativeAgeSlider(): Promise<NativeAgeSliderResolution> {
    const expression = `(() => {
      const panelSelector = ${JSON.stringify(ZHIPIN_SELECTORS.recommend.filterPanel)};
      const normalize = (text) => (text ?? "").replace(/\\s+/g, "").trim();
      const parseAgeState = (text) => {
        const normalized = normalize(text);
        const ageText = normalized.includes("年龄")
          ? normalized.slice(normalized.indexOf("年龄") + "年龄".length)
          : normalized;
        const numbers = Array.from(ageText.matchAll(/\\d+/g), (match) =>
          Number.parseInt(match[0], 10)
        ).filter((value) => Number.isInteger(value));
        const ageMin = numbers[0];
        const ageMax = ageText.includes("不限") ? undefined : numbers[1];
        return {
          ...(ageMin !== undefined ? { ageMin } : {}),
          ...(ageMax !== undefined ? { ageMax } : {})
        };
      };
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const area = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const classText = (element) =>
        typeof element.className === "string" ? element.className : "";
      const preferRailTrack = (elements) =>
        [...elements].sort((a, b) => {
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
      const looksLikeSlider = (element) => {
        const classes = classText(element);
        const role = element.getAttribute("role") ?? "";
        return /slider|range|track|bar/i.test(classes) || role === "slider";
      };
      const looksLikeHandle = (element) => {
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
      const panel = Array.from(document.querySelectorAll(panelSelector))
        .filter(visible)
        .sort((a, b) => area(a) - area(b))[0];
      if (!panel) return { ok: false, error: "未找到筛选面板" };
      const row = Array.from(panel.querySelectorAll("div, li, section, dl, dd"))
        .filter((element) => {
          const text = normalize(element.textContent);
          return (
            visible(element) &&
            text.includes("年龄") &&
            Array.from(element.querySelectorAll("*")).some(
              (child) => looksLikeSlider(child) || looksLikeHandle(child)
            )
          );
        })
        .sort((a, b) => {
          const areaDelta = area(a) - area(b);
          if (areaDelta !== 0) return areaDelta;
          return normalize(a.textContent).length - normalize(b.textContent).length;
        })[0];
      if (!row) return { ok: false, error: "未找到年龄滑块" };

      const vueSliderDots = Array.from(row.querySelectorAll(".vue-slider-dot"))
        .filter(visible)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const fallbackHandles = Array.from(row.querySelectorAll("*"))
        .filter((element) => visible(element) && looksLikeHandle(element))
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const handles = vueSliderDots.length >= 2 ? vueSliderDots : fallbackHandles;
      if (handles.length < 2) {
        return { ok: false, error: "未找到年龄滑块双手柄" };
      }

      const minHandle = handles[0];
      const maxHandle = handles[handles.length - 1];
      const minRect = minHandle.getBoundingClientRect();
      const maxRect = maxHandle.getBoundingClientRect();
      const minDistance = Math.max(40, maxRect.left - minRect.left);
      const tracks = [
        ...preferRailTrack(Array.from(row.querySelectorAll(".vue-slider-rail, .vue-slider"))),
        ...Array.from(row.querySelectorAll("*")).filter(looksLikeSlider)
      ]
        .filter((element, index, array) => array.indexOf(element) === index)
        .filter((element) => {
          if (!visible(element)) return false;
          const rect = element.getBoundingClientRect();
          return (
            rect.width >= Math.max(80, minDistance) &&
            rect.height <= 100 &&
            rect.left <= minRect.left + minRect.width &&
            rect.right >= maxRect.right - maxRect.width
          );
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
      const track = tracks[0];
      if (!track) return { ok: false, error: "未找到年龄滑块轨道" };
      const trackRect = track.getBoundingClientRect();
      return {
        ok: true,
        current: parseAgeState(normalize(row.textContent)),
        trackLeft: trackRect.left,
        trackTop: trackRect.top,
        trackWidth: trackRect.width,
        trackHeight: trackRect.height,
        minHandleX: Math.round(minRect.left + minRect.width / 2),
        minHandleY: Math.round(minRect.top + minRect.height / 2),
        maxHandleX: Math.round(maxRect.left + maxRect.width / 2),
        maxHandleY: Math.round(maxRect.top + maxRect.height / 2)
      };
    })()`;

    const main = toNativeAgeSliderResolution(
      await this.evaluateJson(expression).catch(() => undefined),
    );
    if (main.ok) {
      return main;
    }

    const frame = toNativeAgeSliderResolution(await this.evaluateRecommendFrameJson(expression));
    if (!frame.ok) {
      return frame;
    }

    const offset = await this.readRecommendFrameOffset();
    if (!offset.found) {
      return frame;
    }

    return {
      ...frame,
      trackLeft: frame.trackLeft + offset.left,
      trackTop: frame.trackTop + offset.top,
      minHandleX: frame.minHandleX + offset.left,
      minHandleY: frame.minHandleY + offset.top,
      maxHandleX: frame.maxHandleX + offset.left,
      maxHandleY: frame.maxHandleY + offset.top,
    };
  }

  private async dispatchNativeDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    options: NativeClickOptions = {},
  ): Promise<void> {
    await this.mouse.drag(
      { x: fromX, y: fromY },
      { x: toX, y: toY },
      {
        ...(options.motionObserver !== undefined ? { motionObserver: options.motionObserver } : {}),
        pressDurationMs: options.pressDurationMs ?? NATIVE_CLICK_PRESS_MS,
      },
    );
  }

  private async dragAgeHandleToRatio(
    handle: "min" | "max",
    ratio: number,
    options: NativeClickOptions,
  ): Promise<boolean> {
    const slider = await this.resolveNativeAgeSlider();
    if (!slider.ok || slider.trackWidth <= 0) {
      return false;
    }

    const fromX = handle === "min" ? slider.minHandleX : slider.maxHandleX;
    const fromY = handle === "min" ? slider.minHandleY : slider.maxHandleY;
    const toX = slider.trackLeft + Math.max(0, Math.min(1, ratio)) * slider.trackWidth;
    const toY = slider.trackTop + Math.max(1, slider.trackHeight / 2);
    await this.dispatchNativeDrag(fromX, fromY, toX, toY, options);
    await delay(NATIVE_AGE_DRAG_SETTLE_MS);
    return true;
  }

  private estimateAgeRatio(age: number): number {
    return Math.max(
      0,
      Math.min(
        1,
        (age - NATIVE_DEFAULT_AGE_MIN) /
          (NATIVE_AGE_SLIDER_NUMERIC_MAX_ESTIMATE - NATIVE_DEFAULT_AGE_MIN),
      ),
    );
  }

  private clampRatio(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private async setAgeHandleToNumber(
    handle: "min" | "max",
    targetAge: number,
    options: NativeClickOptions,
  ): Promise<boolean> {
    const initialState = await this.readNativeAgeState();
    const minRatio = initialState.minRatio ?? 0;
    const maxRatio = initialState.maxRatio ?? 1;
    let low = handle === "min" ? 0 : Math.min(1, minRatio + NATIVE_AGE_HANDLE_MIN_GAP_RATIO);
    let high = handle === "min" ? Math.max(0, maxRatio - NATIVE_AGE_HANDLE_MIN_GAP_RATIO) : 1;
    let ratio = this.clampRatio(this.estimateAgeRatio(targetAge), low, high);

    for (let attempt = 0; attempt < NATIVE_AGE_DRAG_ATTEMPTS; attempt += 1) {
      if (!(await this.dragAgeHandleToRatio(handle, ratio, options))) {
        return false;
      }

      const state = await this.readNativeAgeState();
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
      ratio = this.clampRatio(nextRatio, low, high);
    }

    const finalState = await this.readNativeAgeState();
    return handle === "min" ? finalState.ageMin === targetAge : finalState.ageMax === targetAge;
  }

  private isDesiredAgeState(
    state: NativeRecommendAgeState,
    desiredMin: number,
    desiredMax: number | undefined,
  ): boolean {
    return state.ageMin === desiredMin && state.ageMax === desiredMax;
  }

  private async setRecommendAgeRange(
    requested: ZhipinRecommendFilterRequest,
    options: NativeClickOptions,
  ): Promise<
    | { readonly success: true; readonly state: NativeRecommendAgeState }
    | { readonly success: false; readonly error: string }
  > {
    const desiredMin = requested.ageMin ?? NATIVE_DEFAULT_AGE_MIN;
    const desiredMax = requested.ageMax;
    const resolution = await this.resolveNativeAgeSlider();
    if (!resolution.ok) {
      return { success: false, error: resolution.error };
    }

    if (!(await this.dragAgeHandleToRatio("max", 1, options))) {
      return { success: false, error: "年龄上限无法重置为不限" };
    }

    if (!(await this.setAgeHandleToNumber("min", desiredMin, options))) {
      return { success: false, error: `年龄下限无法设置为 ${desiredMin}` };
    }

    if (desiredMax === undefined) {
      const stateAfterMin = await this.readNativeAgeState();
      if (
        stateAfterMin.ageMax !== undefined &&
        !(await this.dragAgeHandleToRatio("max", 1, options))
      ) {
        return { success: false, error: "年龄上限无法设置为不限" };
      }
    } else if (!(await this.setAgeHandleToNumber("max", desiredMax, options))) {
      return { success: false, error: `年龄上限无法设置为 ${desiredMax}` };
    }

    const finalState = await this.readNativeAgeState();
    if (!this.isDesiredAgeState(finalState, desiredMin, desiredMax)) {
      const actualMax = finalState.ageMax === undefined ? "不限" : String(finalState.ageMax);
      return {
        success: false,
        error: `年龄筛选未精确生效，当前为 ${finalState.ageMin ?? "未知"}-${actualMax}`,
      };
    }

    return { success: true, state: finalState };
  }

  private async readSelectedRecommendOptionText(
    rowLabel: string,
    fallback: string,
  ): Promise<string> {
    const expression = `(() => {
      const panelSelector = ${JSON.stringify(ZHIPIN_SELECTORS.recommend.filterPanel)};
      const rowLabel = ${JSON.stringify(rowLabel)};
      const fallback = ${JSON.stringify(fallback)};
      const clickableSelector = ${JSON.stringify(NATIVE_CLICKABLE_OPTION_SELECTOR)};
      const selectedClassPattern = /active|selected|checked|current|choose|chosen/i;
      const normalize = (text) => (text ?? "").replace(/\\s+/g, "").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const area = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const isSelected = (element) => {
        const classes = typeof element.className === "string" ? element.className : "";
        return (
          selectedClassPattern.test(classes) ||
          element.getAttribute("aria-checked") === "true" ||
          element.getAttribute("aria-selected") === "true"
        );
      };
      const panel = Array.from(document.querySelectorAll(panelSelector))
        .filter(visible)
        .sort((a, b) => area(a) - area(b))[0];
      if (!panel) return fallback;
      const row = Array.from(panel.querySelectorAll("div, li, dl, dd, section, ul"))
        .filter((element) => visible(element) && normalize(element.textContent).includes(rowLabel))
        .sort((a, b) => {
          const areaDelta = area(a) - area(b);
          if (areaDelta !== 0) return areaDelta;
          return normalize(a.textContent).length - normalize(b.textContent).length;
        })[0];
      if (!row) return fallback;
      const selected = Array.from(row.querySelectorAll(clickableSelector))
        .filter((element) => visible(element) && isSelected(element))
        .map((element) => normalize(element.textContent))
        .find((text) => text !== "" && text !== rowLabel);
      return selected ?? fallback;
    })()`;
    const mainValue = await this.evaluateJson<string>(expression).catch(() => "");
    if (mainValue.length > 0 && mainValue !== fallback) {
      return mainValue;
    }
    const frameValue = await this.evaluateRecommendFrameJson<string>(expression);
    return typeof frameValue === "string" && frameValue.length > 0 ? frameValue : fallback;
  }

  private async readNativeAppliedFilterState(
    requested: ZhipinRecommendFilterRequest,
    ageState: NativeRecommendAgeState,
  ): Promise<ZhipinRecommendFilterApplied> {
    return {
      ...(ageState.ageMin !== undefined ? { ageMin: ageState.ageMin } : {}),
      ...(ageState.ageMax !== undefined ? { ageMax: ageState.ageMax } : {}),
      gender: await this.readSelectedRecommendOptionText("性别", requested.gender),
      activity: await this.readSelectedRecommendOptionText("活跃度", requested.activity),
    };
  }

  private async clickRecommendFilterSubmit(options: NativeClickOptions): Promise<boolean> {
    const target = await this.resolveRecommendClickTarget(
      `(() => {
        const panelSelector = ${JSON.stringify(ZHIPIN_SELECTORS.recommend.filterPanel)};
        const normalize = (text) => (text ?? "").replace(/\\s+/g, "").trim();
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const panel = Array.from(document.querySelectorAll(panelSelector)).filter(visible)[0];
        if (!panel) return { found: false, x: 0, y: 0 };
        const button = Array.from(
          panel.querySelectorAll("button, a, span, div, [role='button']")
        )
          .filter(visible)
          .find((element) => normalize(element.textContent) === "确定");
        if (!button) return { found: false, x: 0, y: 0 };
        const rect = button.getBoundingClientRect();
        return {
          found: true,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      })()`,
    );
    if (!(await this.dispatchNativeClick(target, options))) {
      return false;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 4_000) {
      if (!(await this.isRecommendFilterPanelVisible())) {
        await delay(600);
        return true;
      }
      await delay(NATIVE_SELECTOR_POLL_MS);
    }
    return false;
  }

  private async readRecommendFilterButtonText(): Promise<string | undefined> {
    const expression = `(() => {
      const element = document.querySelector(${JSON.stringify(ZHIPIN_SELECTORS.recommend.filterButton)});
      const text = element?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
      return text.length > 0 ? text : null;
    })()`;
    const mainValue = await this.evaluateJson<string | null>(expression).catch(() => null);
    if (typeof mainValue === "string" && mainValue.length > 0) {
      return mainValue;
    }
    const frameValue = await this.evaluateRecommendFrameJson<string | null>(expression);
    return typeof frameValue === "string" && frameValue.length > 0 ? frameValue : undefined;
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

  private async waitForNativeChatReady(
    selected: ChatListItem,
    timeoutMs = 6_000,
  ): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const selectedTarget = await this.readSelectedChatTarget().catch(() => null);
      const activePanel = await this.readActiveChatPanel().catch(() => null);
      const selectedMatches =
        selectedTarget !== null &&
        ((selected.conversationId.length > 0 &&
          selectedTarget.conversationId === selected.conversationId) ||
          (selected.conversationId.length === 0 &&
            selected.candidateId.length > 0 &&
            selectedTarget.candidateId === selected.candidateId));
      const panelMatches =
        selected.name.length === 0 ||
        (activePanel !== null && namesCompatible(selected.name, activePanel.candidateName));

      if (selectedMatches && panelMatches) {
        return true;
      }
      await delay(NATIVE_SELECTOR_POLL_MS);
    }

    return false;
  }

  private async clickChatCandidate(
    candidate: ChatListItem,
    options: NativeClickOptions = {},
  ): Promise<boolean> {
    const target = toNativeClickTarget(
      await this.evaluateJson(
        `(() => {
          const expected = ${JSON.stringify({
            conversationId: candidate.conversationId,
            candidateId: candidate.candidateId,
            index: candidate.index,
          })};
          const items = Array.from(document.querySelectorAll(${JSON.stringify(CHAT_ITEM_SELECTOR)}));
          const readCandidate = (item, idx) => {
            const conversationId =
              item.getAttribute("data-id") ??
              item.closest('[role="listitem"]')?.getAttribute("key") ??
              "";
            const candidateId =
              item.getAttribute("data-geek") ??
              item.querySelector("[data-geek]")?.getAttribute("data-geek") ??
              conversationId;
            return { item, idx, conversationId, candidateId };
          };

          const candidates = items.map(readCandidate);
          const matched =
            candidates.find((entry) =>
              expected.conversationId.length > 0 &&
              entry.conversationId === expected.conversationId
            ) ??
            candidates.find((entry) =>
              expected.candidateId.length > 0 &&
              entry.candidateId === expected.candidateId
            ) ??
            candidates.find((entry) => entry.idx === expected.index);

          if (!matched) {
            return { found: false, x: 0, y: 0 };
          }

          matched.item.scrollIntoView({ block: "center", inline: "center" });
          const rect = matched.item.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return { found: false, x: 0, y: 0 };
          }

          return {
            found: true,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        })()`,
      ),
    );

    if (!target.found) {
      return false;
    }

    return await this.dispatchNativeClick(target, options);
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

    await this.mouse.moveTo(toNativeMousePoint(target));
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
