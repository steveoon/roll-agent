import { createHash } from "node:crypto";
import { z } from "zod";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";

const count = z.number().finite().nonnegative();
export const requestBudgetSnapshotSchema = z
  .object({
    accountingVersion: z.literal(1),
    estimated: z.literal(true),
    provider: z.string(),
    model: z.string(),
    window: count.optional(),
    windowSource: z.enum(["override", "catalog", "rule", "unknown"]),
    fingerprint: z.string(),
    shapeFingerprint: z.string(),
    systemTokens: count,
    messageTokens: count,
    toolTokens: count,
    optionTokens: count,
    rawInputEstimate: count,
    calibratedInputEstimate: count,
    calibrationResidual: z.number().finite(),
    latestMeasuredInput: count.optional(),
    measurementMatched: z.boolean(),
    opaqueOrMultimodal: z.boolean(),
    outputReserve: count,
    errorReserve: count,
    availableInputCeiling: count.optional(),
    maintenanceTarget: count.optional(),
  })
  .readonly();
export type RequestBudgetSnapshot = z.infer<typeof requestBudgetSnapshotSchema>;
export interface RequestBudgetSettings {
  readonly provider: string;
  readonly model: string;
  readonly window?: number;
  readonly windowSource?: RequestBudgetSnapshot["windowSource"];
  readonly threshold?: number;
}

