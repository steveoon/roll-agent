import type {
  DynamicListScrollConfig,
  ScrollDirection,
} from "../shared/dynamic-list-scroller.ts";

export const ZHIPIN_LIST_SURFACE_VALUES = [
  "chat-list",
  "chat-history",
  "recommend-list",
] as const;

export type ZhipinListSurface = (typeof ZHIPIN_LIST_SURFACE_VALUES)[number];

export type ZhipinListSurfaceConfig = DynamicListScrollConfig & {
  readonly surface: ZhipinListSurface;
  readonly defaultDirection: ScrollDirection;
  readonly highlightSelector: string;
};

const ZHIPIN_LIST_SURFACES = {
  "chat-list": {
    surface: "chat-list",
    defaultDirection: "down",
    containerSelectors: [
      ".user-list.b-scroll-stable",
      ".chat-user .user-list",
      ".chat-user-list",
      ".chat-list-wrapper",
      ".chat-list-wrap",
      ".chat-user .b-scroll-stable",
      ".b-scroll-stable",
      ".chat-user .user-container",
      ".chat-user",
    ],
    itemSelector: ".user-list.b-scroll-stable [role=\"listitem\"], .geek-item",
    highlightSelector: ".user-list.b-scroll-stable, .chat-user .user-container, .chat-user",
  },
  "chat-history": {
    surface: "chat-history",
    defaultDirection: "up",
    containerSelectors: [
      ".conversation-message",
      ".chat-message-list",
      ".conversation-main",
      ".conversation-box",
    ],
    itemSelector: ".chat-message-list > .message-item, .conversation-message .message-item",
    highlightSelector: ".conversation-message, .chat-message-list, .conversation-main",
  },
  "recommend-list": {
    surface: "recommend-list",
    defaultDirection: "down",
    containerSelectors: [
      "#recommend-list",
      ".list-wrap.card-list-wrap",
      ".card-list-wrap",
      ".recommend-list-wrap",
      ".recommend-list",
      ".card-list",
      ".candidate-list",
      ".candidate-body",
      ".geek-list",
      ".list-wrap",
      ".recommendV2",
    ],
    itemSelector: ".candidate-card-wrap, li.card-item, .geek-item",
    highlightSelector: ".candidate-card-wrap, li.card-item, .geek-item",
  },
} as const satisfies Record<ZhipinListSurface, ZhipinListSurfaceConfig>;

export function getZhipinListSurfaceConfig(surface: ZhipinListSurface): ZhipinListSurfaceConfig {
  return ZHIPIN_LIST_SURFACES[surface];
}
