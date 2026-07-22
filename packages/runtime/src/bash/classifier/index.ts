import type {
  CommandClassification,
  CommandClassifier,
} from "../../types/command-classification.ts";
import { classifyScript } from "./compound.ts";

export const ruleBasedClassifier: CommandClassifier = {
  classify(command: string, workdir: string): CommandClassification {
    const platform = process.platform;
    return classifyScript(command, platform, workdir);
  },
};
