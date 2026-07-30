import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TOOL_OUTCOME_KINDS,
  type ToolCancellationExecutionState,
} from "../tool-bridge/normalize-result.ts";

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
const MAX_RESOLUTION_REASON_CHARS = 1_024;
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
const DEFAULT_SUMMARY_MAX_CHARS = 12_000;
const MAX_SUMMARY_ITEM_CHARS = 512;
const MAX_SUMMARY_ITEMS_PER_SECTION = 16;
const DEFAULT_REMINDER_PROJECTION_MAX_CHARS = 16_000;
const MAX_REMINDER_ITEM_CHARS = 512;
const MAX_MODEL_EVIDENCE_ITEMS = 32;

export const legacyCompactionTranscriptFragmentsSchema = z
  .array(z.string().trim().min(1).max(MAX_SOURCE_QUOTE_CHARS))
  .max(MAX_UNCERTAINTIES)
  .readonly();

export type LegacyCompactionTranscriptFragments = z.infer<
  typeof legacyCompactionTranscriptFragmentsSchema
>;

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

const modelSemanticTextItemShape = {
  priorItemId: z.string().trim().min(1).max(128).nullable(),
  text: z.string().trim().min(1).max(MAX_ITEM_TEXT_CHARS),
  sourceEvidenceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(MAX_PROVENANCE_REFS),
  sourceQuotes: z
    .array(z.string().trim().min(1).max(MAX_SOURCE_QUOTE_CHARS))
    .min(1)
    .max(MAX_SOURCE_QUOTES),
} satisfies z.ZodRawShape;
const modelSemanticTextItemSchema = z.object(modelSemanticTextItemShape).strict().readonly();

const modelSemanticResourceShape = {
  priorItemId: z.string().trim().min(1).max(128).nullable(),
  sourceEvidenceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(MAX_PROVENANCE_REFS),
} satisfies z.ZodRawShape;
const modelSemanticResourceSchema = z.object(modelSemanticResourceShape).strict().readonly();

const modelSemanticRunningSessionShape = {
  priorItemId: z.string().trim().min(1).max(128).nullable(),
  sourceEvidenceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(MAX_PROVENANCE_REFS),
} satisfies z.ZodRawShape;
const modelSemanticRunningSessionSchema = z
  .object(modelSemanticRunningSessionShape)
  .strict()
  .readonly();

const modelSemanticResolutionSchema = z
  .object({
    targetItemId: z.string().trim().min(1).max(128),
    targetCategory: z.enum(["constraint", "decision", "pending_work", "uncertainty"]),
    action: z.enum(["cancel", "supersede", "clarify", "revoke"]),
    reason: z.string().trim().min(1).max(MAX_RESOLUTION_REASON_CHARS),
    sourceEvidenceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(MAX_PROVENANCE_REFS),
    sourceQuotes: z
      .array(z.string().trim().min(1).max(MAX_SOURCE_QUOTE_CHARS))
      .min(1)
      .max(MAX_SOURCE_QUOTES),
  })
  .strict()
  .readonly();

const modelSemanticEvidenceReviewSchema = z
  .object({
    evidenceId: z.string().trim().min(1).max(128),
    disposition: z.enum(["irrelevant", "uncertain"]),
    reason: z.string().trim().min(1).max(MAX_RESOLUTION_REASON_CHARS),
  })
  .strict()
  .readonly();

/**
 * Provider-portable structured output contract. All object properties are
 * required; goal is explicitly nullable and empty arrays mean "no candidate".
 */
export const compactionModelDraftSchema = z
  .object({
    startsNewGoalScope: z.boolean(),
    goal: modelSemanticTextItemSchema.nullable(),
    constraints: z.array(modelSemanticTextItemSchema).max(MAX_CONSTRAINTS),
    decisions: z.array(modelSemanticTextItemSchema).max(MAX_DECISIONS),
    completedWork: z.array(modelSemanticTextItemSchema).max(MAX_COMPLETED_WORK),
    pendingWork: z.array(modelSemanticTextItemSchema).max(MAX_PENDING_WORK),
    resources: z.array(modelSemanticResourceSchema).max(MAX_RESOURCES),
    runningSessions: z.array(modelSemanticRunningSessionSchema).max(MAX_RUNNING_SESSIONS),
    uncertainties: z.array(modelSemanticTextItemSchema).max(MAX_UNCERTAINTIES),
    resolutions: z.array(modelSemanticResolutionSchema).max(256),
    evidenceReviews: z.array(modelSemanticEvidenceReviewSchema).max(512),
  })
  .strict()
  .readonly();

export type CompactionModelDraft = z.infer<typeof compactionModelDraftSchema>;

export function createEmptyCompactionModelDraft(): CompactionModelDraft {
  return compactionModelDraftSchema.parse({
    startsNewGoalScope: false,
    goal: null,
    constraints: [],
    decisions: [],
    completedWork: [],
    pendingWork: [],
    resources: [],
    runningSessions: [],
    uncertainties: [],
    resolutions: [],
    evidenceReviews: [],
  });
}

const semanticTextItemShape = {
  id: compactionSemanticItemIdSchema,
  text: z.string().trim().min(1).max(MAX_ITEM_TEXT_CHARS),
  provenance: z.array(compactionProvenanceRefSchema).min(1).max(MAX_PROVENANCE_REFS),
  sourceQuotes: z
    .array(z.string().trim().min(1).max(MAX_SOURCE_QUOTE_CHARS))
    .max(MAX_SOURCE_QUOTES)
    .default([]),
} satisfies z.ZodRawShape;
const semanticTextItemSchema = z.object(semanticTextItemShape).strict().readonly();
const semanticResourceShape = {
  id: compactionSemanticItemIdSchema,
  resourceKey: z.string().trim().min(1).max(MAX_ITEM_TEXT_CHARS),
  provenance: z.array(compactionProvenanceRefSchema).min(1).max(MAX_PROVENANCE_REFS),
} satisfies z.ZodRawShape;
const semanticResourceSchema = z.object(semanticResourceShape).strict().readonly();
const semanticRunningSessionShape = {
  id: compactionSemanticItemIdSchema,
  managerInstanceId: z.string().uuid(),
  sessionId: z.number().int().nonnegative(),
  provenance: z.array(compactionProvenanceRefSchema).min(1).max(MAX_PROVENANCE_REFS),
} satisfies z.ZodRawShape;
const semanticRunningSessionSchema = z.object(semanticRunningSessionShape).strict().readonly();

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
export type CompactionSemanticResource = CompactionSemanticState["resources"][number];
export type CompactionSemanticRunningSession = CompactionSemanticState["runningSessions"][number];

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
export interface CompactionSemanticResolution {
  readonly targetItemId: CompactionSemanticItemId;
  readonly targetCategory: "constraint" | "decision" | "pending_work" | "uncertainty";
  readonly action: "cancel" | "supersede" | "clarify" | "revoke";
  readonly reason: string;
  readonly provenance: readonly CompactionProvenanceRef[];
}

