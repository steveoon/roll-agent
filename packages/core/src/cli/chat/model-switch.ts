import type { EngineModelSwitch } from "@roll-agent/runtime";
import { withChatGptFastMode } from "../../llm/chatgpt-fast-mode.ts";

/** Keep async resolution separate from the synchronous Engine/host-state commit. */
export async function resolveAndSwitchChatModel<T>(options: {
  resolve(): Promise<EngineModelSwitch>;
  getFastMode(): boolean;
  commit(selection: EngineModelSwitch): T;
}): Promise<T> {
  const selection = await options.resolve();
  if (selection.provider !== "chatgpt") return options.commit(selection);

  // Resolution can overlap a Fast change. Rebase both option sets immediately before
  // committing, with no await between the preference read and the Engine/host update.
  const enabled = options.getFastMode();
  return options.commit({
    ...selection,
    providerOptions: withChatGptFastMode(selection.providerOptions, enabled),
    structuredOutputProviderOptions: withChatGptFastMode(
      selection.structuredOutputProviderOptions,
      enabled,
    ),
  });
}
