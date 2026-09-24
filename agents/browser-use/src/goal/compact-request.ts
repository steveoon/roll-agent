import { z } from "zod";
import type { DecisionRequest } from "./decisions.ts";

const previewKeys = new Set([
  "name",
  "text",
  "displayText",
  "committedText",
  "queryText",
  "value",
  "optionText",
  "target",
  "label",
  "fieldLabel",
  "initial",
  "expected",
  "current",
  "before",
  "after",
]);
const emptyKeys = new Set([
  "context",
  "sourceValueMatches",
  "writtenValueMatches",
  "coverageWarnings",
  "resolvedValues",
  "recentActions",
  "delegatedDecisions",
]);

export const TASK_PREVIEW_TARGET_BYTES = 48000;
// Local resource ceiling, deliberately NOT a model token-limit approximation.
export const MAX_TASK_REQUEST_BYTES = 128000;

/** A conservative wire budget, not a tokenizer estimate. Execution keeps the full input/snapshot. */
export function compactTaskRequest(
  request: DecisionRequest,
  maxBytes = MAX_TASK_REQUEST_BYTES,
): DecisionRequest {
  const original = z.record(z.unknown()).parse(request.state);
  const head = request.questions[request.routing?.head ?? "operation"];
  const actionRefs = new Set(
    Object.keys(head?.criteria ?? {}).flatMap((key) => {
      const match = /^(?:CLICK|TYPE_TEXT|SELECT|SCROLL_UP|SCROLL_DOWN):([^:]+)/u.exec(key);
      return match?.[1] ? [match[1]] : [];
    }),
  );
  for (const ref of request.observationRefs ?? []) actionRefs.add(ref);
  let omittedElements = 0;
  const elements = Array.isArray(original.elements)
    ? original.elements.filter((element) => {
        const row = z.record(z.unknown()).parse(element);
        const keep =
          actionRefs.size === 0 ||
          (typeof row.ref === "string" && actionRefs.has(row.ref)) ||
          ["input", "committed", "query", "placeholder"].includes(String(row.valueKind)) ||
          row.required === true;
        if (!keep) omittedElements++;
        return keep;
      })
    : original.elements;
  let lastBytes = 0;
  let smallest: DecisionRequest | undefined;
  const targetBytes = Math.min(TASK_PREVIEW_TARGET_BYTES, maxBytes);
  for (const limit of [512, 256, 128, 64, 32]) {
    let clipped = 0;
    const contexts: Record<string, unknown> = {
      ...z.record(z.unknown()).parse(original.contexts ?? {}),
    };
    const byText = new Map(
      Object.entries(contexts)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([id, text]) => [text, id]),
    );
    let contextSerial = 0;
    const contextId = (text: string): string => {
      if (Object.hasOwn(contexts, text)) return text;
      const known = byText.get(text);
      if (known) return known;
      let id: string;
      do {
        id = `ctx${++contextSerial}`;
      } while (Object.hasOwn(contexts, id));
      contexts[id] = text;
      byText.set(text, id);
      return id;
    };
    const preview = (text: string, length: number) => {
      if (text.length <= length) return text;
      clipped++;
      return text.slice(0, length) + "…";
    };
    const walk = (value: unknown, key = ""): unknown => {
      if (typeof value === "string") {
        if (key === "originalGoal") return value;
        if (key === "pageText") return preview(value, limit * 3);
        return previewKeys.has(key) ? preview(value, limit) : value;
      }
      if (Array.isArray(value)) {
        return value.map((item) =>
          key === "context" && typeof item === "string" ? contextId(item) : walk(item, key),
        );
      }
      if (value !== null && typeof value === "object") {
        const record = z.record(z.unknown()).parse(value);
        if (key === "contexts") {
          return Object.fromEntries(
            Object.entries(record).map(([id, text]) => [
              id,
              typeof text === "string" ? preview(text, limit) : text,
            ]),
          );
        }
        return Object.fromEntries(
          Object.entries(record).flatMap(([name, item]) => {
            if (
              item === undefined ||
              (emptyKeys.has(name) && Array.isArray(item) && item.length === 0)
            ) {
              return [];
            }
            if (name === "displayText" && (item === record.name || item === record.value)) {
              return [];
            }
            if (name === "valueKind" && item === "display-only") return [];
            if (
              name === "editable" &&
              item === false &&
              ["clickable", "button", "link", "generic"].includes(String(record.role))
            ) {
              return [];
            }
            if (key === "position" && typeof item === "number") return [[name, Math.round(item)]];
            return [[name, walk(item, name)]];
          }),
        );
      }
      return value;
    };
    // sourceValues is the canonical input table; facts was a duplicate copy.
    const { facts: _facts, valueSemantics: _semantics, contexts: _contexts, ...base } = original;
    const state = z.record(z.unknown()).parse(walk({ ...base, ...(elements ? { elements } : {}) }));
    if (Object.keys(contexts).length) {
      state.contexts = Object.fromEntries(
        Object.entries(contexts).map(([id, text]) => [
          id,
          typeof text === "string" ? preview(text, limit) : text,
        ]),
      );
    }
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => [
        key,
        {
          ...question,
          criteria: Object.fromEntries(
            Object.entries(question.criteria).map(([choice, label]) => [
              choice,
              preview(label, limit),
            ]),
          ),
        },
      ]),
    );
    state.requestPreview = {
      fieldTextLimit: limit,
      softByteTarget: targetBytes,
      localByteCeiling: maxBytes,
      tokenLimitValidation: "provider",
      clippedStrings: clipped,
      omittedNonActionElements: omittedElements,
      allActionIdsRetained: true,
      executionUsesFullValues: true,
      defaultValueKind: "display-only",
    };
    const compact = { ...request, state, questions };
    lastBytes = Buffer.byteLength(JSON.stringify({ state, questions }), "utf8");
    smallest = compact;
    if (lastBytes <= targetBytes) return compact;
  }
  if (smallest && lastBytes <= maxBytes) return smallest;
  throw new Error(
    `decision_budget_exceeded: local JSON preview is ${lastBytes} bytes, local ceiling ${maxBytes} (not a model token limit); original goal and action identities were retained. No next decision request was sent; earlier actions may have executed.`,
  );
}