export interface CompactionSemanticMessageEvidence {
  readonly sequence: number;
  readonly role?: string;
  readonly summary: string;
}

export interface CompactionSemanticToolEvidence {
  readonly id: string;
  readonly agentName?: string;
  readonly toolName?: string;
  /** Bounded and redacted by the Harness before entering model context. */
  readonly inputSummary?: string;
  /** Bounded and redacted by the Harness before entering model context. */
  readonly resultSummary?: string;
  readonly outcome: {
    readonly kind: string;
    readonly executionState?: ToolCancellationExecutionState;
  };
}

export interface CompactionSemanticResourceEvidence {
  readonly key: string;
  readonly mode?: string;
}

export interface CompactionSemanticRunningSessionEvidence {
  readonly managerInstanceId: string;
  readonly sessionId: number;
  readonly state?: string;
}

export interface BuildCompactionSemanticEvidenceRegistryInput {
  readonly messages: readonly CompactionSemanticMessageEvidence[];
  readonly toolExecutions: readonly CompactionSemanticToolEvidence[];
  readonly resources: readonly CompactionSemanticResourceEvidence[];
  readonly runningSessions: readonly CompactionSemanticRunningSessionEvidence[];
}

export interface CompactionSemanticEvidenceRegistryEntry {
  readonly evidenceId: string;
  readonly summary: string;
  readonly provenance: CompactionProvenanceRef;
  readonly messageRole?: string;
  readonly toolOutcomeKind?: string;
  readonly toolCancellationExecutionState?: ToolCancellationExecutionState;
}

export type CompactionSemanticEvidenceRegistry = readonly CompactionSemanticEvidenceRegistryEntry[];

export interface ValidateCompactionModelDraftInput {
  readonly draft: unknown;
  readonly evidenceRegistry: CompactionSemanticEvidenceRegistry;
  readonly presentedEvidenceIds?: readonly string[];
  readonly previousState?: CompactionSemanticState;
  readonly harnessGoal?: {
    readonly verbatimRequest: string;
    readonly sourceSequence: number;
  };
}

export interface MergeCompactionSemanticStateOptions {
  /** Computed by the Harness from durable goal sourceSequence, never from model wording or IDs. */
  readonly startsNewGoalScope: boolean;
}

export const COMPACTION_SEMANTIC_REJECTION_REASONS = [
  "unknown_provenance",
  "missing_required_provenance",
  "completed_work_without_success_evidence",
  "resource_not_observed",
  "running_session_not_observed",
  "unknown_resolution_target",
  "resolution_target_category_mismatch",
  "invalid_resolution_action",
  "unsupported_source_quote",
  "unknown_evidence_review",
] as const;

export interface CompactionSemanticRejection {
  readonly category:
    | "goal"
    | "constraint"
    | "decision"
    | "completed_work"
    | "pending_work"
    | "resource"
    | "running_session"
    | "uncertainty"
    | "resolution"
    | "evidence_review";
  readonly index: number;
  readonly reason: (typeof COMPACTION_SEMANTIC_REJECTION_REASONS)[number];
}

export interface ValidatedCompactionSemanticCandidate {
  readonly state: CompactionSemanticState;
  readonly resolutions: readonly CompactionSemanticResolution[];
  readonly rejections: readonly CompactionSemanticRejection[];
  readonly coveredEvidenceIds: readonly string[];
  readonly startsNewGoalScope: boolean;
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

function evidenceId(kind: CompactionProvenanceRef["kind"], identity: string): string {
  const digest = createHash("sha256").update(`${kind}\n${identity}`).digest("hex").slice(0, 24);
  return `evidence_${digest}`;
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

/** Builds opaque model-facing handles backed by exact Harness-owned facts. */
export function buildCompactionSemanticEvidenceRegistry(
  input: BuildCompactionSemanticEvidenceRegistryInput,
): CompactionSemanticEvidenceRegistry {
  const entries: CompactionSemanticEvidenceRegistryEntry[] = [];
  for (const message of input.messages) {
    const provenance = createProvenanceReference({ kind: "message", sequence: message.sequence });
    entries.push({
      evidenceId: evidenceId("message", String(message.sequence)),
      summary: boundedText(message.summary, 512),
      provenance,
      ...(message.role === undefined ? {} : { messageRole: message.role }),
    });
  }
  for (const tool of input.toolExecutions) {
    const provenance = createProvenanceReference({
      kind: "tool_execution",
      executionId: tool.id,
    });
    entries.push({
      evidenceId: evidenceId("tool_execution", tool.id),
      summary: boundedText(
        [
          `${tool.agentName ?? "agent"}/${tool.toolName ?? "tool"}: ${tool.outcome.kind}`,
          ...(tool.outcome.executionState === undefined
            ? []
            : [`executionState=${tool.outcome.executionState}`]),
          ...(tool.inputSummary === undefined
            ? []
            : [`input=${boundedText(tool.inputSummary, 160)}`]),
          ...(tool.resultSummary === undefined
            ? []
            : [`result=${boundedText(tool.resultSummary, 256)}`]),
        ].join("; "),
        512,
      ),
      provenance,
      toolOutcomeKind: tool.outcome.kind,
      ...(tool.outcome.executionState === undefined
        ? {}
        : { toolCancellationExecutionState: tool.outcome.executionState }),
    });
  }
  for (const resource of input.resources) {
    const provenance = createProvenanceReference({
      kind: "resource",
      resourceKey: resource.key,
    });
    entries.push({
      evidenceId: evidenceId("resource", resource.key),
      summary: boundedText(
        `${resource.mode === undefined ? "resource" : resource.mode}: ${resource.key}`,
        512,
      ),
      provenance,
    });
  }
  for (const session of input.runningSessions) {
    const identity = `${session.managerInstanceId}:${String(session.sessionId)}`;
    const provenance = createProvenanceReference({
      kind: "running_session",
      managerInstanceId: session.managerInstanceId,
      sessionId: session.sessionId,
    });
    entries.push({
      evidenceId: evidenceId("running_session", identity),
      summary: boundedText(`session ${session.state ?? "observed"}`, 512),
      provenance,
    });
  }
  const unique = new Map<string, CompactionSemanticEvidenceRegistryEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.evidenceId)) {
      unique.set(entry.evidenceId, entry);
    }
  }
  return [...unique.values()];
}

interface ModelEvidenceEntry {
  readonly evidenceId: string;
  readonly kind: CompactionProvenanceRef["kind"];
  readonly summary: string;
  readonly role?: string;
  readonly outcome?: string;
  readonly executionState?: ToolCancellationExecutionState;
}

interface ModelPreviousSemanticItem {
  readonly itemId: string;
  readonly category: (typeof COMPACTION_SEMANTIC_ITEM_KINDS)[number];
  readonly text: string;
  readonly sourceQuotes?: readonly string[];
}

