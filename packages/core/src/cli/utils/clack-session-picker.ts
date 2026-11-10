import { isCancel, select } from "@clack/prompts";
import {
  sessionPickerGroups,
  type SessionPickerItem,
  type SessionPickerSelection,
} from "../chat/session-picker-format.ts";

export async function clackSessionPicker(
  items: readonly SessionPickerItem[],
): Promise<SessionPickerSelection | undefined> {
  const groups = sessionPickerGroups(items);
  const initial = items.find((item) => item.isCurrent) ?? items[0];
  const option = (item: SessionPickerItem) => ({
    value: item,
    label: item.isCurrent ? `[当前打开] ${item.title}` : item.title,
    hint: item.meta,
  });
  const answer = await select<SessionPickerItem | null>({
    message: "对话历史",
    ...(initial === undefined ? {} : { initialValue: initial }),
    options:
      groups.length === 0
        ? items.map(option)
        : groups.flatMap((group) => {
            const entries = items.filter((item) => item.group === group);
            return [
              {
                value: null,
                label: `── ${group}（${String(entries.length)}）──`,
                disabled: true,
              },
              ...entries.map(option),
            ];
          }),
  });
  if (isCancel(answer) || answer === null) return undefined;
  if (!answer.canAssignToProject) return { threadId: answer.id };
  const assign = await select<boolean>({
    message: `旧会话：${answer.title}`,
    options: [
      {
        value: false,
        label: answer.isCurrent ? "返回当前对话" : "继续会话",
        hint: "保留为无项目归属的旧会话",
      },
      {
        value: true,
        label: answer.isCurrent ? "归入本项目" : "归入本项目并继续",
        hint: "保留原会话与全部历史",
      },
    ],
  });
  return isCancel(assign) ? undefined : { threadId: answer.id, assignToCurrentProject: assign };
}
