export interface WordLexeme {
  readonly kind: "word";
  readonly value: string;
}

export interface OperatorLexeme {
  readonly kind: "op";
  readonly value: "&&" | "||" | ";" | "|";
}

export type Lexeme = WordLexeme | OperatorLexeme;

export function tokenizeScript(script: string): readonly Lexeme[] | null {
  const lexemes: Lexeme[] = [];
  let current = "";
  let hasCurrent = false;
  let index = 0;

  const flush = (): void => {
    if (hasCurrent) {
      lexemes.push({ kind: "word", value: current });
      current = "";
      hasCurrent = false;
    }
  };

  while (index < script.length) {
    const ch = script[index];
    if (ch === "'") {
      const end = script.indexOf("'", index + 1);
      if (end === -1) {
        return null;
      }
      current += script.slice(index + 1, end);
      hasCurrent = true;
      index = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = script.indexOf('"', index + 1);
      if (end === -1) {
        return null;
      }
      current += script.slice(index + 1, end);
      hasCurrent = true;
      index = end + 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      index += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      flush();
      const last = lexemes[lexemes.length - 1];
      if (last !== undefined && last.kind === "word") {
        lexemes.push({ kind: "op", value: ";" });
      }
      index += 1;
      continue;
    }
    if (ch === "&") {
      if (script[index + 1] === "&") {
        flush();
        lexemes.push({ kind: "op", value: "&&" });
        index += 2;
        continue;
      }
      return null;
    }
    if (ch === "|") {
      flush();
      if (script[index + 1] === "|") {
        lexemes.push({ kind: "op", value: "||" });
        index += 2;
      } else {
        lexemes.push({ kind: "op", value: "|" });
        index += 1;
      }
      continue;
    }
    if (ch === ";") {
      flush();
      lexemes.push({ kind: "op", value: ";" });
      index += 1;
      continue;
    }
    current += ch ?? "";
    hasCurrent = true;
    index += 1;
  }

  flush();
  return lexemes;
}
