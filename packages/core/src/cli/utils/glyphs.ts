import isUnicodeSupported from "is-unicode-supported";

const unicode = isUnicodeSupported();

export const GLYPHS = unicode
  ? ({
      think: "🧠",
      auto: "⏵⏵",
      compact: "🗜",
      attach: "📎",
      fast: "⚡",
      info: "·",
      warning: "⚠",
    } as const)
  : ({
      think: "think",
      auto: ">>",
      compact: "*",
      attach: "+",
      fast: ">>",
      info: "i",
      warning: "!",
    } as const);
