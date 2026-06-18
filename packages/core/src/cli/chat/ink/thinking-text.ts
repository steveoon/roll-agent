import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Text } from "ink";

export interface TextSegment {
  readonly text: string;
  readonly thinking: boolean;
}

export function parseThinking(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const regex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), thinking: false });
    }
    segments.push({ text: match[1] ?? "", thinking: true });
    lastIndex = regex.lastIndex;
    match = regex.exec(text);
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), thinking: false });
  }
  return segments.filter((segment) => segment.text.length > 0);
}

export function ThinkingText({ text }: { text: string }): ReactElement {
  const segments = parseThinking(text);
  if (segments.length === 0) {
    return h(Text, null, "");
  }
  return h(
    Text,
    null,
    ...segments.map((segment, index) =>
      h(
        Text,
        { key: String(index), ...(segment.thinking ? { dimColor: true } : {}) },
        segment.text,
      ),
    ),
  );
}