function modelEvidenceEntries(
  registry: CompactionSemanticEvidenceRegistry,
): readonly ModelEvidenceEntry[] {
  return registry.map((entry) => ({
    evidenceId: entry.evidenceId,
    kind: entry.provenance.kind,
    summary: modelFacingEvidenceSummary(entry),
    ...(entry.messageRole === undefined ? {} : { role: entry.messageRole }),
    ...(entry.toolOutcomeKind === undefined ? {} : { outcome: entry.toolOutcomeKind }),
    ...(entry.toolCancellationExecutionState === undefined
      ? {}
      : { executionState: entry.toolCancellationExecutionState }),
  }));
}

function modelFacingEvidenceSummary(entry: CompactionSemanticEvidenceRegistryEntry): string {
  return boundedText(entry.summary, 256);
}

function modelPreviousSemanticItems(
  previousState: CompactionSemanticState | undefined,
): readonly ModelPreviousSemanticItem[] {
  if (previousState === undefined) {
    return [];
  }
  const state = compactionSemanticStateSchema.parse(previousState);
  const textItems = (
    category: ModelPreviousSemanticItem["category"],
    items: readonly CompactionSemanticTextItem[],
  ): ModelPreviousSemanticItem[] =>
    items.slice(-MAX_SUMMARY_ITEMS_PER_SECTION).map((item) => ({
      itemId: item.id,
      category,
      text: boundedText(item.text, 256),
      sourceQuotes: item.sourceQuotes.map((quote) => boundedText(quote, 256)),
    }));
  return [
    ...(state.goal === null
      ? []
      : [
          {
            itemId: state.goal.id,
            category: "goal" as const,
            text: boundedText(state.goal.text, 256),
            sourceQuotes: state.goal.sourceQuotes.map((quote) => boundedText(quote, 256)),
          },
        ]),
    ...textItems("constraint", state.constraints),
    ...textItems("pending_work", state.pendingWork),
    ...textItems("uncertainty", state.uncertainties),
    ...textItems("decision", state.decisions),
    ...textItems("completed_work", state.completedWork),
    ...state.resources.slice(-MAX_SUMMARY_ITEMS_PER_SECTION).map((item) => ({
      itemId: item.id,
      category: "resource" as const,
      text: boundedText(item.resourceKey, 256),
      sourceQuotes: [boundedText(item.resourceKey, 256)],
    })),
  ];
}

function renderBoundedModelContext(
  evidence: readonly ModelEvidenceEntry[],
  previousItems: readonly ModelPreviousSemanticItem[],
  maxChars: number,
): { readonly prompt: string; readonly includedEvidenceIds: readonly string[] } {
  const includedPrevious: ModelPreviousSemanticItem[] = [];
  const includedEvidence: ModelEvidenceEntry[] = [];
  const serialize = (): string =>
    JSON.stringify({
      previousSemanticItems: includedPrevious,
      evidence: includedEvidence,
      omittedPreviousItemCount: previousItems.length - includedPrevious.length,
      omittedEvidenceCount: evidence.length - includedEvidence.length,
    });
  const includeIfFits = <T>(target: T[], value: T): boolean => {
    target.push(value);
    if ([...serialize()].length <= maxChars) {
      return true;
    }
    target.pop();
    return false;
  };
  let previousIndex = 0;
  let evidenceIndex = 0;
  if (previousItems[0] !== undefined && includeIfFits(includedPrevious, previousItems[0])) {
    previousIndex = 1;
  }
  if (evidence[0] !== undefined && includeIfFits(includedEvidence, evidence[0])) {
    evidenceIndex = 1;
  }
  for (const entry of evidence.slice(evidenceIndex)) {
    if (includedEvidence.length >= MAX_MODEL_EVIDENCE_ITEMS) {
      break;
    }
    if (!includeIfFits(includedEvidence, entry)) {
      break;
    }
  }
  for (const item of previousItems.slice(previousIndex)) {
    if (!includeIfFits(includedPrevious, item)) {
      break;
    }
  }
  return {
    prompt: serialize(),
    includedEvidenceIds: includedEvidence.map((entry) => entry.evidenceId),
  };
}

/** Renders opaque evidence handles in caller-provided priority order with a hard bound. */
export function renderCompactionSemanticEvidenceRegistry(
  registry: CompactionSemanticEvidenceRegistry,
  maxChars = 24_000,
): string {
  if (!Number.isInteger(maxChars) || maxChars < 1_024 || maxChars > 64_000) {
    throw new Error("maxChars must be an integer between 1024 and 64000");
  }
  return renderBoundedModelContext(modelEvidenceEntries(registry), [], maxChars).prompt;
}

export interface CompactionSemanticModelContext {
  readonly prompt: string;
  readonly includedEvidenceIds: readonly string[];
}

/** Returns both the bounded prompt and the exact evidence handles shown to the model. */
export function buildCompactionSemanticModelContext(
  registry: CompactionSemanticEvidenceRegistry,
  previousState: CompactionSemanticState | undefined,
  maxChars = 24_000,
): CompactionSemanticModelContext {
  if (!Number.isInteger(maxChars) || maxChars < 1_024 || maxChars > 64_000) {
    throw new Error("maxChars must be an integer between 1024 and 64000");
  }
  return renderBoundedModelContext(
    modelEvidenceEntries(registry),
    modelPreviousSemanticItems(previousState),
    maxChars,
  );
}

/** Includes prior stable IDs/text so the model can explicitly retain or resolve known items. */
export function renderCompactionSemanticModelContext(
  registry: CompactionSemanticEvidenceRegistry,
  previousState: CompactionSemanticState | undefined,
  maxChars = 24_000,
): string {
  if (!Number.isInteger(maxChars) || maxChars < 1_024 || maxChars > 64_000) {
    throw new Error("maxChars must be an integer between 1024 and 64000");
  }
  return buildCompactionSemanticModelContext(registry, previousState, maxChars).prompt;
}

function previousItemIdentitiesByKind(
  state: CompactionSemanticState | undefined,
): Readonly<Record<(typeof COMPACTION_SEMANTIC_ITEM_KINDS)[number], ReadonlyMap<string, string>>> {
  const textItems = (
    items: readonly CompactionSemanticTextItem[] | undefined,
  ): ReadonlyMap<string, string> => new Map(items?.map((item) => [item.id, item.text]) ?? []);
  return {
    goal: new Map(
      state?.goal === null || state?.goal === undefined ? [] : [[state.goal.id, state.goal.text]],
    ),
    constraint: textItems(state?.constraints),
    decision: textItems(state?.decisions),
    completed_work: textItems(state?.completedWork),
    pending_work: textItems(state?.pendingWork),
    resource: new Map(state?.resources.map((item) => [item.id, item.resourceKey]) ?? []),
    running_session: new Map(
      state?.runningSessions.map((item) => [
        item.id,
        `${item.managerInstanceId}:${String(item.sessionId)}`,
      ]) ?? [],
    ),
    uncertainty: textItems(state?.uncertainties),
  };
}

