import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Text } from "ink";

export interface TextSegment {
  readonly text: string;
  readonly thinking: boolean;
}

export function parseThinking(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const lower = text.toLowerCase();
  const firstOpen = lower.indexOf("<think>");
  const firstClose = lower.indexOf("</think>");
  let rest = text;
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) {
    segments.push({ text: text.slice(0, firstClose), thinking: true });
    rest = text.slice(firstClose + "</think>".length);
  }
  const regex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(rest);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: rest.slice(lastIndex, match.index), thinking: false });
    }
    segments.push({ text: match[1] ?? "", thinking: true });
    lastIndex = regex.lastIndex;
    match = regex.exec(rest);
  }
  if (lastIndex < rest.length) {
    segments.push({ text: rest.slice(lastIndex), thinking: false });
  }
  return segments.filter((segment) => segment.text.length > 0);
}

export function endsInsideThink(text: string, startInside: boolean): boolean {
  let inside = startInside;
  const regex = /<\/?think>/gi;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    inside = !match[0].startsWith("</");
    match = regex.exec(text);
  }
  return inside;
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
