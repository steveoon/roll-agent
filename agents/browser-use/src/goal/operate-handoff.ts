import type { BrowserOperateOutput } from "./contracts.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Tool-boundary form handoff. The internal loop result remains intact for direct consumers. */
export function compactFormOperateOutput(output: BrowserOperateOutput): BrowserOperateOutput {
  const form = output.execution?.form;
  if (!form || output.progress) return output;
  const observationFresh =
    isRecord(output.finalObservation) && output.finalObservation.observationFresh === true;
  // Retry only pure serialization with a smaller text budget, never browser execution.
  for (const limit of [240, 80, 24, 0]) {
    const clip = (text: string): string =>
      text.length <= limit ? text : `${text.slice(0, limit)}[truncated]`;
    const steps = output.steps
      .slice(-100)
      .map(
        ({
          distributions: _distributions,
          decisionAttempts,
          textMs,
          recovery,
          usage,
          ...step
        }) => ({
          ...step,
          ...(limit === 0
            ? {}
            : {
                ...(decisionAttempts === undefined ? {} : { decisionAttempts }),
                ...(textMs === undefined ? {} : { textMs }),
                ...(recovery === undefined ? {} : { recovery }),
                ...(usage === undefined ? {} : { usage }),
              }),
          operation: clip(step.operation),
          requestedModel: clip(step.requestedModel),
          resolvedModel: clip(step.resolvedModel),
          provider: clip(step.provider),
          ...(step.target === undefined ? {} : { target: clip(step.target) }),
          ...(step.requirement === undefined ? {} : { requirement: clip(step.requirement) }),
          ...(step.valueName === undefined ? {} : { valueName: clip(step.valueName) }),
          ...(step.error === undefined ? {} : { error: clip(step.error) }),
        }),
      );
    const compact: BrowserOperateOutput = {
      status: output.status,
      verified: false,
      handoff: {
        observationFresh,
        diagnosticsOmitted: true,
        totalSteps: output.steps.length,
        omittedSteps: output.steps.length - steps.length,
        fields: form.fields.slice(0, 16).map((f) => ({
          id: clip(f.id),
          name: clip(f.name),
          intent: f.intent,
          status: f.status,
          reason: clip(f.reason),
          ...(f.expected === undefined ? {} : { expected: clip(f.expected) }),
          ...(f.current === undefined ? {} : { current: clip(f.current) }),
          valueTruncated: (f.expected?.length ?? 0) > limit || (f.current?.length ?? 0) > limit,
        })),
        next: "Compare field evidence against the original goal; satisfied is not independently verified. Values marked truncated are excerpts, not exact readback. Observe unresolved fields/editors once with browser_snapshot before acting. Do not replay completed or uncertain actions or repeat an unchanged delegation. No refs in this summary are executable.",
      },
      ...(output.error === undefined ? {} : { error: clip(output.error) }),
      ...(output.question === undefined ? {} : { question: clip(output.question) }),
      elapsedMs: output.elapsedMs,
      steps,
      // Do not append full page dumps, proof keys or duplicate field values after the handoff.
      finalObservation: {
        observationFresh,
        verification:
          "Use handoff.fields for evidence; verified remains false. Obtain fresh observations for missing or truncated evidence.",
      },
      pendingRequirements: form.fields
        .filter((f) => f.status !== "satisfied")
        .slice(0, 16)
        .map((f) => `${clip(f.name)}: ${f.status} (${clip(f.reason)})`),
    };
    if (JSON.stringify(compact).length < 50_000) return compact;
  }
  // The final budget fits all 100 action records and 16 fields of a valid loop result.
  throw new Error("Form handoff exceeds its bounded output contract");
}