function validatedItemId(
  suppliedId: string | null,
  kind: (typeof COMPACTION_SEMANTIC_ITEM_KINDS)[number],
  identity: string,
  provenance: readonly CompactionProvenanceRef[],
  previousIdentitiesForKind: ReadonlyMap<string, string>,
): CompactionSemanticItemId {
  const previousIdentity =
    suppliedId === null ? undefined : previousIdentitiesForKind.get(suppliedId);
  return previousIdentity !== undefined &&
    normalizedText(previousIdentity) === normalizedText(identity)
    ? compactionSemanticItemIdSchema.parse(suppliedId)
    : stableSemanticItemId(kind, identity, provenance);
}

function hasSuccessfulToolEvidence(
  entries: readonly CompactionSemanticEvidenceRegistryEntry[],
): boolean {
  return (
    entries.length === 1 &&
    entries[0]?.provenance.kind === "tool_execution" &&
    entries[0].toolOutcomeKind === TOOL_OUTCOME_KINDS.success
  );
}

function hasOnlyUserMessageEvidence(
  entries: readonly CompactionSemanticEvidenceRegistryEntry[],
): boolean {
  return (
    entries.length === 1 &&
    entries.every((entry) => entry.provenance.kind === "message" && entry.messageRole === "user")
  );
}

function quotesSupportedBySuccessfulToolEvidence(
  entries: readonly CompactionSemanticEvidenceRegistryEntry[],
  quotes: readonly string[],
): boolean {
  if (!hasSuccessfulToolEvidence(entries)) {
    return false;
  }
  return evidenceSupportsQuotes(entries, quotes);
}

function authoritativeTextFromQuotes(quotes: readonly string[], prefix?: string): string {
  const quoted = quotes
    .map((quote) => quote.replace(/^message \d+ (?:user|assistant|system|tool): /u, ""))
    .map(normalizedText)
    .join("; ");
  return boundedText(prefix === undefined ? quoted : `${prefix}: ${quoted}`, MAX_ITEM_TEXT_CHARS);
}

function isSuccessfulToolEvidence(entry: CompactionSemanticEvidenceRegistryEntry): boolean {
  return (
    entry.provenance.kind === "tool_execution" &&
    entry.toolOutcomeKind === TOOL_OUTCOME_KINDS.success
  );
}

function uniqueProvenance(
  entries: readonly CompactionSemanticEvidenceRegistryEntry[],
): readonly CompactionProvenanceRef[] {
  const unique = new Map(
    entries.map((entry) => [provenanceIdentity(entry.provenance), entry.provenance]),
  );
  return [...unique.values()];
}

function evidenceSupportsQuotes(
  entries: readonly CompactionSemanticEvidenceRegistryEntry[],
  quotes: readonly string[],
): boolean {
  const summaries = entries.map(modelFacingEvidenceSummary);
  return (
    summaries.length === quotes.length &&
    summaries.every((summary, index) => summary === quotes[index])
  );
}

/**
 * Validates a model-authored semantic candidate against Harness-owned evidence.
 * Invalid individual claims are rejected without turning the remaining grounded
 * candidate into an all-or-nothing failure.
 */
