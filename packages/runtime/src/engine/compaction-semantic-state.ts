/** Read compatibility for legacy V1/V2 checkpoints and their archived semantic ledger.
 * Current task-summary compaction does not build, validate, merge or write semantic facts. */
import { createHash } from "node:crypto";

import { z } from "zod";

export const COMPACTION_SEMANTIC_STATE_VERSION = 1 as const;

export const COMPACTION_PROVENANCE_KINDS = [
  "message",
  "tool_execution",
  "resource",
  "running_session",
  "legacy_snapshot",
] as const;

export const COMPACTION_SEMANTIC_ITEM_KINDS = [
  "goal",
  "constraint",
  "decision",
  "completed_work",
  "pending_work",
  "resource",
  "running_session",
  "uncertainty",
] as const;

const COMPACTION_RECOVERY_PRIORITY = [
  "goal",
  "constraint",
  "pending_work",
  "uncertainty",
  "decision",
  "resource",
  "completed_work",
] as const satisfies readonly (typeof COMPACTION_SEMANTIC_ITEM_KINDS)[number][];

const SEMANTIC_ITEM_ID_PATTERN =
  /^semantic_(?:goal|constraint|decision|completed_work|pending_work|resource|running_session|uncertainty)_[0-9a-f]{24}$/u;

const MAX_ITEM_TEXT_CHARS = 1_024;

/** Page size for roll__context item reads. Segment coverage uses the same grid. */

const MAX_PROVENANCE_REFS = 8;

const MAX_SOURCE_QUOTES = 8;

const MAX_SOURCE_QUOTE_CHARS = 512;

const MAX_DECISIONS = 64;

const MAX_CONSTRAINTS = 128;

const MAX_COMPLETED_WORK = 128;

const MAX_PENDING_WORK = 128;

const MAX_RESOURCES = 256;

const MAX_RUNNING_SESSIONS = 128;

const MAX_UNCERTAINTIES = 128;

const MAX_SEMANTIC_STATE_BYTES = 128 * 1_024;

const DEFAULT_REMINDER_PROJECTION_MAX_CHARS = 16_000;

const MAX_REMINDER_ITEM_CHARS = 512;

export const compactionSemanticItemIdSchema = z
  .string()
  .regex(SEMANTIC_ITEM_ID_PATTERN)
  .brand<"CompactionSemanticItemId">();

export type CompactionSemanticItemId = z.infer<typeof compactionSemanticItemIdSchema>;

/**
 * A single-object representation is deliberate: some structured-output providers
 * cannot reliably emit discriminated unions. Every property is required and the
 * kind-specific nullability invariant is checked after decoding.
 */
