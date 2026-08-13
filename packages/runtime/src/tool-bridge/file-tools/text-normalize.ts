const CHAR_FOLD: Readonly<Record<string, string>> = {
  " ": " ",
  "　": " ",
  "\u{201C}": '"',
  "\u{201D}": '"',
  "\u{2018}": "'",
  "\u{2019}": "'",
  "—": "-",
  "–": "-",
  "―": "-",
  "，": ",",
  "：": ":",
  "；": ";",
  "！": "!",
  "？": "?",
  "（": "(",
  "）": ")",
  "．": ".",
};

export interface NormalizedText {
  readonly text: string;
  readonly map: readonly number[];
}

export function normalizeForMatch(input: string): NormalizedText {
  let text = "";
  const map: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const char = input.charAt(index);
    if (char === "\r") {
      continue;
    }
    text += CHAR_FOLD[char] ?? char;
    map.push(index);
  }
  return { text, map };
}