export function validateCompactionModelDraft(
  input: ValidateCompactionModelDraftInput,
): ValidatedCompactionSemanticCandidate {
  const draft = compactionModelDraftSchema.parse(input.draft);
  const previous =
    input.previousState === undefined
      ? undefined
      : compactionSemanticStateSchema.parse(input.previousState);
  const previousIdentities = previousItemIdentitiesByKind(previous);
  const previousResolutionCategories = new Map<
    string,
    CompactionSemanticResolution["targetCategory"]
  >([
    ...(previous?.constraints.map((item) => [item.id, "constraint"] as const) ?? []),
    ...(previous?.decisions.map((item) => [item.id, "decision"] as const) ?? []),
    ...(previous?.pendingWork.map((item) => [item.id, "pending_work"] as const) ?? []),
    ...(previous?.uncertainties.map((item) => [item.id, "uncertainty"] as const) ?? []),
  ]);
  const previousCompletedById = new Map(
    (previous?.completedWork ?? []).map((item) => [item.id, item]),
  );
  const evidenceById = new Map<string, CompactionSemanticEvidenceRegistryEntry>();
  for (const rawEntry of input.evidenceRegistry) {
    const entry = {
      ...rawEntry,
      provenance: compactionProvenanceRefSchema.parse(rawEntry.provenance),
    };
    if (evidenceById.has(entry.evidenceId)) {
      throw new Error(`Duplicate compaction evidence ID: ${entry.evidenceId}`);
    }
    evidenceById.set(entry.evidenceId, entry);
  }
  const presentedEvidenceIds =
    input.presentedEvidenceIds === undefined ? undefined : new Set(input.presentedEvidenceIds);
  const resolveEvidence = (
    sourceEvidenceIds: readonly string[],
  ): readonly CompactionSemanticEvidenceRegistryEntry[] | undefined => {
    if (new Set(sourceEvidenceIds).size !== sourceEvidenceIds.length) {
      return undefined;
    }
    const entries: CompactionSemanticEvidenceRegistryEntry[] = [];
    for (const sourceEvidenceId of sourceEvidenceIds) {
      if (presentedEvidenceIds !== undefined && !presentedEvidenceIds.has(sourceEvidenceId)) {
        return undefined;
      }
      const entry = evidenceById.get(sourceEvidenceId);
      if (entry === undefined) {
        return undefined;
      }
      entries.push(entry);
    }
    return entries;
  };
  const rejections: CompactionSemanticRejection[] = [];
  const coveredEvidenceIds = new Set<string>();
  const coverEvidence = (sourceEvidenceIds: readonly string[]): void => {
    for (const sourceEvidenceId of sourceEvidenceIds) {
      coveredEvidenceIds.add(sourceEvidenceId);
    }
  };
  const validateTextItems = (
    category: CompactionSemanticRejection["category"],
    kind: (typeof COMPACTION_SEMANTIC_ITEM_KINDS)[number],
    candidates: readonly z.infer<typeof modelSemanticTextItemSchema>[],
    requireSuccess: boolean,
    requireUserEvidence = false,
  ): CompactionSemanticTextItem[] => {
    const accepted: CompactionSemanticTextItem[] = [];
    candidates.forEach((candidate, index) => {
      const priorCompleted =
        requireSuccess && candidate.priorItemId !== null
          ? previousCompletedById.get(candidate.priorItemId as CompactionSemanticItemId)
          : undefined;
      if (priorCompleted !== undefined && normalizedText(candidate.text) === priorCompleted.text) {
        accepted.push(priorCompleted);
        return;
      }
      const evidenceEntries = resolveEvidence(candidate.sourceEvidenceIds);
      if (evidenceEntries === undefined) {
        rejections.push({ category, index, reason: "unknown_provenance" });
        return;
      }
      if (!evidenceSupportsQuotes(evidenceEntries, candidate.sourceQuotes)) {
        rejections.push({ category, index, reason: "unsupported_source_quote" });
        return;
      }
      if (requireUserEvidence && !hasOnlyUserMessageEvidence(evidenceEntries)) {
        rejections.push({ category, index, reason: "missing_required_provenance" });
        return;
      }
      if (
        requireSuccess &&
        !quotesSupportedBySuccessfulToolEvidence(evidenceEntries, candidate.sourceQuotes)
      ) {
        rejections.push({
          category,
          index,
          reason: "completed_work_without_success_evidence",
        });
        return;
      }
      const acceptedText = requireSuccess
        ? authoritativeTextFromQuotes(candidate.sourceQuotes, "Successful Tool evidence")
        : authoritativeTextFromQuotes(candidate.sourceQuotes);
      coverEvidence(candidate.sourceEvidenceIds);
      accepted.push(
        semanticTextItemSchema.parse({
          text: acceptedText,
          provenance: uniqueProvenance(evidenceEntries),
          sourceQuotes: [...candidate.sourceQuotes],
          id: validatedItemId(
            candidate.priorItemId,
            kind,
            acceptedText,
            uniqueProvenance(evidenceEntries),
            previousIdentities[kind],
          ),
        }),
      );
    });
    return accepted;
  };

  let modelGoal: CompactionSemanticState["goal"] = null;
  if (draft.goal !== null) {
    const evidenceEntries = resolveEvidence(draft.goal.sourceEvidenceIds);
    if (evidenceEntries === undefined) {
      rejections.push({ category: "goal", index: 0, reason: "unknown_provenance" });
    } else if (!hasOnlyUserMessageEvidence(evidenceEntries)) {
      rejections.push({ category: "goal", index: 0, reason: "missing_required_provenance" });
    } else if (!evidenceSupportsQuotes(evidenceEntries, draft.goal.sourceQuotes)) {
      rejections.push({ category: "goal", index: 0, reason: "unsupported_source_quote" });
    } else {
      const provenance = uniqueProvenance(evidenceEntries);
      coverEvidence(draft.goal.sourceEvidenceIds);
      const authoritativeText = authoritativeTextFromQuotes(draft.goal.sourceQuotes);
      modelGoal = semanticTextItemSchema.parse({
        text: authoritativeText,
        provenance,
        sourceQuotes: [...draft.goal.sourceQuotes],
        id: validatedItemId(
          draft.goal.priorItemId,
          "goal",
          authoritativeText,
          provenance,
          previousIdentities.goal,
        ),
      });
    }
  }
  const harnessGoal = input.harnessGoal;
  const harnessGoalProvenance =
    harnessGoal === undefined
      ? undefined
      : createProvenanceReference({ kind: "message", sequence: harnessGoal.sourceSequence });
  const boundedHarnessGoalText =
    harnessGoal === undefined
      ? undefined
      : boundedText(harnessGoal.verbatimRequest, MAX_ITEM_TEXT_CHARS);
  const harnessGoalState =
    harnessGoal === undefined ||
    harnessGoalProvenance === undefined ||
    boundedHarnessGoalText === undefined
      ? null
      : semanticTextItemSchema.parse({
          text: boundedHarnessGoalText,
          provenance: [harnessGoalProvenance],
          sourceQuotes: [boundedText(harnessGoal.verbatimRequest, MAX_SOURCE_QUOTE_CHARS)],
          id: validatedItemId(
            null,
            "goal",
            boundedHarnessGoalText,
            [harnessGoalProvenance],
            previousIdentities.goal,
          ),
        });
  if (harnessGoal !== undefined && (previous?.goal === null || previous?.goal === undefined)) {
    for (const entry of evidenceById.values()) {
      if (
        entry.provenance.kind === "message" &&
        entry.provenance.messageSequence === harnessGoal.sourceSequence
      ) {
        coveredEvidenceIds.add(entry.evidenceId);
      }
    }
  }
  const startsNewGoalScope =
    previous?.goal !== null &&
    previous?.goal !== undefined &&
    draft.startsNewGoalScope &&
    modelGoal !== null;
  const goal: CompactionSemanticState["goal"] = startsNewGoalScope
    ? modelGoal
    : (previous?.goal ?? harnessGoalState ?? modelGoal);

  const resources: CompactionSemanticResource[] = [];
  draft.resources.forEach((candidate, index) => {
    const evidenceEntries = resolveEvidence(candidate.sourceEvidenceIds);
    if (evidenceEntries === undefined) {
      rejections.push({ category: "resource", index, reason: "unknown_provenance" });
      return;
    }
    const resourceEntries = evidenceEntries.filter((entry) => entry.provenance.kind === "resource");
    const resourceKey = resourceEntries[0]?.provenance.resourceKey;
    if (resourceEntries.length !== 1 || resourceKey === null || resourceKey === undefined) {
      rejections.push({ category: "resource", index, reason: "resource_not_observed" });
      return;
    }
    const provenance = uniqueProvenance(evidenceEntries);
    coverEvidence(candidate.sourceEvidenceIds);
    const boundedResourceKey = boundedText(resourceKey, MAX_ITEM_TEXT_CHARS);
    resources.push(
      semanticResourceSchema.parse({
        resourceKey: boundedResourceKey,
        provenance,
        id: validatedItemId(
          candidate.priorItemId,
          "resource",
          boundedResourceKey,
          provenance,
          previousIdentities.resource,
        ),
      }),
    );
  });
  const observedResourceKeys = new Set(resources.map((resource) => resource.resourceKey));
  for (const entry of evidenceById.values()) {
    const resourceKey = entry.provenance.resourceKey;
    if (
      entry.provenance.kind !== "resource" ||
      resourceKey === null ||
      observedResourceKeys.has(resourceKey)
    ) {
      continue;
    }
    resources.push(
      semanticResourceSchema.parse({
        resourceKey: boundedText(resourceKey, MAX_ITEM_TEXT_CHARS),
        provenance: [entry.provenance],
        id: stableSemanticItemId("resource", boundedText(resourceKey, MAX_ITEM_TEXT_CHARS), [
          entry.provenance,
        ]),
      }),
    );
    observedResourceKeys.add(resourceKey);
  }

  const runningSessions: CompactionSemanticRunningSession[] = [];
  draft.runningSessions.forEach((candidate, index) => {
    const evidenceEntries = resolveEvidence(candidate.sourceEvidenceIds);
    if (evidenceEntries === undefined) {
      rejections.push({ category: "running_session", index, reason: "unknown_provenance" });
      return;
    }
    const sessionEntries = evidenceEntries.filter(
      (entry) => entry.provenance.kind === "running_session",
    );
    const sessionProvenance = sessionEntries[0]?.provenance;
    if (
      sessionEntries.length !== 1 ||
      sessionProvenance?.managerInstanceId === null ||
      sessionProvenance?.managerInstanceId === undefined ||
      sessionProvenance.sessionId === null
    ) {
      rejections.push({
        category: "running_session",
        index,
        reason: "running_session_not_observed",
      });
      return;
    }
    const identity = `${sessionProvenance.managerInstanceId}:${String(sessionProvenance.sessionId)}`;
    const provenance = uniqueProvenance(evidenceEntries);
    coverEvidence(candidate.sourceEvidenceIds);
    runningSessions.push(
      semanticRunningSessionSchema.parse({
        managerInstanceId: sessionProvenance.managerInstanceId,
        sessionId: sessionProvenance.sessionId,
        provenance,
        id: validatedItemId(
          candidate.priorItemId,
          "running_session",
          identity,
          provenance,
          previousIdentities.running_session,
        ),
      }),
    );
  });
  const observedSessions = new Set(
    runningSessions.map((session) => `${session.managerInstanceId}:${String(session.sessionId)}`),
  );
  for (const entry of evidenceById.values()) {
    const provenance = entry.provenance;
    if (
      provenance.kind !== "running_session" ||
      provenance.managerInstanceId === null ||
      provenance.sessionId === null
    ) {
      continue;
    }
    const identity = `${provenance.managerInstanceId}:${String(provenance.sessionId)}`;
    if (observedSessions.has(identity)) {
      continue;
    }
    runningSessions.push(
      semanticRunningSessionSchema.parse({
        managerInstanceId: provenance.managerInstanceId,
        sessionId: provenance.sessionId,
        provenance: [provenance],
        id: stableSemanticItemId("running_session", identity, [provenance]),
      }),
    );
    observedSessions.add(identity);
  }

  const resolutions: CompactionSemanticResolution[] = [];
  draft.resolutions.forEach((resolution, index) => {
    const actualCategory = previousResolutionCategories.get(resolution.targetItemId);
    if (actualCategory === undefined) {
      rejections.push({
        category: "resolution",
        index,
        reason: "unknown_resolution_target",
      });
      return;
    }
    if (actualCategory !== resolution.targetCategory) {
      rejections.push({
        category: "resolution",
        index,
        reason: "resolution_target_category_mismatch",
      });
      return;
    }
    const validAction =
      (actualCategory === "constraint" && resolution.action === "revoke") ||
      (actualCategory === "decision" && resolution.action === "supersede") ||
      (actualCategory === "pending_work" && resolution.action === "cancel") ||
      (actualCategory === "uncertainty" && resolution.action === "clarify");
    if (!validAction) {
      rejections.push({ category: "resolution", index, reason: "invalid_resolution_action" });
      return;
    }
    const evidenceEntries = resolveEvidence(resolution.sourceEvidenceIds);
    if (evidenceEntries === undefined) {
      rejections.push({ category: "resolution", index, reason: "unknown_provenance" });
      return;
    }
    if (!evidenceSupportsQuotes(evidenceEntries, resolution.sourceQuotes)) {
      rejections.push({ category: "resolution", index, reason: "unsupported_source_quote" });
      return;
    }
    const hasRequiredEvidence = hasOnlyUserMessageEvidence(evidenceEntries);
    if (!hasRequiredEvidence) {
      rejections.push({
        category: "resolution",
        index,
        reason: "missing_required_provenance",
      });
      return;
    }
    coverEvidence(resolution.sourceEvidenceIds);
    const provenance = uniqueProvenance(evidenceEntries);
    resolutions.push({
      targetItemId: compactionSemanticItemIdSchema.parse(resolution.targetItemId),
      targetCategory: resolution.targetCategory,
      action: resolution.action,
      reason: normalizedText(resolution.reason),
      provenance,
    });
  });

  // Validate all model-authored claims before classifying the remaining evidence.
  // Otherwise evidence already used by a valid claim would be duplicated as
  // `Unclassified evidence` in the same checkpoint.
  const candidateDecisions = validateTextItems("decision", "decision", draft.decisions, false);
  const candidateConstraints = validateTextItems(
    "constraint",
    "constraint",
    draft.constraints,
    false,
    true,
  );
  const candidateCompletedWork = validateTextItems(
    "completed_work",
    "completed_work",
    draft.completedWork,
    true,
  );
  const candidatePendingWork = validateTextItems(
    "pending_work",
    "pending_work",
    draft.pendingWork,
    false,
  );
  const candidateUncertainties = validateTextItems(
    "uncertainty",
    "uncertainty",
    draft.uncertainties,
    false,
  );

  const reviewedUncertainties: CompactionSemanticTextItem[] = [];
  const materializePresentedEvidence = (
    entry: CompactionSemanticEvidenceRegistryEntry,
    uncertaintyLabel: string,
  ): void => {
    if (isSuccessfulToolEvidence(entry)) {
      // Successful execution is already retained by the Harness-owned Tool ledger
      // and checkpoint toolState. It only becomes completed work when the model
      // explicitly cites that same successful Tool evidence and quote.
      return;
    }
    const text = boundedText(`${uncertaintyLabel}: ${entry.summary}`, MAX_ITEM_TEXT_CHARS);
    reviewedUncertainties.push(
      semanticTextItemSchema.parse({
        id: stableSemanticItemId("uncertainty", text, [entry.provenance]),
        text,
        provenance: [entry.provenance],
        sourceQuotes: [boundedText(entry.summary, MAX_SOURCE_QUOTE_CHARS)],
      }),
    );
  };
  draft.evidenceReviews.forEach((review, index) => {
    const entry = evidenceById.get(review.evidenceId);
    if (entry === undefined) {
      rejections.push({ category: "evidence_review", index, reason: "unknown_evidence_review" });
      return;
    }
    coveredEvidenceIds.add(review.evidenceId);
    if (entry.provenance.kind !== "message" && entry.provenance.kind !== "tool_execution") {
      return;
    }
    if (review.disposition === "irrelevant" && entry.messageRole === "assistant") {
      return;
    }
    materializePresentedEvidence(
      entry,
      review.disposition === "uncertain"
        ? "Unresolved evidence"
        : "User or Tool evidence classified as irrelevant",
    );
  });

  for (const evidenceId of input.presentedEvidenceIds ?? []) {
    if (coveredEvidenceIds.has(evidenceId)) {
      continue;
    }
    const entry = evidenceById.get(evidenceId);
    if (
      entry === undefined ||
      (entry.provenance.kind !== "message" && entry.provenance.kind !== "tool_execution")
    ) {
      continue;
    }
    materializePresentedEvidence(entry, "Unclassified evidence");
    coveredEvidenceIds.add(evidenceId);
  }

  const boundedConstraints = takeNewestWithinLimit(candidateConstraints, MAX_CONSTRAINTS);
  const boundedDecisions = takeNewestWithinLimit(candidateDecisions, MAX_DECISIONS);
  const boundedCompletedWork = takeNewestWithinLimit(candidateCompletedWork, MAX_COMPLETED_WORK);
  const boundedPendingWork = takeNewestWithinLimit(candidatePendingWork, MAX_PENDING_WORK);
  const boundedResources = takeNewestWithinLimit(resources, MAX_RESOURCES);
  const boundedRunningSessions = takeNewestWithinLimit(runningSessions, MAX_RUNNING_SESSIONS);
  const boundedUncertainties = takeNewestWithinLimit(
    [...candidateUncertainties, ...reviewedUncertainties],
    MAX_UNCERTAINTIES,
  );

  return {
    state: compactionSemanticStateSchema.parse({
      version: COMPACTION_SEMANTIC_STATE_VERSION,
      goal,
      constraints: boundedConstraints.items,
      decisions: boundedDecisions.items,
      completedWork: boundedCompletedWork.items,
      pendingWork: boundedPendingWork.items,
      resources: boundedResources.items,
      runningSessions: boundedRunningSessions.items,
      uncertainties: boundedUncertainties.items,
      prunedItemCounts: {
        constraint: boundedConstraints.prunedCount,
        decision: boundedDecisions.prunedCount,
        completed_work: boundedCompletedWork.prunedCount,
        pending_work: boundedPendingWork.prunedCount,
        resource: boundedResources.prunedCount,
        running_session: boundedRunningSessions.prunedCount,
        uncertainty: boundedUncertainties.prunedCount,
      },
    }),
    resolutions,
    rejections,
    coveredEvidenceIds: [...coveredEvidenceIds],
    startsNewGoalScope,
  };
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

/** Seeds V1/top-level constraint evidence into the V2 semantic state without language heuristics. */
export function seedCompactionSemanticConstraints(
  stateInput: CompactionSemanticState | undefined,
  constraints: readonly { readonly quote: string; readonly sourceSequence: number }[],
): CompactionSemanticState {
  const state =
    stateInput === undefined
      ? createEmptyCompactionSemanticState()
      : compactionSemanticStateSchema.parse(stateInput);
  const seeded = semanticConstraintsFromEvidence(constraints);
  const mergedConstraints = mergeBoundedById(state.constraints, seeded, new Set(), MAX_CONSTRAINTS);
  return boundCompactionSemanticState(
    compactionSemanticStateSchema.parse({
      ...state,
      constraints: mergedConstraints.items,
      prunedItemCounts: {
        ...state.prunedItemCounts,
        constraint: state.prunedItemCounts.constraint + mergedConstraints.prunedCount,
      },
    }),
  );
}

export interface LegacyCompactionSnapshotMigrationResult {
  readonly state: CompactionSemanticState;
  /** Every migrated fragment must remain visible in the first V2 checkpoint reminder. */
  readonly requiredItemIds: readonly CompactionSemanticItemId[];
  /** Exact, redacted fragments that must be archived in transcript when V1 is retired. */
  readonly transcriptFragments: LegacyCompactionTranscriptFragments;
  /** False means at least one legacy snapshot chunk did not fit and its active prefix must stay. */
  readonly complete: boolean;
}

function exactTextChunks(value: string, maxCodeUnits: number): readonly string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (current.length > 0 && current.length + character.length > maxCodeUnits) {
      const excerpt = current.trim();
      if (excerpt.length > 0) {
        chunks.push(excerpt);
      }
      current = character;
      continue;
    }
    current += character;
  }
  const excerpt = current.trim();
  if (excerpt.length > 0) {
    chunks.push(excerpt);
  }
  return chunks;
}

