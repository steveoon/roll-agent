#!/usr/bin/env node
// Opt-in paired real-provider experiment. Never writes user configuration.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../packages/core/src/config/loader.ts";
import { resolveInteractiveChatLlm } from "../../packages/core/src/runtime-host/chatgpt-resolution.ts";
import { compactionModelDraftSchema } from "../../packages/runtime/src/engine/compaction-semantic-state.ts";
import { digest, runProductionCompaction, decideExperiment } from "./compaction-experiment.mjs";
const { values } = parseArgs({
  options: {
    run: { type: "boolean" },
    fixtures: { type: "string" },
    output: { type: "string" },
    timeout: { type: "string", default: "120000" },
    pairs: { type: "string", default: "3" },
    effort: { type: "string", default: "paired" },
  },
});
if (!values.run) {
  console.log("Use --run --fixtures <JSON [{name,snapshotPath,criticalFacts}]> --output <JSON>");
  process.exit(0);
}
const require = createRequire(resolve("packages/runtime/package.json"));
const { wrapLanguageModel } = await import(pathToFileURL(require.resolve("ai")));
const fixtures = JSON.parse(readFileSync(values.fixtures, "utf8"));
const report = {
  startedAt: new Date().toISOString(),
  harness: "AgentSession + SQLite production validation and commit",
  runs: [],
  status: "running",
};
const save = () => writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
const nativeFetch = globalThis.fetch;
let timing;
globalThis.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  if (!timing || !String(args[0]).includes("/responses") || !response.body) return response;
  const current = timing;
  let buffered = "";
  const decoder = new TextDecoder();
  return new Response(
    response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          buffered += decoder.decode(chunk, { stream: true });
          let split;
          while ((split = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, split).trim();
            buffered = buffered.slice(split + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const event = JSON.parse(line.slice(5));
              if (typeof event.type === "string" && event.type.endsWith(".delta")) {
                current.firstContentMs ??= Date.now() - current.started;
                if (event.type === "response.output_text.delta") {
                  current.firstTextMs ??= Date.now() - current.started;
                }
              }
            } catch {
              /* SSE sentinels are not JSON. */
            }
          }
          controller.enqueue(chunk);
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
};
const errorInfo = (error) => ({
  name: error?.name,
  code:
    error?.code ??
    (/server_is_overloaded/u.test(String(error?.message)) ? "server_is_overloaded" : undefined),
  causeName: error?.cause?.name,
  causeCode: error?.cause?.code,
  timeout: error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError",
});
const isNetwork = (error) =>
  [error?.code, error?.causeCode].some((s) =>
    ["network_error", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(s),
  );
try {
  const { config } = loadConfig();
  for (const fixture of fixtures) {
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8"));
    for (let pair = 0; pair < Number(values.pairs); pair++) {
      const order =
        values.effort === "paired"
          ? pair % 2
            ? ["medium", "low"]
            : ["low", "medium"]
          : [values.effort];
      for (const effort of order) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const run = {
            fixture: fixture.name,
            pair,
            effort,
            attempt,
            timeoutMs: Number(values.timeout),
            snapshotDigest: digest(snapshot),
            firstContentMs: null,
            firstTextMs: null,
            reasoningTokens: null,
            outputTokens: null,
            requests: [],
          };
          report.runs.push(run);
          save();
          let llm;
          const started = Date.now();
          try {
            llm = await resolveInteractiveChatLlm({
              ...config,
              runtime: {
                ...config.runtime,
                compaction: { ...config.runtime.compaction, thinkingLevel: effort },
              },
            });
            run.resolutionMs = Date.now() - started;
            report.provider = llm.provider;
            report.model = llm.modelName;
            const model = wrapLanguageModel({
              model: llm.model,
              middleware: {
                specificationVersion: "v4",
                wrapGenerate: async ({ doGenerate, params }) => {
                  const request = {
                    requestDigest: digest({
                      prompt: params.prompt,
                      responseFormat: params.responseFormat,
                      maxOutputTokens: params.maxOutputTokens,
                    }),
                    inputChars: JSON.stringify(params.prompt).length,
                    maxOutputTokens: params.maxOutputTokens,
                    effectiveReasoning:
                      params.providerOptions?.openai?.reasoningEffort ?? params.reasoning ?? null,
                  };
                  run.requests.push(request);
                  timing = { started: Date.now() };
                  try {
                    const out = await doGenerate();
                    request.usage = out.usage;
                    request.output = out.content
                      .filter((p) => p.type === "text")
                      .map((p) => p.text)
                      .join("");
                    request.structuredValid = compactionModelDraftSchema.safeParse(
                      JSON.parse(request.output),
                    ).success;
                    return out;
                  } catch (error) {
                    request.error = errorInfo(error);
                    throw error;
                  } finally {
                    request.elapsedMs = Date.now() - timing.started;
                    request.firstContentMs = timing.firstContentMs ?? null;
                    request.firstTextMs = timing.firstTextMs ?? null;
                    timing = undefined;
                    save();
                  }
                },
              },
            });
            run.artifacts = mkdtempSync(join(tmpdir(), "roll-compaction-ab-production-"));
            run.production = await runProductionCompaction({
              snapshot,
              directory: run.artifacts,
              model,
              timeoutMs: run.timeoutMs,
              criticalFacts: fixture.criticalFacts,
              structuredOutputProviderOptions: llm.structuredOutputProviderOptions,
              structuredOutputReasoning: llm.structuredOutputReasoning,
            });
            // Every variant is exactly one summary request from an identical snapshot.
            // Archival fallback is live, but must never count as successful summarization.
            const request = run.requests[0];
            run.requestDigest = request?.requestDigest;
            run.elapsedMs = request?.elapsedMs ?? null;
            run.firstContentMs = request?.firstContentMs ?? null;
            run.firstTextMs = request?.firstTextMs ?? null;
            run.reasoningTokens = request?.usage?.outputTokens?.reasoning ?? null;
            run.outputTokens = request?.usage?.outputTokens?.total ?? null;
            run.qualityPassed =
              run.requests.length === 1 &&
              request.structuredValid === true &&
              run.production.productionQualityPassed;
            run.error = request?.error;
            run.status = request
              ? request.error
                ? "failed"
                : "completed"
              : "fixture_not_exercised";
          } catch (error) {
            run.status = "failed";
            run.error = errorInfo(error);
          } finally {
            run.totalElapsedMs = Date.now() - started;
            await llm?.connection?.close?.();
            timing = undefined;
            save();
            console.log(
              JSON.stringify({
                fixture: run.fixture,
                pair,
                effort,
                attempt,
                status: run.status,
                elapsedMs: run.elapsedMs,
                qualityPassed: run.qualityPassed,
                error: run.error,
              }),
            );
          }
          run.networkFailure = isNetwork(run.error);
          save();
          if (!run.networkFailure) break;
        }
      }
    }
  }
  report.decision = decideExperiment(report.runs, fixtures, Number(values.pairs));
  report.status = report.decision.complete ? "completed" : "incomplete";
} catch (error) {
  report.status = "blocked";
  report.error = errorInfo(error);
} finally {
  globalThis.fetch = nativeFetch;
  report.finishedAt = new Date().toISOString();
  save();
}
