export interface TruncationResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly removed: number;
}

export function truncateMiddle(text: string, maxChars: number): TruncationResult {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return { text, truncated: false, removed: 0 };
  }
  if (maxChars <= 0) {
    return { text: "", truncated: true, removed: chars.length };
  }
  const headLen = Math.ceil(maxChars / 2);
  const tailLen = Math.floor(maxChars / 2);
  const removed = chars.length - headLen - tailLen;
  const head = chars.slice(0, headLen).join("");
  const tail = chars.slice(chars.length - tailLen).join("");
  return {
    text: `${head}\n…${String(removed)} chars truncated（保留前 ${String(headLen)} 与后 ${String(tailLen)} 字符，全文 ${String(chars.length)} 字符）…\n${tail}`,
    truncated: true,
    removed,
  };
}
