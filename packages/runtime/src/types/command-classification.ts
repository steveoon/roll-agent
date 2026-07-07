import type { ToolAnnotations } from "./policy.ts";

export const COMMAND_CLASSIFICATIONS = ["known-safe", "dangerous", "unknown"] as const;
export type CommandClassification = (typeof COMMAND_CLASSIFICATIONS)[number];

export interface CommandClassifier {
  classify(command: string, workdir: string): CommandClassification;
}

export const unknownCommandClassifier: CommandClassifier = {
  classify: () => "unknown",
};

export const CLASSIFICATION_ANNOTATIONS: Record<CommandClassification, ToolAnnotations> = {
  "known-safe": { readOnlyHint: true },
  dangerous: { destructiveHint: true },
  unknown: { destructiveHint: true },
};
