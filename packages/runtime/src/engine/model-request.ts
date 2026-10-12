import type { ModelMessage, ToolSet } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { materializeCancelledTurnRecoveryMessages } from "./cancelled-turn-recovery.ts";
import { stripTurnCancellationMetadata } from "../types/cancellation.ts";
import {
  applyExplicitSkillContext,
  stripExplicitSkillCheckpoints,
  type ExplicitSkillContextSnapshot,
} from "./explicit-skill-context.ts";
import { relocateToolImagesToUserMessages } from "./relocate-tool-images.ts";
import { requestDigest } from "./request-budget.ts";

export interface SessionModelRequestInput {
  readonly history: readonly ModelMessage[];
  readonly completedMessages?: readonly ModelMessage[];
  readonly explicitSkill: ExplicitSkillContextSnapshot;
  readonly capabilityReminder: string;
  readonly checkpointReminder?: string;
  readonly system: string;
  readonly tools: ToolSet;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly project: (messages: readonly ModelMessage[]) => ModelMessage[];
}
/** The production Roll projection, used for dispatch and predictions. SDK alone resolves schemas. */
export function buildSessionModelRequest(input: SessionModelRequestInput) {
  const clean = stripExplicitSkillCheckpoints(
    stripTurnCancellationMetadata(materializeCancelledTurnRecoveryMessages(input.history)),
  );
  const history =
    input.explicitSkill.skillNames.length > 0
      ? applyExplicitSkillContext(clean, input.explicitSkill)
      : clean;
  const reminder = input.checkpointReminder
    ? `${input.capabilityReminder}\n\n${input.checkpointReminder}`
    : input.capabilityReminder;
  const messages = [...history];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    messages[i] = {
      ...message,
      content:
        typeof message.content === "string"
          ? `${reminder}\n\n${message.content}`
          : [{ type: "text", text: reminder }, ...message.content],
    };
    break;
  }
  return {
    system: input.system,
    tools: input.tools,
    messages: relocateToolImagesToUserMessages(
      input.project([...messages, ...(input.completedMessages ?? [])]),
    ),
    ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
    shapeContext: requestDigest({
      system: input.system,
      reminder,
      skill: {
        names: input.explicitSkill.skillNames,
        references: input.explicitSkill.skillReferences,
        context:
          input.explicitSkill.skillNames.length === 0
            ? undefined
            : input.explicitSkill.modelUserContent.endsWith(input.explicitSkill.userPrompt)
              ? input.explicitSkill.modelUserContent.slice(
                  0,
                  input.explicitSkill.modelUserContent.length -
                    input.explicitSkill.userPrompt.length,
                )
              : input.explicitSkill.modelUserContent,
      },
      providerOptions: input.providerOptions,
    }),
  };
}
