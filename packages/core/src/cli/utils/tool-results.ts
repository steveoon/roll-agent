export function extractTextContent(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const texts: string[] = [];
  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
    ) {
      texts.push(item.text);
    }
  }
  return texts;
}

export function isToolErrorResult(
  result: unknown,
): result is { readonly isError: true; readonly content?: unknown } {
  return (
    typeof result === "object" && result !== null && "isError" in result && result.isError === true
  );
}
