import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";

export const ReadTaskSchema = z
  .object({
    target: z.string().min(1).max(500),
    captureView: z
      .string()
      .min(1)
      .max(500)
      .describe("必须真正查看的目标视图，例如目标记录的只读详情；不是点击路径。"),
    outputs: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(8)
      .refine((items) => new Set(items).size === items.length, "Output names must be unique"),
    terminal: z
      .object({
        view: z.string().min(1).max(500),
        selectedTab: z.string().min(1).max(100).optional(),
      })
      .strict(),
  })
  .strict();
export type ReadTask = z.infer<typeof ReadTaskSchema>;

export const ReadRegionSchema = z.object({
  id: z.string(),
  name: z.string(),
  text: z.string().max(16000),
  kind: z.enum(["panel", "content"]),
  truncated: z.boolean(),
});
export const ReadDocumentSchema = z.object({
  frameId: z.string(),
  url: z.string(),
  panelsComplete: z.boolean(),
  observedAt: z.string().datetime(),
  regions: z.array(ReadRegionSchema).max(4),
});
export type ReadDocument = z.infer<typeof ReadDocumentSchema>;
export const CapturedEvidenceSchema = z.object({
  id: z.string(),
  field: z.string(),
  text: z.string().max(4096),
  observationId: z.string(),
  documentId: z.string(),
  frameId: z.string(),
  url: z.string(),
  regionId: z.string(),
  regionName: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  observedAt: z.string(),
  attribution: z.literal("model-selected-observed-text"),
});
export const TaskProgressSchema = z.object({
  taskRunId: z.string(),
  contractDigest: z.string(),
  phase: z.enum(["collect", "return", "done"]),
  evidence: z.array(CapturedEvidenceSchema).max(8),
  invalidatedEvidence: z.array(CapturedEvidenceSchema).max(16),
  missing: z.array(z.string()),
  capturedRegion: z
    .object({
      documentId: z.string(),
      frameId: z.string(),
      url: z.string(),
      id: z.string(),
      name: z.string(),
      digest: z.string(),
    })
    .optional(),
  conflicts: z.number().int().nonnegative(),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;
export const digestText = (text: string): string => createHash("sha256").update(text).digest("hex");
export function createTaskProgress(contract: ReadTask): TaskProgress {
  return {
    taskRunId: randomUUID(),
    contractDigest: digestText(JSON.stringify(contract)),
    phase: "collect",
    evidence: [],
    invalidatedEvidence: [],
    missing: [...contract.outputs],
    conflicts: 0,
  };
}

/** Historical quotes survive closing a region. A changed, still-present region must be recaptured. */
export function reconcileTaskProgress(
  progress: TaskProgress,
  contract: ReadTask,
  documentId: string,
  documents: readonly ReadDocument[],
): boolean {
  const captured = progress.capturedRegion;
  if (!captured || progress.phase === "collect" || documentId !== captured.documentId) return false;
  const doc = documents.find((doc) => doc.frameId === captured.frameId && doc.url === captured.url);
  const region = doc?.regions.find((region) => region.id === captured.id);
  if (
    !region ||
    (region.name === captured.name &&
      progress.evidence.every(
        (evidence) => region.text.slice(evidence.start, evidence.end) === evidence.text,
      ))
  ) {
    return false;
  }
  progress.phase = "collect";
  progress.invalidatedEvidence = [...progress.invalidatedEvidence, ...progress.evidence].slice(-16);
  progress.evidence = [];
  progress.missing = [...contract.outputs];
  delete progress.capturedRegion;
  progress.conflicts++;
  return true;
}
