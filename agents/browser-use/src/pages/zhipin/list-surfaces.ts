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
      ".chat-user .user-container",
      ".chat-user .b-scroll-stable",
      ".chat-list-wrap",
      ".chat-user",
    ],
    itemSelector: ".geek-item",
    highlightSelector: ".chat-user .user-container, .chat-list-wrap, .chat-user",
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
      ".recommend-list-wrap",
      ".recommend-list",
      ".candidate-list",
      ".geek-list",
      ".list-wrap",
      ".recommendV2",
    ],
    itemSelector: ".candidate-card-wrap, [data-geek], .geek-item",
    highlightSelector: ".candidate-card-wrap, [data-geek], .geek-item",
  },
} as const satisfies Record<ZhipinListSurface, ZhipinListSurfaceConfig>;

export function getZhipinListSurfaceConfig(surface: ZhipinListSurface): ZhipinListSurfaceConfig {
  return ZHIPIN_LIST_SURFACES[surface];
}
