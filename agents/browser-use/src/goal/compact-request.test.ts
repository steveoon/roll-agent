import assert from "node:assert/strict";
import test from "node:test";
import {
  compactTaskRequest,
  MAX_TASK_REQUEST_BYTES,
  TASK_PREVIEW_TARGET_BYTES,
} from "./compact-request.ts";

test("large model previews shrink without dropping actions or changing the original goal", () => {
  const originalGoal = "Use the exact user text, including\nthis line.";
  const criteria = Object.fromEntries(
    Array.from({ length: 120 }, (_, i) => [`CLICK:@e${i}`, `Option ${i}`]),
  );
  const request = {
    state: {
      originalGoal,
      facts: { duplicate: "x".repeat(10000) },
      elements: Array.from({ length: 120 }, (_, i) => ({
        ref: `@e${i}`,
        name: "候选名称".repeat(100),
        valueKind: "option-label",
        context: [],
        sourceValueMatches: [],
      })),
      sourceValues: { v1: { name: "prose", text: "字".repeat(8000), fullLength: 8000 } },
    },
    questions: {
      operation: { type: "choice" as const, instructions: "Choose a candidate", criteria },
    },
  };
  const compact = compactTaskRequest(request);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ state: compact.state, questions: compact.questions })) <=
      TASK_PREVIEW_TARGET_BYTES,
  );
  assert.deepEqual(compact.questions.operation?.criteria, criteria);
  const state = compact.state as {
    originalGoal: string;
    elements: { ref: string }[];
    requestPreview: { clippedStrings: number };
  };
  assert.equal(state.originalGoal, originalGoal);
  assert.deepEqual(
    state.elements.map((e) => e.ref),
    request.state.elements.map((e) => e.ref),
  );
  assert.ok(state.requestPreview.clippedStrings > 0);
  assert.equal(request.state.sourceValues.v1.text.length, 8000);
});

test("a protected original goal is never silently truncated to fit", () => {
  assert.throws(
    () => compactTaskRequest({ state: { originalGoal: "界".repeat(16000) }, questions: {} }, 48000),
    /decision_budget_exceeded/,
  );
});

test("default display metadata is deduplicated while readonly input evidence remains explicit", () => {
  const result = compactTaskRequest({
    state: {
      originalGoal: "Choose the requested option",
      elements: [
        {
          ref: "@a",
          role: "clickable",
          name: "Candidate",
          editable: false,
          valueKind: "display-only",
        },
        {
          ref: "@b",
          role: "textbox",
          name: "Summary",
          editable: false,
          readonly: true,
          valueKind: "input",
          value: "Applied",
        },
      ],
    },
    questions: {
      operation: { type: "choice", instructions: "Choose", criteria: { "CLICK:@a": "Candidate" } },
    },
  });
  const state = result.state as {
    elements: Record<string, unknown>[];
    requestPreview: { defaultValueKind: string };
  };
  assert.equal(state.requestPreview.defaultValueKind, "display-only");
  assert.equal(state.elements[0]?.editable, undefined);
  assert.equal(state.elements[0]?.valueKind, undefined);
  assert.equal(state.elements[1]?.editable, false);
  assert.equal(state.elements[1]?.readonly, true);
  assert.equal(state.elements[1]?.value, "Applied");
});

test("48KB is a soft JSON target and does not masquerade as a provider token rejection", () => {
  const originalGoal = "界".repeat(17000);
  const result = compactTaskRequest({ state: { originalGoal }, questions: {} });
  assert.equal((result.state as { originalGoal: string }).originalGoal, originalGoal);
  const bytes = Buffer.byteLength(
    JSON.stringify({ state: result.state, questions: result.questions }),
  );
  assert.ok(bytes > TASK_PREVIEW_TARGET_BYTES && bytes < MAX_TASK_REQUEST_BYTES);
  assert.throws(
    () => compactTaskRequest({ state: { originalGoal: "界".repeat(50000) }, questions: {} }),
    /local ceiling.*not a model token limit/,
  );
});

test("repeated long-list contexts are interned and field previews shrink without changing source evidence", () => {
  const shared = "同一组公司的共同背景说明".repeat(20);
  const request = {
    state: {
      originalGoal: "Choose the company",
      elements: Array.from({ length: 120 }, (_, i) => ({
        ref: `@e${i}`,
        name: `Company ${i}`,
        context: [shared],
      })),
      formControls: [{ ref: "@e0", context: [shared] }],
      executionContext: {
        form: {
          fields: [
            {
              current: "长".repeat(5000),
              currentLength: 5000,
              expected: "另".repeat(5000),
              expectedLength: 5000,
            },
          ],
        },
      },
    },
    questions: {
      operation: {
        type: "choice" as const,
        instructions: "Choose",
        criteria: Object.fromEntries(
          Array.from({ length: 120 }, (_, i) => [`CLICK:@e${i}`, `Company ${i}`]),
        ),
      },
    },
  };
  const result = compactTaskRequest(request);
  const state = result.state as {
    elements: { context: string[] }[];
    formControls: { context: string[] }[];
    contexts: Record<string, string>;
  };
  assert.equal(state.elements[0]?.context[0], state.formControls[0]?.context[0]);
  assert.equal(Object.keys(state.contexts).length, 1);
  assert.equal(request.state.executionContext.form.fields[0]?.current.length, 5000);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ state: result.state, questions: result.questions })) <=
      TASK_PREVIEW_TARGET_BYTES,
  );
});
