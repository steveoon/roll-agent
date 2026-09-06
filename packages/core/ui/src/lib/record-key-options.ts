import type { ConfigRecordKeyOption } from "../types.ts";

export function availableRecordKeyOptions(
  keyOptions: readonly ConfigRecordKeyOption[],
  existingKeys: readonly string[],
): readonly ConfigRecordKeyOption[] {
  const existing = new Set(existingKeys);
  return keyOptions.filter((option) => !existing.has(option.value));
}

export function formatRecordKeyOption(option: ConfigRecordKeyOption): string {
  const base = `${option.value} — ${option.label}`;
  return option.hint === undefined ? base : `${base}（${option.hint}）`;
}
