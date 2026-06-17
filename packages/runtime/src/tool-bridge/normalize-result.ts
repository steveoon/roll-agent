import { extractTextContent, isToolErrorResult } from "@roll-agent/core/cli/utils/tool-results";

export interface NormalizedToolResult {
  readonly output: unknown;
  readonly isError: boolean;
}

function getContent(result: unknown): unknown {
  return typeof result === "object" && result !== null && "content" in result
    ? (result as { readonly content: unknown }).content
    : undefined;
}

export function normalizeToolResult(result: unknown): NormalizedToolResult {
  const isError = isToolErrorResult(result);
  const texts = extractTextContent(getContent(result));
  const output = texts.length > 0 ? texts.join("\n") : result;
  return { output, isError };
}

export function readIsError(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "isError" in output &&
    (output as { readonly isError: unknown }).isError === true
  );
}
