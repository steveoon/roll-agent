import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createTaskProgress, reconcileTaskProgress } from "./task-progress.ts";
import type { ReadTask, TaskProgress } from "./task-progress.ts";
import {
  createFormState,
  updateFormState,
  comparableControl,
  formControlValue,
  preserveDisplayValue,
  preserveDisplayInitialKey,
  FormStateSchema,
} from "./form-context.ts";
import type { FormControl, FormState, FormTask } from "./form-context.ts";
import type { GoalSnapshot } from "./observation.ts";

export const ExecutionSummarySchema = z.object({
  invocationId: z.string(),
  revision: z.number().int(),
  documentChanged: z.boolean(),
  latestObservation: z.string().optional(),
  focus: z.string().optional(),
  changes: z
    .array(
      z.object({
        observationId: z.string(),
        identity: z.string(),
        field: z.string(),
        kind: z.enum(["changed", "became_unknown", "appeared"]),
        before: z.string().optional(),
        after: z.string().optional(),
        afterAction: z.string().optional(),
        scope: z.enum(["delegated", "preserved", "unassigned"]),
      }),
    )
    .max(32),
  lastAction: z
    .object({
      operation: z.string(),
      target: z.string().optional(),
      executed: z.boolean(),
      error: z.string().optional(),
    })
    .optional(),
  form: FormStateSchema.optional(),
});
export type ExecutionContext = {
  summary: z.infer<typeof ExecutionSummarySchema>;
  initial: Map<string, string>;
  previous: Map<string, { name: string; value: string }>;
  unknown: Set<string>;
  ownership: Map<string, { field: string; intent: "set" | "preserve" }>;
  documentId?: string;
  read?: TaskProgress;
  form?: FormState;
};
export function createExecutionContext(input: {
  readTask?: ReadTask | undefined;
  formTask?: FormTask | undefined;
  values: readonly { name: string; text: string }[];
}): ExecutionContext {
  if (input.readTask && input.formTask) throw Error("Choose one delegation adapter");
  const read = input.readTask ? createTaskProgress(input.readTask) : undefined;
  const form = input.formTask ? createFormState(input.formTask, input.values) : undefined;
  return {
    summary: {
      invocationId: read?.taskRunId ?? randomUUID(),
      revision: 0,
      documentChanged: false,
      changes: [],
    },
    initial: new Map(),
    previous: new Map(),
    unknown: new Set(),
    ownership: new Map(),
    ...(read ? { read } : {}),
    ...(form ? { form } : {}),
  };
}
export function observeExecution(
  context: ExecutionContext,
  snapshot: GoalSnapshot,
  controls: readonly FormControl[],
  readTask?: ReadTask,
): boolean {
  const first = context.summary.revision === 0;
  if (context.documentId && context.documentId !== snapshot.documentId) {
    context.summary.documentChanged = true;
    context.previous.clear();
    context.unknown.clear();
    context.initial.clear();
    if (context.form) {
      for (const field of context.form.fields) {
        delete field.binding;
        delete field.semanticProof;
        delete field.entry;
        delete field.entryProof;
        if (field.intent === "preserve") {
          delete field.expected;
          delete field.initial;
        }
        field.status = "unknown";
        field.reason = "document_changed";
      }
    }
  }
  if (snapshot.documentId) context.documentId = snapshot.documentId;
  context.summary.revision++;
  if (snapshot.snapshotId) context.summary.latestObservation = snapshot.snapshotId;
  const current = new Map<string, { name: string; value: string }>();
  for (const c of controls) {
    const displayValue = context.form?.fields.some((f) => f.intent === "preserve")
      ? preserveDisplayValue(c)
      : undefined;
    const value = comparableControl(c) ? formControlValue(c) : displayValue;
    if (value === undefined) continue;
    current.set(c.identity, { name: c.fieldLabel ?? c.name, value });
    if (first) {
      context.initial.set(
        displayValue !== undefined ? preserveDisplayInitialKey(c) : c.identity,
        value,
      );
    }
    const prior = context.previous.get(c.identity);
    context.unknown.delete(c.identity);
    if (!first && !prior) {
      context.summary.changes.push({
        observationId: snapshot.snapshotId ?? "",
        identity: c.identity,
        field: c.fieldLabel ?? c.name,
        kind: "appeared",
        after: value.slice(0, 1000),
        scope: "unassigned",
      });
    }
    if (prior && prior.value !== value) {
      const owned = context.ownership.get(c.identity);
      context.summary.changes.push({
        observationId: snapshot.snapshotId ?? "",
        identity: c.identity,
        field: owned?.field ?? c.fieldLabel ?? c.name,
        kind: "changed",
        before: prior.value.slice(0, 1000),
        after: value.slice(0, 1000),
        ...(context.summary.lastAction
          ? {
              afterAction: `${context.summary.lastAction.operation}: ${context.summary.lastAction.target ?? ""}`,
            }
          : {}),
        scope:
          owned?.intent === "set"
            ? "delegated"
            : owned?.intent === "preserve"
              ? "preserved"
              : "unassigned",
      });
    }
  }
  for (const [identity, prior] of context.previous) {
    if (current.has(identity) || context.unknown.has(identity)) continue;
    context.unknown.add(identity);
    const owned = context.ownership.get(identity);
    if (owned) {
      context.summary.changes.push({
        observationId: snapshot.snapshotId ?? "",
        identity,
        field: owned.field,
        kind: "became_unknown",
        before: prior.value.slice(0, 1000),
        scope: owned.intent === "set" ? "delegated" : "preserved",
      });
    }
  }
  context.summary.changes = context.summary.changes.slice(-32);
  for (const [identity, value] of current) context.previous.set(identity, value);
  while (context.previous.size > 240) {
    const oldest = context.previous.keys().next().value;
    if (oldest === undefined) break;
    context.previous.delete(oldest);
    context.unknown.delete(oldest);
  }
  const panels = snapshot.pageState?.panels ?? [];
  if (context.form) updateFormState(context.form, controls, context.initial, panels);
  return Boolean(
    context.read &&
    readTask &&
    reconcileTaskProgress(
      context.read,
      readTask,
      snapshot.documentId ?? "",
      snapshot.readDocuments ?? [],
    ),
  );
}
export function executionSummary(context: ExecutionContext) {
  return {
    ...context.summary,
    ...(context.form
      ? { form: context.form, ...(context.form.focus ? { focus: context.form.focus } : {}) }
      : {}),
    ...(context.read ? { focus: context.read.phase } : {}),
  };
}
export function recordExecutionAction(
  context: ExecutionContext,
  action: { operation: string; target?: string; executed: boolean; error?: string },
  fieldId?: string,
): void {
  context.summary.lastAction = { ...action };
  if (context.form && fieldId && action.executed && !action.error) context.form.focus = fieldId;
}