export const compactionProvenanceRefSchema = z
  .object({
    kind: z.enum(COMPACTION_PROVENANCE_KINDS),
    messageSequence: z.number().int().nonnegative().nullable(),
    toolExecutionId: z.string().uuid().nullable(),
    resourceKey: z.string().trim().min(1).nullable(),
    managerInstanceId: z.string().uuid().nullable(),
    sessionId: z.number().int().nonnegative().nullable(),
    checkpointId: z.string().uuid().nullable().default(null),
    snapshotIndex: z.number().int().nonnegative().nullable().default(null),
  })
  .strict()
  .superRefine((reference, context) => {
    const expectedNonNull = {
      message: ["messageSequence"],
      tool_execution: ["toolExecutionId"],
      resource: ["resourceKey"],
      running_session: ["managerInstanceId", "sessionId"],
      legacy_snapshot: ["checkpointId", "snapshotIndex"],
    } as const satisfies Record<
      (typeof COMPACTION_PROVENANCE_KINDS)[number],
      readonly (keyof typeof reference)[]
    >;
    const nullableFields = [
      "messageSequence",
      "toolExecutionId",
      "resourceKey",
      "managerInstanceId",
      "sessionId",
      "checkpointId",
      "snapshotIndex",
    ] as const;
    const required = new Set<keyof typeof reference>(expectedNonNull[reference.kind]);
    for (const field of nullableFields) {
      const value = reference[field];
      if (required.has(field) ? value === null : value !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be ${required.has(field) ? "non-null" : "null"} for ${reference.kind}`,
          path: [field],
        });
      }
    }
  })
  .readonly();

export type CompactionProvenanceRef = z.infer<typeof compactionProvenanceRefSchema>;

const semanticTextItemShape = {
  id: compactionSemanticItemIdSchema,
  harnessKey: z.string().max(128).optional(),
  relatedItemId: compactionSemanticItemIdSchema.optional(),
  text: z.string().trim().min(1).max(MAX_ITEM_TEXT_CHARS),
  provenance: z.array(compactionProvenanceRefSchema).min(1).max(MAX_PROVENANCE_REFS),
  sourceQuotes: z
    .array(z.string().trim().min(1).max(MAX_SOURCE_QUOTE_CHARS))
    .max(MAX_SOURCE_QUOTES)
    .default([]),
} satisfies z.ZodRawShape;

export const semanticTextItemSchema = z.object(semanticTextItemShape).strict().readonly();

const semanticResourceShape = {
  id: compactionSemanticItemIdSchema,
  resourceKey: z.string().trim().min(1).max(MAX_ITEM_TEXT_CHARS),
  provenance: z.array(compactionProvenanceRefSchema).min(1).max(MAX_PROVENANCE_REFS),
} satisfies z.ZodRawShape;

export const semanticResourceSchema = z.object(semanticResourceShape).strict().readonly();

const semanticRunningSessionShape = {
  id: compactionSemanticItemIdSchema,
  managerInstanceId: z.string().uuid(),
  sessionId: z.number().int().nonnegative(),
  provenance: z.array(compactionProvenanceRefSchema).min(1).max(MAX_PROVENANCE_REFS),
} satisfies z.ZodRawShape;

export const semanticRunningSessionSchema = z
  .object(semanticRunningSessionShape)
  .strict()
  .readonly();

const compactionSemanticPrunedCountsSchema = z
  .object({
    constraint: z.number().int().nonnegative().default(0),
    decision: z.number().int().nonnegative(),
    completed_work: z.number().int().nonnegative(),
    pending_work: z.number().int().nonnegative(),
    resource: z.number().int().nonnegative(),
    running_session: z.number().int().nonnegative(),
    uncertainty: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

const EMPTY_SEMANTIC_PRUNED_COUNTS = Object.freeze({
  constraint: 0,
  decision: 0,
  completed_work: 0,
  pending_work: 0,
  resource: 0,
  running_session: 0,
  uncertainty: 0,
});

export const compactionSemanticStateSchema = z
  .object({
    version: z.literal(COMPACTION_SEMANTIC_STATE_VERSION),
    scopeId: z.string().max(128).optional(),
    goal: semanticTextItemSchema.nullable(),
    constraints: z.array(semanticTextItemSchema).max(MAX_CONSTRAINTS).default([]),
    decisions: z.array(semanticTextItemSchema).max(MAX_DECISIONS),
    completedWork: z.array(semanticTextItemSchema).max(MAX_COMPLETED_WORK),
    pendingWork: z.array(semanticTextItemSchema).max(MAX_PENDING_WORK),
    resources: z.array(semanticResourceSchema).max(MAX_RESOURCES),
    runningSessions: z.array(semanticRunningSessionSchema).max(MAX_RUNNING_SESSIONS),
    uncertainties: z.array(semanticTextItemSchema).max(MAX_UNCERTAINTIES),
    prunedItemCounts: compactionSemanticPrunedCountsSchema.default(EMPTY_SEMANTIC_PRUNED_COUNTS),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>();
    const entries = [
      ...(state.goal === null ? [] : [["goal", state.goal.id] as const]),
      ...state.constraints.map((item) => ["constraint", item.id] as const),
      ...state.decisions.map((item) => ["decision", item.id] as const),
      ...state.completedWork.map((item) => ["completed_work", item.id] as const),
      ...state.pendingWork.map((item) => ["pending_work", item.id] as const),
      ...state.resources.map((item) => ["resource", item.id] as const),
      ...state.runningSessions.map((item) => ["running_session", item.id] as const),
      ...state.uncertainties.map((item) => ["uncertainty", item.id] as const),
    ];
    for (const [category, id] of entries) {
      if (!id.startsWith(`semantic_${category}_`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `semantic item ID does not match category ${category}`,
        });
      }
      if (ids.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate semantic item ID: ${id}`,
        });
      }
      ids.add(id);
    }
  })
  .readonly();

