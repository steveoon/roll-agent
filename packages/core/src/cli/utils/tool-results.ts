import { extractTextContent } from "@roll-agent/runtime/tool-contracts";
export { extractTextContent, isToolErrorResult } from "@roll-agent/runtime/tool-contracts";
export { getCompletedAppOutputStatus } from "@roll-agent/protocol/app-output";

export function formatToolResultForJsonOutput(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    return result;
  }

  const texts = extractTextContent(result.content);
  if (texts.length !== 1) {
    return result;
  }

  const [text] = texts;
  if (text === undefined) {
    return result;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return result;
  }
}
