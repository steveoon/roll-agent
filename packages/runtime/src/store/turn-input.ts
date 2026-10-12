import { z } from "zod";
import type { ModelMessage } from "ai";
import {
  SKILL_INVOCATION_PARSE_KINDS,
  parseSkillInvocationResult,
} from "@roll-agent/core/skills/invocation";
import { explicitSkillCheckpointV1Schema } from "../engine/explicit-skill-context.ts";

/** A receipt is an internal persistence identity, not permission to replay a turn. */
export const turnInputIdSchema = z.string().min(1).max(128);
export const turnInputSkillCheckpointSchema = explicitSkillCheckpointV1Schema
  .unwrap()
  .extend({
    snapshot: explicitSkillCheckpointV1Schema
      .unwrap()
      .shape.snapshot.unwrap()
      .pick({ skillNames: true, skills: true })
      .readonly(),
  })
  .readonly();
export type TurnInputSkillCheckpoint = z.infer<typeof turnInputSkillCheckpointSchema>;

export const acceptedTurnInputSchema = z
  .object({
    inputId: turnInputIdSchema,
    transcriptSequence: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    skillCheckpoint: turnInputSkillCheckpointSchema.optional(),
  })
  .readonly();
export type AcceptedTurnInput = z.infer<typeof acceptedTurnInputSchema>;

/** A transient evidence projection only. Never rewrite raw transcript or load Skill bodies. */
export function projectTurnInputSkillCheckpoint(
  message: ModelMessage,
  checkpoint: TurnInputSkillCheckpoint | undefined,
): ModelMessage {
  if (checkpoint === undefined || message.role !== "user") return message;
  const rawInput =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  const parsed = parseSkillInvocationResult(
    rawInput,
    checkpoint.snapshot.skillNames.map((name) => ({
      name,
      description: "",
      source: "project" as const,
    })),
  );
  const userPrompt =
    parsed.kind === SKILL_INVOCATION_PARSE_KINDS.valid ? parsed.invocation.prompt : rawInput;
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      rollHarness: {
        ...message.providerOptions?.rollHarness,
        explicitSkillCheckpoint: {
          ...checkpoint,
          snapshot: { ...checkpoint.snapshot, userPrompt },
        },
      },
    },
  };
}