// Count actual provider-neutral content, not disk JSON size or a second SDK conversion.
// Non-text/opaque representations are deliberately heuristic. No values survive in snapshots.
function canonical(value: unknown): string {
  if (value instanceof Uint8Array) {
    return JSON.stringify({
      binarySha256: createHash("sha256").update(value).digest("hex"),
      bytes: value.byteLength,
    });
  }
  if (value instanceof URL) return JSON.stringify(value.href);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function requestDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function estimate(value: unknown): { tokens: number; opaque: boolean } {
  if (value === undefined || value === null) return { tokens: 0, opaque: false };
  if (value instanceof Uint8Array || value instanceof URL) return { tokens: 2048, opaque: true };
  if (typeof value === "string") {
    return { tokens: Math.ceil(Buffer.byteLength(value, "utf8") / 3.5), opaque: false };
  }
  if (Array.isArray(value)) {
    const parts = value.map(estimate);
    return {
      tokens: parts.reduce((sum, p) => sum + p.tokens + 2, 0),
      opaque: parts.some((p) => p.opaque),
    };
  }
  if (typeof value === "object") {
    if ("type" in value && (value.type === "image" || value.type === "file")) {
      return { tokens: value.type === "image" ? 2048 : 4096, opaque: true };
    }
    const parts = Object.entries(value).map(([key, item]) => ({ ...estimate(item), key }));
    return {
      tokens: parts.reduce((sum, p) => sum + p.tokens + Math.ceil(p.key.length / 3.5) + 2, 0),
      opaque: parts.some((p) => p.opaque || /encrypted|signature|fileId/i.test(p.key)),
    };
  }
  return { tokens: Math.ceil(String(value).length / 3.5), opaque: false };
}

// An opaque payload's byte/token relationship cannot be carried over to different
// opaque content (or to ordinary text replacing it). Keep only digests in the shape.
function opaqueCalibrationShape(value: unknown): readonly string[] {
  if (value instanceof Uint8Array || value instanceof URL) return [requestDigest(value)];
  if (Array.isArray(value)) return value.flatMap(opaqueCalibrationShape);
  if (typeof value !== "object" || value === null) return [];
  if ("type" in value && (value.type === "image" || value.type === "file")) {
    return [requestDigest(value)];
  }
  return Object.entries(value).flatMap(([key, item]) =>
    /encrypted|signature|fileId/i.test(key)
      ? [requestDigest({ key, item })]
      : opaqueCalibrationShape(item),
  );
}
export function estimatePreparedRequest(
  params: LanguageModelV4CallOptions,
  settings: RequestBudgetSettings,
  residual: number,
  shapeContext = "",
  latestMeasuredInput?: number,
  measurementMatched = false,
): RequestBudgetSnapshot {
  const system = estimate(params.prompt.filter((m) => m.role === "system"));
  const messages = estimate(params.prompt.filter((m) => m.role !== "system"));
  const tools = estimate(params.tools);
  const options = {
    providerOptions: params.providerOptions,
    responseFormat: params.responseFormat,
    toolChoice: params.toolChoice,
    reasoning: params.reasoning,
  };
  const extra = estimate(options);
  const raw = system.tokens + messages.tokens + tools.tokens + extra.tokens;
  const window = settings.window;
  const outputReserve =
    window === undefined
      ? (params.maxOutputTokens ?? 0)
      : Math.max(
          params.maxOutputTokens ?? 0,
          Math.min(8192, Math.max(1, Math.floor(window * 0.05))),
        );
  const errorReserve = window === undefined ? 0 : Math.max(1, Math.ceil(window * 0.02));
  const ceiling =
    window === undefined ? undefined : Math.max(0, window - outputReserve - errorReserve);
  return requestBudgetSnapshotSchema.parse({
    accountingVersion: 1,
    estimated: true,
    ...settings,
    windowSource: window === undefined ? "unknown" : (settings.windowSource ?? "override"),
    fingerprint: requestDigest({
      ...settings,
      prompt: params.prompt,
      tools: params.tools,
      options,
      maxOutputTokens: params.maxOutputTokens,
      shapeContext,
    }),
    shapeFingerprint: requestDigest({
      provider: settings.provider,
      model: settings.model,
      system: params.prompt.filter((m) => m.role === "system"),
      tools: params.tools,
      options,
      shapeContext,
      opaqueContent: opaqueCalibrationShape(params.prompt),
    }),
    systemTokens: system.tokens,
    messageTokens: messages.tokens,
    toolTokens: tools.tokens,
    optionTokens: extra.tokens,
    rawInputEstimate: raw,
    calibrationResidual: residual,
    calibratedInputEstimate: Math.max(0, raw + residual),
    ...(latestMeasuredInput === undefined ? {} : { latestMeasuredInput }),
    measurementMatched,
    opaqueOrMultimodal: system.opaque || messages.opaque || tools.opaque || extra.opaque,
    outputReserve,
    errorReserve,
    ...(ceiling === undefined
      ? {}
      : {
          availableInputCeiling: ceiling,
          maintenanceTarget: Math.min(ceiling, Math.floor(window! * (settings.threshold ?? 0.75))),
        }),
  });
}

export interface RequestBudgetComparison {
  readonly before: RequestBudgetSnapshot;
  readonly after?: RequestBudgetSnapshot;
  readonly savedTokens?: number;
  readonly spaceImproved?: boolean;
}
export const CONTEXT_MAINTENANCE_REASONS = [
  "budget",
  "soft_target",
  "shape_changed",
  "provider_rejected",
] as const;
export class ContextMaintenanceRequired extends Error {
  readonly budget: RequestBudgetSnapshot;
  readonly reason: (typeof CONTEXT_MAINTENANCE_REASONS)[number];
  constructor(budget: RequestBudgetSnapshot, reason: ContextMaintenanceRequired["reason"]) {
    super(`context_maintenance_required:${reason}`);
    this.budget = budget;
    this.reason = reason;
  }
}

/** Numeric process-local accounting; durable diagnostic transport belongs to Task 4. */
export class RequestBudgetTracker {
  private measurement:
    | { budget: RequestBudgetSnapshot; input: number; residual: number }
    | undefined;
  private pending: { budget: RequestBudgetSnapshot; owner: string } | undefined;
  private comparison: RequestBudgetComparison | undefined;
  private last: RequestBudgetSnapshot | undefined;
  private prepared = 0;
  private dispatched = 0;
  prepare(
    params: LanguageModelV4CallOptions,
    settings: RequestBudgetSettings,
    context: string,
    owner = "local",
  ): RequestBudgetSnapshot {
    const raw = estimatePreparedRequest(params, settings, 0, context, this.measurement?.input);
    const matched = this.measurement?.budget.shapeFingerprint === raw.shapeFingerprint;
    const pending = this.pending?.owner === owner ? this.pending : undefined;
    // Admission follows the latest compatible measurement, including overestimation.
    // Scale a negative correction down when history shrinks: a fixed negative offset
    // must never make a smaller, otherwise unknown request appear free.
    const measurement = matched ? this.measurement : undefined;
    const residual =
      measurement === undefined
        ? 0
        : measurement.residual *
          (measurement.residual < 0
            ? Math.min(1, raw.rawInputEstimate / Math.max(1, measurement.budget.rawInputEstimate))
            : 1);
    const budget = {
      ...raw,
      calibrationResidual: residual,
      calibratedInputEstimate: Math.max(0, raw.rawInputEstimate + residual),
      measurementMatched: matched,
    };
    this.prepared += 1;
    this.last = budget;
    if (pending !== undefined) {
      // Progress uses one frozen basis; a shape change invalidating admission
      // calibration must not manufacture compression savings.
      const basis = pending.budget.calibrationResidual;
      const before = compareBudgetOnBasis(pending.budget, basis);
      const after = compareBudgetOnBasis(budget, basis);
      const saved = before.calibratedInputEstimate - after.calibratedInputEstimate;
      this.comparison = {
        before,
        after,
        savedTokens: saved,
        spaceImproved: saved > 0 && budget.rawInputEstimate < before.rawInputEstimate,
      };
      this.pending = undefined;
    }
    return budget;
  }
  beginMaintenance(before: RequestBudgetSnapshot, owner = "local"): void {
    this.pending = { budget: before, owner };
    this.comparison = { before };
  }
  abandonMaintenance(owner: string): void {
    if (this.pending?.owner === owner) this.pending = undefined;
  }
  /** Approximate post-step predictor: actual prepared overhead + production-projected message delta.
   * No schema resolver/download is repeated; final prepare remains the dispatch authority. */
  predict(
    messages: readonly import("ai").ModelMessage[],
    baselineMessages: number,
  ): number | undefined {
    const last = this.last;
    if (last === undefined) return undefined;
    const projected = estimate(messages).tokens;
    const measurement = this.measurement;
    const compatible = measurement?.budget.shapeFingerprint === last.shapeFingerprint;
    return Math.max(
      0,
      (compatible ? measurement.input : last.calibratedInputEstimate) +
        projected -
        baselineMessages,
    );
  }
  projectedMessageTokens(messages: readonly import("ai").ModelMessage[]): number {
    return estimate(messages).tokens;
  }
  dispatchedRequest(): void {
    this.dispatched += 1;
  }
  measured(budget: RequestBudgetSnapshot, input: number | undefined): void {
    if (input === undefined || !Number.isFinite(input) || input < 0 || this.pending !== undefined) {
      return;
    }
    this.measurement = { budget, input, residual: input - budget.rawInputEstimate };
  }
  view() {
    return structuredClone({
      last: this.last,
      comparison: this.comparison,
      preparedAttempts: this.prepared,
      providerCalls: this.dispatched,
    });
  }
}

/** Comparison only. Never reuse this frozen basis as admission calibration. */
export function compareBudgetOnBasis(
  budget: RequestBudgetSnapshot,
  residual: number,
): RequestBudgetSnapshot {
  return {
    ...budget,
    calibrationResidual: residual,
    calibratedInputEstimate: Math.max(0, budget.rawInputEstimate + residual),
  };
}
