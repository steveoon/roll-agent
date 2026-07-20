export const INPUT_HISTORY_LIMIT = 50;

export function appendInputHistory(history: readonly string[], raw: string): readonly string[] {
  const text = raw.trim();
  if (text.length === 0) {
    return history;
  }
  const withoutDuplicate = history.filter((entry) => entry !== text);
  return [...withoutDuplicate.slice(-(INPUT_HISTORY_LIMIT - 1)), text];
}
