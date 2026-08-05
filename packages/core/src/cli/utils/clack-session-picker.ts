import { isCancel, select } from "@clack/prompts";
import type { SessionPickerItem } from "../chat/session-picker-format.ts";

export async function clackSessionPicker(
  items: readonly SessionPickerItem[],
): Promise<string | undefined> {
  const answer = await select<string>({
    message: "切换会话",
    options: items.map((item) => ({ value: item.id, label: item.title, hint: item.meta })),
  });
  return isCancel(answer) ? undefined : answer;
}
