import type { LlmModelChoice, LlmModelChoiceOrigin } from "../../llm/model-choices.ts";
import type { SessionPickerItem } from "./session-picker-format.ts";

const ORIGIN_LABELS: Record<LlmModelChoiceOrigin, string> = {
  default: "配置默认",
  configured: "已配置",
  builtin: "内置默认",
};

export const DEFAULT_CHOICE_ITEMS: readonly SessionPickerItem[] = [
  { id: "keep", title: "仅本次 roll chat 生效", meta: "新开的 roll chat 仍用配置默认" },
  { id: "set-default", title: "同时设为默认 LLM", meta: "写入 roll.config.yaml" },
];

export function buildModelPickerItems(
  choices: readonly LlmModelChoice[],
  currentModel: string,
): readonly SessionPickerItem[] {
  return choices.map((choice) => ({
    id: choice.id,
    title: choice.id,
    meta:
      choice.model === currentModel
        ? `${ORIGIN_LABELS[choice.origin]} · 当前`
        : ORIGIN_LABELS[choice.origin],
  }));
}
