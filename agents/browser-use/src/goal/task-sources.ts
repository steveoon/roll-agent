import type { BrowserOperateInput, ResolvedTaskValue } from "./contracts.ts";

/** Caller data only. These are candidates, not inferred facts or field bindings. */
export function taskSources(input: BrowserOperateInput) {
  const values: Record<string, ResolvedTaskValue & { name: string }> = {};
  for (const [index, value] of input.values.entries()) {
    values[`v${index + 1}`] = {
      ...value,
      source: "supplied",
      sourceIds: [`v${index + 1}`],
      evidence: "Caller supplied value",
    };
  }
  const seen = new Set(input.values.map((value) => value.text));
  let truncated = false;
  const add = (text: string) => {
    const literal = text.trim();
    if (!literal || literal.length > 8000 || seen.has(literal)) return;
    if (Object.keys(values).length >= 192) {
      truncated = true;
      return;
    }
    seen.add(literal);
    values[`g${Object.keys(values).length + 1}`] = {
      name: "Original goal span",
      text: literal,
      source: "derived",
      sourceIds: [],
      evidence: literal,
    };
  };
  // Preserve quoted phrases and line/colon payloads before adding smaller candidates.
  // No site-specific field parsing and no page content can enter this pool.
  for (const match of input.goal.matchAll(/[“"「]([^”"」]+)[”"」]/gu)) add(match[1]!);
  for (const line of input.goal.split(/\r?\n/u)) {
    add(line);
    for (const match of line.matchAll(/[:：]([^\n]+)/gu)) add(match[1]!);
  }
  for (const clause of input.goal.split(/[。；;\n]/u)) {
    add(clause);
    const colon = clause.search(/[:：]/u);
    if (colon >= 0) add(clause.slice(colon + 1));
  }
  for (const match of input.goal.matchAll(
    /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|[+-]?\d+(?:[.,]\d+)*(?:[kK万千元%])?/gu,
  )) {
    add(match[0]);
  }
  return { values, truncated };
}
