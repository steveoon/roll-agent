export const DIFF_DISPLAY_MODES = ["collapsed", "expanded"] as const;
export type DiffDisplayMode = (typeof DIFF_DISPLAY_MODES)[number];
export const DIFF_INLINE_MAX_LINES = 40;

export function shouldExpandDiff(bodyLineCount: number, mode: DiffDisplayMode): boolean {
  return mode === "expanded" || bodyLineCount <= DIFF_INLINE_MAX_LINES;
}

export function resolveDiffDisplayToggle(arg: string, current: DiffDisplayMode): DiffDisplayMode {
  const lowered = arg.trim().toLowerCase();
  if (lowered === "on" || lowered === "expanded") {
    return "expanded";
  }
  if (lowered === "off" || lowered === "collapsed") {
    return "collapsed";
  }
  return current === "collapsed" ? "expanded" : "collapsed";
}

export function diffDisplayNotice(mode: DiffDisplayMode): string {
  return mode === "expanded"
    ? "文件变更 diff 将完整显示（仅当前会话生效）"
    : `超过 ${String(DIFF_INLINE_MAX_LINES)} 行的 diff 将折叠为一行摘要，/diff on 可展开（仅当前会话生效）`;
}