/**
 * Migrates an old active snapshot into low-confidence V2 state. It may only become uncertainty:
 * legacy prose is not authoritative user intent or Tool completion evidence.
 */
export function seedLegacyCompactionSnapshotUncertainties(
  stateInput: CompactionSemanticState,
  input: {
    readonly checkpointId: string;
    readonly fragments: readonly string[];
  },
): LegacyCompactionSnapshotMigrationResult {
  const state = compactionSemanticStateSchema.parse(stateInput);
  const chunks = input.fragments.flatMap((fragment) =>
    exactTextChunks(fragment, MAX_SOURCE_QUOTE_CHARS),
  );
  if (chunks.length === 0) {
    return { state, requiredItemIds: [], transcriptFragments: [], complete: true };
  }
  const candidates = chunks.map((sourceQuote, index): CompactionSemanticTextItem => {
    const provenance = createProvenanceReference({
      kind: "legacy_snapshot",
      checkpointId: input.checkpointId,
      snapshotIndex: index,
    });
    const text = boundedText(
      `Unverified legacy V1 active snapshot; confirm before acting: ${sourceQuote}`,
      MAX_ITEM_TEXT_CHARS,
    );
    return semanticTextItemSchema.parse({
      id: stableSemanticItemId("uncertainty", text, [provenance]),
      text,
      provenance: [provenance],
      sourceQuotes: [sourceQuote],
    });
  });
  const merged = mergeBoundedById(state.uncertainties, candidates, new Set(), MAX_UNCERTAINTIES);
  const bounded = boundCompactionSemanticState(
    compactionSemanticStateSchema.parse({
      ...state,
      uncertainties: merged.items,
      prunedItemCounts: {
        ...state.prunedItemCounts,
        uncertainty: state.prunedItemCounts.uncertainty + merged.prunedCount,
      },
    }),
  );
  const retainedIds = new Set(bounded.uncertainties.map((item) => item.id));
  const complete = candidates.every((candidate) => retainedIds.has(candidate.id));
  return {
    state: bounded,
    requiredItemIds: candidates.map((candidate) => candidate.id),
    transcriptFragments: complete
      ? legacyCompactionTranscriptFragmentsSchema.parse(chunks)
      : legacyCompactionTranscriptFragmentsSchema.parse([]),
    complete,
  };
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

function mergeBoundedById<T extends { readonly id: CompactionSemanticItemId }>(
  previous: readonly T[],
  candidate: readonly T[],
  resolved: ReadonlySet<string>,
  limit: number,
): { readonly items: T[]; readonly prunedCount: number } {
  const merged = new Map<string, T>();
  for (const item of previous) {
    if (!resolved.has(item.id)) {
      merged.set(item.id, item);
    }
  }
  for (const item of candidate) {
    if (!resolved.has(item.id)) {
      merged.set(item.id, item);
    }
  }
  return takeNewestWithinLimit([...merged.values()], limit);
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

/**
 * Carries grounded state forward. Empty candidate arrays do not erase history;
 * removal requires an evidence-grounded, category-specific explicit resolution.
 */
export function mergeCompactionSemanticState(
  previousInput: CompactionSemanticState | undefined,
  candidateInput: ValidatedCompactionSemanticCandidate,
  options: MergeCompactionSemanticStateOptions,
): CompactionSemanticState {
  const previous =
    previousInput === undefined
      ? createEmptyCompactionSemanticState()
      : compactionSemanticStateSchema.parse(previousInput);
  const candidate = compactionSemanticStateSchema.parse(candidateInput.state);
  const resolvedConstraints = new Set(
    candidateInput.resolutions
      .filter((resolution) => resolution.targetCategory === "constraint")
      .map((resolution) => resolution.targetItemId),
  );
  const resolvedDecisions = new Set(
    candidateInput.resolutions
      .filter((resolution) => resolution.targetCategory === "decision")
      .map((resolution) => resolution.targetItemId),
  );
  const resolvedPendingWork = new Set(
    candidateInput.resolutions
      .filter((resolution) => resolution.targetCategory === "pending_work")
      .map((resolution) => resolution.targetItemId),
  );
  const resolvedUncertainties = new Set(
    candidateInput.resolutions
      .filter((resolution) => resolution.targetCategory === "uncertainty")
      .map((resolution) => resolution.targetItemId),
  );
  const startsNewGoalScope = options.startsNewGoalScope && candidateInput.startsNewGoalScope;
  const constraints = mergeBoundedById(
    previous.constraints,
    candidate.constraints,
    resolvedConstraints,
    MAX_CONSTRAINTS,
  );
  const decisions = mergeBoundedById(
    previous.decisions,
    candidate.decisions,
    resolvedDecisions,
    MAX_DECISIONS,
  );
  const completedWork = mergeBoundedById(
    previous.completedWork,
    candidate.completedWork,
    new Set(),
    MAX_COMPLETED_WORK,
  );
  const pendingWork = mergeBoundedById(
    previous.pendingWork,
    candidate.pendingWork,
    resolvedPendingWork,
    MAX_PENDING_WORK,
  );
  const resources = mergeBoundedById(
    previous.resources,
    candidate.resources,
    new Set(),
    MAX_RESOURCES,
  );
  const uncertainties = mergeBoundedById(
    previous.uncertainties,
    candidate.uncertainties,
    resolvedUncertainties,
    MAX_UNCERTAINTIES,
  );
  return boundCompactionSemanticState(
    compactionSemanticStateSchema.parse({
      version: COMPACTION_SEMANTIC_STATE_VERSION,
      goal: startsNewGoalScope
        ? candidate.goal
        : candidate.goal !== null
          ? candidate.goal
          : previous.goal,
      constraints: constraints.items,
      decisions: decisions.items,
      completedWork: completedWork.items,
      pendingWork: pendingWork.items,
      resources: resources.items,
      runningSessions: candidate.runningSessions.slice(-MAX_RUNNING_SESSIONS),
      uncertainties: uncertainties.items,
      prunedItemCounts: {
        constraint:
          previous.prunedItemCounts.constraint +
          candidate.prunedItemCounts.constraint +
          constraints.prunedCount,
        decision:
          previous.prunedItemCounts.decision +
          candidate.prunedItemCounts.decision +
          decisions.prunedCount,
        completed_work:
          previous.prunedItemCounts.completed_work +
          candidate.prunedItemCounts.completed_work +
          completedWork.prunedCount,
        pending_work:
          previous.prunedItemCounts.pending_work +
          candidate.prunedItemCounts.pending_work +
          pendingWork.prunedCount,
        resource:
          previous.prunedItemCounts.resource +
          candidate.prunedItemCounts.resource +
          resources.prunedCount,
        running_session:
          previous.prunedItemCounts.running_session + candidate.prunedItemCounts.running_session,
        uncertainty:
          previous.prunedItemCounts.uncertainty +
          candidate.prunedItemCounts.uncertainty +
          uncertainties.prunedCount,
      },
    }),
  );
}

function boundedText(value: string, maxChars: number): string {
  const normalized = normalizedText(value);
  const characters = [...normalized];
  return characters.length <= maxChars
    ? normalized
    : `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
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
      sourceQuotes: item.sourceQuotes.map((quote) => boundedText(quote, MAX_SOURCE_QUOTE_CHARS)),
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
  const candidates = semanticReminderItems(state);
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
        selected.filter((item) => item.category === category).length,
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

  const maxDepth = Math.max(0, ...[...byCategory.values()].map((items) => items.length));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const category of priority) {
      const items = byCategory.get(category) ?? [];
      const candidate = items.at(-(depth + 1));
      if (candidate === undefined) {
        continue;
      }
      selected.push(candidate);
      if (JSON.stringify(project()).length > maxChars) {
        selected.pop();
      }
    }
  }
  const projection = project();
  if (JSON.stringify(projection).length > maxChars) {
    throw new Error("Unable to create bounded semantic reminder projection");
  }
  return projection;
}

/** Renders a deterministic, bounded presentation derived only from grounded state. */
export function renderCompactionSemanticSummary(
  stateInput: CompactionSemanticState,
  maxChars = DEFAULT_SUMMARY_MAX_CHARS,
): string {
  if (!Number.isInteger(maxChars) || maxChars < 1_024 || maxChars > 32_000) {
    throw new Error("maxChars must be an integer between 1024 and 32000");
  }
  const state = compactionSemanticStateSchema.parse(stateInput);
  const projection = createCompactionSemanticReminderProjection(state, maxChars);
  const titles = {
    goal: "Goal",
    constraint: "Active constraints",
    pending_work: "Pending work",
    uncertainty: "Uncertainties",
    decision: "Decisions",
    resource: "Resources",
    completed_work: "Completed work",
  } as const satisfies Record<(typeof COMPACTION_RECOVERY_PRIORITY)[number], string>;
  const omittedCounts = projection.omittedCounts;
  const allLines = [
    "Evidence-grounded structured compaction state:",
    "Each semantic item is a classification; its source quote is the authoritative wording.",
  ];
  for (const category of COMPACTION_RECOVERY_PRIORITY) {
    allLines.push(`${titles[category]}:`);
    const items = projection.items.filter((item) => item.category === category);
    if (items.length === 0) {
      allLines.push("- (none retained in prompt projection)");
    } else {
      allLines.push(
        ...items.map((item) => {
          const source = item.sourceQuotes
            .map((quote) => boundedText(quote, MAX_SUMMARY_ITEM_CHARS))
            .join(" | ");
          return `- [${item.itemId}] interpretation=${boundedText(item.text, MAX_SUMMARY_ITEM_CHARS)}; source=${source}`;
        }),
      );
    }
    if (omittedCounts[category] > 0) {
      allLines.push(
        `- … ${String(omittedCounts[category])} item(s) omitted; use transcript evidence`,
      );
    }
  }
  const truncationMarker = "\n… summary truncated";
  const budget = maxChars - [...truncationMarker].length;
  const included: string[] = [];
  for (const line of allLines) {
    const candidate = [...included, line].join("\n");
    if ([...candidate].length > budget) {
      break;
    }
    included.push(line);
  }
  const rendered = included.join("\n");
  return included.length === allLines.length ? rendered : `${rendered}${truncationMarker}`;
}
