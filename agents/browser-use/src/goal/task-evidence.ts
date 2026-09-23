import type { ReadDocument, ReadTask, TaskProgress } from "./task-progress.ts";
import { CapturedEvidenceSchema, digestText } from "./task-progress.ts";

export function evidenceCandidates(documents: readonly ReadDocument[]) {
  return documents
    .flatMap((doc) =>
      doc.regions.map((region) => {
        const key = `r${documents.indexOf(doc)}_${doc.regions.indexOf(region)}`;
        const spans = [...region.text.matchAll(/[^\n]+/gu)]
          .flatMap((match, index) => {
            const text = match[0].trim();
            if (!text || Buffer.byteLength(text, "utf8") > 4096) return [];
            const start = match.index + match[0].indexOf(text);
            return [{ id: `${key}s${index}`, text, start, end: start + text.length }];
          })
          .slice(0, 96);
        return { key, doc, region, spans };
      }),
    )
    .slice(0, 4);
}
export type EvidenceCandidate = ReturnType<typeof evidenceCandidates>[number];

/** Commit one complete, same-observation packet. Never stitch fields from different records. */
export function commitEvidence(
  progress: TaskProgress,
  contract: ReadTask,
  candidate: EvidenceCandidate,
  selected: readonly string[],
  observationId: string,
  documentId: string,
): boolean {
  if (progress.phase !== "collect" || selected.length !== contract.outputs.length) return false;
  const quotes = selected.map((id) => candidate.spans.find((span) => span.id === id));
  progress.missing = contract.outputs.filter((_, index) => !quotes[index]);
  if (quotes.some((quote) => !quote) || candidate.region.truncated) return false;
  const evidence = contract.outputs.map((field, index) => {
    const quote = quotes[index]!;
    if (candidate.region.text.slice(quote.start, quote.end) !== quote.text) {
      throw new Error("Evidence quote no longer matches its observation");
    }
    return CapturedEvidenceSchema.parse({
      id: `${progress.taskRunId}:e${index + 1}`,
      field,
      text: quote.text,
      observationId,
      documentId,
      frameId: candidate.doc.frameId,
      url: candidate.doc.url,
      regionId: candidate.region.id,
      regionName: candidate.region.name,
      start: quote.start,
      end: quote.end,
      observedAt: candidate.doc.observedAt,
      attribution: "model-selected-observed-text",
    });
  });
  if (
    Buffer.byteLength(JSON.stringify([...progress.invalidatedEvidence, ...evidence]), "utf8") >
    65536
  ) {
    return false;
  }
  progress.evidence = evidence;
  progress.capturedRegion = {
    documentId,
    frameId: candidate.doc.frameId,
    url: candidate.doc.url,
    id: candidate.region.id,
    name: candidate.region.name,
    digest: digestText(candidate.region.text),
  };
  progress.phase = "return";
  progress.missing = [];
  return true;
}
