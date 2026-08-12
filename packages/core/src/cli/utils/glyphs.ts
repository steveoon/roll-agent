import isUnicodeSupported from "is-unicode-supported";

const unicode = isUnicodeSupported();

export const GLYPHS = unicode
  ? ({ think: "🧠", auto: "⏵⏵", compact: "🗜", attach: "📎" } as const)
  : ({ think: "think", auto: ">>", compact: "*", attach: "+" } as const);