export type CompactionSemanticState = z.infer<typeof compactionSemanticStateSchema>;

export type CompactionSemanticTextItem = CompactionSemanticState["decisions"][number];

const compactionSemanticReminderItemSchema = z
  .object({
    itemId: compactionSemanticItemIdSchema,
    category: z.enum(COMPACTION_SEMANTIC_ITEM_KINDS),
    text: z.string().trim().min(1).max(MAX_REMINDER_ITEM_CHARS),
    sourceQuotes: z
      .array(z.string().trim().min(1).max(MAX_SOURCE_QUOTE_CHARS))
      .max(MAX_SOURCE_QUOTES),
  })
  .strict()
  .readonly();

const compactionSemanticReminderOmittedCountsSchema = z
  .object({
    goal: z.number().int().nonnegative(),
    constraint: z.number().int().nonnegative(),
    decision: z.number().int().nonnegative(),
    completed_work: z.number().int().nonnegative(),
    pending_work: z.number().int().nonnegative(),
    resource: z.number().int().nonnegative(),
    running_session: z.number().int().nonnegative(),
    uncertainty: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const compactionSemanticReminderProjectionSchema = z
  .object({
    version: z.literal(COMPACTION_SEMANTIC_STATE_VERSION),
    items: z.array(compactionSemanticReminderItemSchema),
    omittedCounts: compactionSemanticReminderOmittedCountsSchema,
  })
  .strict()
  .readonly();

export type CompactionSemanticReminderProjection = z.infer<
  typeof compactionSemanticReminderProjectionSchema
>;

export const semanticArchiveItemSchema = z
  .object({
    category: z.enum(COMPACTION_SEMANTIC_ITEM_KINDS),
    item: z.union([semanticTextItemSchema, semanticResourceSchema, semanticRunningSessionSchema]),
  })
  .strict();

export type SemanticArchiveItem = z.infer<typeof semanticArchiveItemSchema>;

export function listSemanticArchiveItems(state: CompactionSemanticState): SemanticArchiveItem[] {
  return [
    ...(state.goal ? [{ category: "goal" as const, item: state.goal }] : []),
    ...state.constraints.map((item) => ({ category: "constraint" as const, item })),
    ...state.decisions.map((item) => ({ category: "decision" as const, item })),
    ...state.completedWork.map((item) => ({ category: "completed_work" as const, item })),
    ...state.pendingWork.map((item) => ({ category: "pending_work" as const, item })),
    ...state.uncertainties.map((item) => ({ category: "uncertainty" as const, item })),
    ...state.resources.map((item) => ({ category: "resource" as const, item })),
    ...state.runningSessions.map((item) => ({ category: "running_session" as const, item })),
  ];
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function provenanceIdentity(reference: CompactionProvenanceRef): string {
  switch (reference.kind) {
    case "message":
      return `message:${String(reference.messageSequence)}`;
    case "tool_execution":
      return `tool_execution:${String(reference.toolExecutionId)}`;
    case "resource":
      return `resource:${String(reference.resourceKey)}`;
    case "running_session":
      return `running_session:${String(reference.managerInstanceId)}:${String(reference.sessionId)}`;
    case "legacy_snapshot":
      return `legacy_snapshot:${String(reference.checkpointId)}:${String(reference.snapshotIndex)}`;
  }
}

function stableSemanticItemId(
  kind: (typeof COMPACTION_SEMANTIC_ITEM_KINDS)[number],
  identity: string,
  provenance: readonly CompactionProvenanceRef[],
): CompactionSemanticItemId {
  const canonical = [
    kind,
    normalizedText(identity),
    ...provenance.map(provenanceIdentity).sort((left, right) => left.localeCompare(right)),
  ].join("\n");
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return compactionSemanticItemIdSchema.parse(`semantic_${kind}_${digest}`);
}

function createProvenanceReference(
  input:
    | { readonly kind: "message"; readonly sequence: number }
    | { readonly kind: "tool_execution"; readonly executionId: string }
    | { readonly kind: "resource"; readonly resourceKey: string }
    | {
        readonly kind: "legacy_snapshot";
        readonly checkpointId: string;
        readonly snapshotIndex: number;
      }
    | {
        readonly kind: "running_session";
        readonly managerInstanceId: string;
        readonly sessionId: number;
      },
): CompactionProvenanceRef {
  return compactionProvenanceRefSchema.parse({
    kind: input.kind,
    messageSequence: input.kind === "message" ? input.sequence : null,
    toolExecutionId: input.kind === "tool_execution" ? input.executionId : null,
    resourceKey: input.kind === "resource" ? input.resourceKey : null,
    managerInstanceId: input.kind === "running_session" ? input.managerInstanceId : null,
    sessionId: input.kind === "running_session" ? input.sessionId : null,
    checkpointId: input.kind === "legacy_snapshot" ? input.checkpointId : null,
    snapshotIndex: input.kind === "legacy_snapshot" ? input.snapshotIndex : null,
  });
}

interface ModelPreviousSemanticItem {
  readonly itemId: string;
  readonly category: (typeof COMPACTION_SEMANTIC_ITEM_KINDS)[number];
  readonly text: string;
  readonly sourceQuotes?: readonly string[];
}

export function createEmptyCompactionSemanticState(): CompactionSemanticState {
  return compactionSemanticStateSchema.parse({
    version: COMPACTION_SEMANTIC_STATE_VERSION,
    goal: null,
    constraints: [],
    decisions: [],
    completedWork: [],
    pendingWork: [],
    resources: [],
    runningSessions: [],
    uncertainties: [],
    prunedItemCounts: EMPTY_SEMANTIC_PRUNED_COUNTS,
  });
}

function semanticConstraintsFromEvidence(
  constraints: readonly { readonly quote: string; readonly sourceSequence: number }[],
): readonly CompactionSemanticTextItem[] {
  return constraints.map((constraint) => {
    const provenance = createProvenanceReference({
      kind: "message",
      sequence: constraint.sourceSequence,
    });
    const quote = boundedText(constraint.quote, MAX_SOURCE_QUOTE_CHARS);
    return semanticTextItemSchema.parse({
      id: stableSemanticItemId("constraint", quote, [provenance]),
      text: quote,
      provenance: [provenance],
      sourceQuotes: [quote],
    });
  });
}

/** Deterministic truncate mode replaces only the constraint slice from verbatim user evidence. */
export function replaceCompactionSemanticConstraints(
  stateInput: CompactionSemanticState,
  constraints: readonly { readonly quote: string; readonly sourceSequence: number }[],
): CompactionSemanticState {
  const state = compactionSemanticStateSchema.parse(stateInput);
  const replacement = takeNewestWithinLimit(
    semanticConstraintsFromEvidence(constraints),
    MAX_CONSTRAINTS,
  );
  return boundCompactionSemanticState(
    compactionSemanticStateSchema.parse({
      ...state,
      constraints: replacement.items,
      prunedItemCounts: {
        ...state.prunedItemCounts,
        constraint: state.prunedItemCounts.constraint + replacement.prunedCount,
      },
    }),
  );
}

/** Deterministic truncate mode may advance the goal only from an exact persisted user request. */
export function replaceCompactionSemanticGoal(
  stateInput: CompactionSemanticState,
  goal: { readonly verbatimRequest: string; readonly sourceSequence: number } | undefined,
): CompactionSemanticState {
  const state = compactionSemanticStateSchema.parse(stateInput);
  if (goal === undefined) {
    return boundCompactionSemanticState(
      compactionSemanticStateSchema.parse({
        ...state,
        goal: null,
      }),
    );
  }
  const provenance = createProvenanceReference({ kind: "message", sequence: goal.sourceSequence });
  const text = boundedText(goal.verbatimRequest, MAX_ITEM_TEXT_CHARS);
  const sourceQuote = boundedText(goal.verbatimRequest, MAX_SOURCE_QUOTE_CHARS);
  return boundCompactionSemanticState(
    compactionSemanticStateSchema.parse({
      ...state,
      goal: semanticTextItemSchema.parse({
        id: stableSemanticItemId("goal", text, [provenance]),
        text,
        provenance: [provenance],
        sourceQuotes: [sourceQuote],
      }),
    }),
  );
}

function takeNewestWithinLimit<T>(
  items: readonly T[],
  limit: number,
): { readonly items: T[]; readonly prunedCount: number } {
  const prunedCount = Math.max(0, items.length - limit);
  return {
    items: prunedCount === 0 ? [...items] : items.slice(-limit),
    prunedCount,
  };
}

function boundCompactionSemanticState(
  stateInput: CompactionSemanticState,
): CompactionSemanticState {
  const state = compactionSemanticStateSchema.parse(stateInput);
  const constraints = [...state.constraints];
  const decisions = [...state.decisions];
  const completedWork = [...state.completedWork];
  const pendingWork = [...state.pendingWork];
  const resources = [...state.resources];
  const runningSessions = [...state.runningSessions];
  const uncertainties = [...state.uncertainties];
  const prunedItemCounts = { ...state.prunedItemCounts };
  const current = (): CompactionSemanticState =>
    compactionSemanticStateSchema.parse({
      ...state,
      constraints,
      decisions,
      completedWork,
      pendingWork,
      resources,
      runningSessions,
      uncertainties,
      prunedItemCounts,
    });
  const sections: Array<{
    readonly countKey: keyof typeof prunedItemCounts;
    readonly items: { readonly length: number; shift(): unknown };
  }> = [
    { countKey: "completed_work", items: completedWork },
    { countKey: "resource", items: resources },
    { countKey: "decision", items: decisions },
    { countKey: "running_session", items: runningSessions },
    { countKey: "uncertainty", items: uncertainties },
    { countKey: "constraint", items: constraints },
    { countKey: "pending_work", items: pendingWork },
  ];
  let retainAtLeastOne = true;
  while (Buffer.byteLength(JSON.stringify(current()), "utf8") > MAX_SEMANTIC_STATE_BYTES) {
    const section = sections.find(({ items }) =>
      retainAtLeastOne ? items.length > 1 : items.length > 0,
    );
    if (section === undefined) {
      if (retainAtLeastOne) {
        retainAtLeastOne = false;
        continue;
      }
      throw new Error("Compaction semantic state exceeds its aggregate storage budget");
    }
    section.items.shift();
    prunedItemCounts[section.countKey] += 1;
  }
  return current();
}

function boundedText(value: string, maxChars: number): string {
  const normalized = normalizedText(value);
  // Zod string limits count UTF-16 code units. Iterate code points so truncation
  // respects that budget without splitting a surrogate pair, reserving the ellipsis.
  if (normalized.length <= maxChars) return normalized;
  let prefix = "";
  for (const character of normalized) {
    if (prefix.length + character.length > maxChars - 1) break;
    prefix += character;
  }
  return `${prefix}…`;
}

function semanticReminderItems(
  state: CompactionSemanticState,
): readonly ModelPreviousSemanticItem[] {
  const textItems = (
    category: ModelPreviousSemanticItem["category"],
    items: readonly CompactionSemanticTextItem[],
  ): readonly ModelPreviousSemanticItem[] =>
    items.map((item) => ({
      itemId: item.id,
      category,
      text: boundedText(item.text, MAX_REMINDER_ITEM_CHARS),
      sourceQuotes:
        item.text.length <= MAX_REMINDER_ITEM_CHARS &&
        item.sourceQuotes.every((quote) => item.text.includes(quote))
          ? []
          : item.sourceQuotes.map((quote) => boundedText(quote, MAX_SOURCE_QUOTE_CHARS)),
    }));
  return [
    ...(state.goal === null
      ? []
      : [
          {
            itemId: state.goal.id,
            category: "goal" as const,
            text: boundedText(state.goal.text, MAX_REMINDER_ITEM_CHARS),
            sourceQuotes: state.goal.sourceQuotes.map((quote) =>
              boundedText(quote, MAX_SOURCE_QUOTE_CHARS),
            ),
          },
        ]),
    ...textItems("constraint", state.constraints),
    ...textItems("pending_work", state.pendingWork),
    ...textItems("uncertainty", state.uncertainties),
    ...textItems("decision", state.decisions),
    ...state.resources.map((item) => ({
      itemId: item.id,
      category: "resource" as const,
      text: boundedText(item.resourceKey, MAX_REMINDER_ITEM_CHARS),
      sourceQuotes: [boundedText(item.resourceKey, MAX_SOURCE_QUOTE_CHARS)],
    })),
    ...textItems("completed_work", state.completedWork),
  ];
}

/**
 * Projects the durable semantic state into a bounded, structured prompt reminder.
 * The complete state remains in the checkpoint and can be recovered through the
 * transcript path; omitted counts make prompt truncation explicit to the model.
 */
export function createCompactionSemanticReminderProjection(
  stateInput: CompactionSemanticState,
  maxChars = DEFAULT_REMINDER_PROJECTION_MAX_CHARS,
): CompactionSemanticReminderProjection {
  if (!Number.isInteger(maxChars) || maxChars < 1_024 || maxChars > 32_000) {
    throw new Error("maxChars must be an integer between 1024 and 32000");
  }
  const state = compactionSemanticStateSchema.parse(stateInput);
  const priority = COMPACTION_RECOVERY_PRIORITY;
  const candidates = semanticReminderItems(state).map((item) => {
    if (JSON.stringify(item).length <= 768) return item;
    return {
      ...item,
      text:
        boundedText(item.text, 300) +
        " [preview; read full item via the checkpoint transcript lookup]",
      sourceQuotes: [],
    };
  });
  const byCategory = new Map(
    priority.map((category) => [
      category,
      candidates.filter((candidate) => candidate.category === category),
    ]),
  );
  const selected: ModelPreviousSemanticItem[] = [];
  const project = (): CompactionSemanticReminderProjection => {
    const selectedCounts = new Map(
      priority.map((category) => [
        category,
        selected.filter(
          (item) => item.category === category && !item.text.includes("[preview; read full item"),
        ).length,
      ]),
    );
    return compactionSemanticReminderProjectionSchema.parse({
      version: COMPACTION_SEMANTIC_STATE_VERSION,
      items: selected,
      omittedCounts: {
        goal: (byCategory.get("goal")?.length ?? 0) - (selectedCounts.get("goal") ?? 0),
        constraint:
          state.prunedItemCounts.constraint +
          (byCategory.get("constraint")?.length ?? 0) -
          (selectedCounts.get("constraint") ?? 0),
        decision:
          state.prunedItemCounts.decision +
          (byCategory.get("decision")?.length ?? 0) -
          (selectedCounts.get("decision") ?? 0),
        completed_work:
          state.prunedItemCounts.completed_work +
          (byCategory.get("completed_work")?.length ?? 0) -
          (selectedCounts.get("completed_work") ?? 0),
        pending_work:
          state.prunedItemCounts.pending_work +
          (byCategory.get("pending_work")?.length ?? 0) -
          (selectedCounts.get("pending_work") ?? 0),
        resource:
          state.prunedItemCounts.resource +
          (byCategory.get("resource")?.length ?? 0) -
          (selectedCounts.get("resource") ?? 0),
        running_session: state.prunedItemCounts.running_session + state.runningSessions.length,
        uncertainty:
          state.prunedItemCounts.uncertainty +
          (byCategory.get("uncertainty")?.length ?? 0) -
          (selectedCounts.get("uncertainty") ?? 0),
      },
    });
  };

  // Reserve bounded previews for the goal and two latest next steps/blockers.
  for (const category of ["goal", "pending_work", "uncertainty"] as const) {
    for (const item of (byCategory.get(category) ?? []).slice(category === "goal" ? -1 : -2)) {
      selected.push(item);
      if (JSON.stringify(project()).length > maxChars) selected.pop();
    }
  }
  const maxDepth = Math.max(0, ...[...byCategory.values()].map((items) => items.length));
  // Historical completion records must not crowd out active requirements as the
  // checkpoint grows. Preserve fairness among active categories, then use spare room.
  const tiers = [
    priority.filter((category) => category !== "completed_work"),
    ["completed_work"] as const,
  ];
  for (const categories of tiers) {
    for (let depth = 0; depth < maxDepth; depth += 1) {
      for (const category of categories) {
        const items = byCategory.get(category) ?? [];
        const candidate = items.at(-(depth + 1));
        if (candidate === undefined || selected.some((item) => item.itemId === candidate.itemId)) {
          continue;
        }
        selected.push(candidate);
        if (JSON.stringify(project()).length > maxChars) {
          selected.pop();
        }
      }
    }
  }
  const projection = project();
  if (JSON.stringify(projection).length > maxChars) {
    throw new Error("Unable to create bounded semantic reminder projection");
  }
  return projection;
}
