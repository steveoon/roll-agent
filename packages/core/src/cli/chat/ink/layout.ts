export interface ChatLayout {
  readonly columns: number;
  readonly rows: number;
  readonly renderRows: number;
  readonly contentWidth: number;
  readonly promptRows: number;
  readonly popupRows: number;
  readonly showHelp: boolean;
  readonly tooSmall: boolean;
}

export const MIN_CHAT_COLUMNS = 40;
export const MIN_CHAT_ROWS = 10;

export function resolveChatLayout(columns: number, rows: number): ChatLayout {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeRows = Math.max(1, Math.floor(rows));
  // Leave the physical bottom row untouched. Writing into the last cell can make terminals
  // scroll during reflow, and it also makes Ink treat teardown as a full-terminal clear.
  const renderRows = Math.max(1, safeRows - 1);
  const showHelp = renderRows >= 13;
  const promptRows = Math.min(12, Math.max(showHelp ? 4 : 3, Math.floor(renderRows * 0.4)));
  const popupRows = Math.max(3, Math.min(8, renderRows - promptRows - 3));

  return {
    columns: safeColumns,
    rows: safeRows,
    renderRows,
    contentWidth: Math.max(1, safeColumns - 2),
    promptRows,
    popupRows,
    showHelp,
    tooSmall: safeColumns < MIN_CHAT_COLUMNS || safeRows < MIN_CHAT_ROWS,
  };
}
