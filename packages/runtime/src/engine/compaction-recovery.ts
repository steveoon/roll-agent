import { randomUUID } from "node:crypto";
import { z } from "zod";
import { wrapLanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { compactionSemanticEvidenceWatermarksSchema } from "./compaction-checkpoint.ts";
import {
  compareBudgetOnBasis,
  requestBudgetSnapshotSchema,
  type RequestBudgetSnapshot,
} from "./request-budget.ts";

// Installation proves only committed history/coverage. The next actual SDK
// preparation supplies the owning pass's finalized comparison and readiness.
export const compactionPassResultSchema = z
  .object({
    stage: z.enum(["installed", "no_commit"]),
    historyChanged: z.boolean(),
    coverageBefore: compactionSemanticEvidenceWatermarksSchema,
    coverageAfter: compactionSemanticEvidenceWatermarksSchema,
    checkpointId: z.string().optional(),
    checkpointGeneration: z.number().int().positive().optional(),
  })
  .readonly();
export type CompactionPassResult = z.infer<typeof compactionPassResultSchema>;

export function compactionPassProgressed(result: CompactionPassResult): boolean {
  return (
    result.historyChanged ||
    result.coverageAfter.messagesThroughSequence > result.coverageBefore.messagesThroughSequence ||
    result.coverageAfter.toolExecutionsThroughSequence >
      result.coverageBefore.toolExecutionsThroughSequence
  );
}

export const maintenanceObservationSchema = z
  .object({
    episodeId: z.string(),
    owner: z.string(),
    deadline: z.number(),
    maxDraftCalls: z.number(),
    maxPasses: z.number(),
    maxPreparations: z.number(),
    draftCalls: z.number(),
    passes: z.number(),
    preparations: z.number(),
    yields: z.number(),
    stage: z.enum(["working", "installed", "no_commit", "verified", "closed"]),
    checkpointId: z.string().optional(),
    installation: compactionPassResultSchema.optional(),
    passBefore: requestBudgetSnapshotSchema.optional(),
    before: requestBudgetSnapshotSchema,
    after: requestBudgetSnapshotSchema.optional(),
    localSavedTokens: z.number().optional(),
    aggregateSavedTokens: z.number().optional(),
    materialSpaceProgress: z.boolean(),
    coverageProgress: z.boolean(),
    reason: z.string().optional(),
  })
  .readonly();
export type MaintenanceObservation = z.infer<typeof maintenanceObservationSchema>;
export class MaintenanceLimitError extends Error {
  constructor(reason: string) {
    super(`context_maintenance_limit:${reason}`);
  }
}

/** One absolute episode budget, including deterministic passes and denied SDK preparations. */
export class MaintenanceEpisode {
  private state: MaintenanceObservation;
  private readonly seen = new Map<string, number>();
  private currentFingerprint: string | undefined;
  private workStopped = false;
  private lastBudget: RequestBudgetSnapshot;
  constructor(
    owner: string,
    before: RequestBudgetSnapshot,
    backlog: { readonly messages: number; readonly tools: number },
    timeoutMs: number,
    turnDeadline?: number,
  ) {
    const maxDraftCalls = Math.min(
      32,
      Math.max(4, Math.max(Math.ceil(backlog.messages / 15), Math.ceil(backlog.tools / 15)) + 2),
    );
    this.state = {
      episodeId: randomUUID(),
      owner,
      before,
      deadline: Math.min(Date.now() + timeoutMs, turnDeadline ?? Infinity),
      maxDraftCalls,
      maxPasses: maxDraftCalls + 2,
      maxPreparations: maxDraftCalls + 2,
      draftCalls: 0,
      passes: 0,
      preparations: 1,
      yields: 0,
      stage: "verified",
      materialSpaceProgress: false,
      coverageProgress: false,
    };
    this.lastBudget = before;
  }
  remainingMs(): number {
    return Math.max(0, this.state.deadline - Date.now());
  }
  verify(budget: RequestBudgetSnapshot): void {
    if (this.state.preparations >= this.state.maxPreparations) {
      throw new MaintenanceLimitError("preparations");
    }
    const comparable = compareBudgetOnBasis(budget, this.state.before.calibrationResidual);
    const aggregate =
      this.state.before.calibratedInputEstimate - comparable.calibratedInputEstimate;
    const materialThreshold = Math.min(
      Math.max(256, Math.ceil(this.state.before.calibratedInputEstimate * 0.005)),
      Math.max(1, Math.ceil((this.state.before.window ?? Infinity) * 0.05)),
    );
    this.state = {
      ...this.state,
      stage: "verified",
      after: comparable,
      preparations: this.state.preparations + 1,
      localSavedTokens:
        this.lastBudget.calibratedInputEstimate - comparable.calibratedInputEstimate,
      aggregateSavedTokens: aggregate,
      materialSpaceProgress:
        aggregate >= materialThreshold &&
        budget.rawInputEstimate < this.state.before.rawInputEstimate,
    };
    this.lastBudget = comparable;
  }
  canWork(fingerprint: string): boolean {
    return this.workBlockReason(fingerprint) === undefined;
  }
  workBlockReason(fingerprint: string): string | undefined {
    if (
      this.workStopped ||
      this.remainingMs() === 0 ||
      this.state.passes >= this.state.maxPasses ||
      this.state.preparations >= this.state.maxPreparations - 1
    ) {
      return "maintenance_budget_exhausted";
    }
    if ((this.seen.get(fingerprint) ?? 0) >= 2) return "maintenance_no_progress";
    return undefined;
  }
  beginPass(fingerprint: string): boolean {
    if (!this.canWork(fingerprint)) throw new MaintenanceLimitError("work_allowance");
    const repeated = (this.seen.get(fingerprint) ?? 0) > 0;
    this.seen.set(fingerprint, (this.seen.get(fingerprint) ?? 0) + 1);
    this.currentFingerprint = fingerprint;
    const {
      after: _after,
      localSavedTokens: _local,
      aggregateSavedTokens: _aggregate,
      checkpointId: _checkpointId,
      installation: _installation,
      ...rest
    } = this.state;
    this.state = {
      ...rest,
      passes: this.state.passes + 1,
      stage: "working",
      passBefore: this.lastBudget,
      materialSpaceProgress: false,
    };
    return repeated;
  }
  installed(coverageProgress: boolean, checkpointId?: string): void {
    this.state = {
      ...this.state,
      coverageProgress,
      stage: checkpointId === undefined ? "no_commit" : "installed",
      ...(checkpointId === undefined ? {} : { checkpointId }),
    };
  }
  install(result: CompactionPassResult): void {
    this.installed(
      result.coverageAfter.messagesThroughSequence >
        result.coverageBefore.messagesThroughSequence ||
        result.coverageAfter.toolExecutionsThroughSequence >
          result.coverageBefore.toolExecutionsThroughSequence,
      result.checkpointId,
    );
    this.state = { ...this.state, installation: result };
  }
  recordFallback(): void {
    if (this.currentFingerprint !== undefined) this.seen.set(this.currentFingerprint, 2);
  }
  stopWork(reason: string): void {
    this.workStopped = true;
    this.state = { ...this.state, reason };
  }
  async yieldQuantum(): Promise<void> {
    if (this.state.passes > 0 && this.state.passes % 4 === 0) {
      this.state = { ...this.state, yields: this.state.yields + 1 };
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  close(reason: string): void {
    this.state = { ...this.state, stage: "closed", reason };
  }
  view(): MaintenanceObservation {
    return structuredClone(this.state);
  }
  meter(model: LanguageModelV4, signal?: AbortSignal): LanguageModelV4 {
    const admit = (): void => {
      if (signal?.aborted) throw signal.reason;
      if (
        this.workStopped ||
        this.remainingMs() === 0 ||
        this.state.draftCalls >= this.state.maxDraftCalls
      ) {
        throw new MaintenanceLimitError("draft_budget");
      }
      this.state = { ...this.state, draftCalls: this.state.draftCalls + 1 };
    };
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate }) => {
          admit();
          return doGenerate();
        },
        wrapStream: async ({ doStream }) => {
          admit();
          return doStream();
        },
      },
    });
  }
}
