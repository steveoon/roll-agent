import type {
  CommandClassification,
  CommandClassifier,
} from "../../types/command-classification.ts";
import { classifyScript } from "./compound.ts";
import { executableLookupKey } from "./lookup-key.ts";
import { tokenizeScript } from "./tokenize.ts";

const SHELL_KEYS: ReadonlySet<string> = new Set(["bash", "sh", "zsh"]);
const SHELL_COMMAND_FLAGS: ReadonlySet<string> = new Set(["-c", "-lc", "-lic"]);

export function unwrapShellWrapper(command: string, platform: NodeJS.Platform): string {
  const lexemes = tokenizeScript(command);
  if (lexemes === null || lexemes.length !== 3) {
    return command;
  }
  const [shell, flag, script] = lexemes;
  if (
    shell?.kind === "word" &&
    flag?.kind === "word" &&
    script?.kind === "word" &&
    SHELL_KEYS.has(executableLookupKey(shell.value, platform)) &&
    SHELL_COMMAND_FLAGS.has(flag.value)
  ) {
    return script.value;
  }
  return command;
}

export const ruleBasedClassifier: CommandClassifier = {
  classify(command: string): CommandClassification {
    const platform = process.platform;
    return classifyScript(unwrapShellWrapper(command, platform), platform);
  },
};
