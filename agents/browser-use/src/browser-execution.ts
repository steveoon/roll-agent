import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StructuredToolError } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import {
  BrowserExecuteInputSchema,
  BrowserScriptError,
  BrowserScriptPageDriver,
  compileBrowserScript,
  executeBrowserProgram,
  normalizeBrowserOrigin,
  readBrowserDocumentIdentity,
} from "@roll-agent/browser";
import type {
  BrowserExecuteInput,
  BrowserExecuteResult,
  BrowserRuntime,
} from "@roll-agent/browser";
import { getRuntime, getBrowserInstancePoolOrUndefined } from "./runtime-holder.ts";
import { observeBrowserPage } from "./browser-observation.ts";
import { browserElementRefStore } from "./element-ref-store.ts";
import { canonicalJson } from "./workflows/parameters.ts";
import { assertScriptDomains, authorizeBrowserScript } from "./browser-script-approval.ts";

export type BrowserExecutionDependencies = {
  runtime: Pick<BrowserRuntime, "getConfig" | "listNativePages" | "connectNativePage">;
  browserInstance: string;
  compile: typeof compileBrowserScript;
  execute: typeof executeBrowserProgram;
};
let override: BrowserExecutionDependencies | undefined;
export function setBrowserExecutionDependenciesForTests(
  value: BrowserExecutionDependencies | undefined,
): void {
  override = value;
}

/** Called internally by execute/workflow tools, under the existing instance lock exactly once. */
export async function executeBrowserTool(
  rawInput: BrowserExecuteInput,
  ctx: AgentContext,
  options: { workflowKey?: string; beforeAction?: () => Promise<void>; toolName?: string } = {},
): Promise<{ result: BrowserExecuteResult; executionDigest: string }> {
  const input = BrowserExecuteInputSchema.parse(rawInput);
  const serializedArgs = canonicalJson(input.args);
  if (Buffer.byteLength(serializedArgs) > 65_536 || Buffer.byteLength(input.source) > 65_536) {
    throw new StructuredToolError({
      code: "invalid_input",
      message: "Script source and JSON parameters each have a 64KiB limit",
    });
  }
  if (!input.capabilities.includes("read")) {
    throw new StructuredToolError({
      code: "invalid_input",
      message: "Browser scripts require read capability for target and origin checks",
    });
  }
  const deps = override ?? {
    runtime: getRuntime(),
    browserInstance: getBrowserInstancePoolOrUndefined()?.getBundle().id ?? "default",
    compile: compileBrowserScript,
    execute: executeBrowserProgram,
  };
  assertScriptDomains(input, deps.runtime.getConfig().security);
  if (ctx.signal?.aborted) {
    throw new StructuredToolError({
      code: "cancelled",
      message: "Browser script cancelled before execution",
    });
  }
  const compiled = await deps.compile(input.source);
  if (!compiled.valid) {
    throw new StructuredToolError({
      code: "invalid_script",
      message: compiled.error ?? "Script compilation failed",
    });
  }
  if (ctx.signal?.aborted) {
    throw new StructuredToolError({
      code: "cancelled",
      message: "Browser script cancelled during compilation",
    });
  }
  const pages = await deps.runtime.listNativePages();
  const page = pages.find((candidate) => candidate.targetId === input.pageId);
  if (!page) {
    throw new StructuredToolError({
      code: "not_found",
      message: "The specified browser page no longer exists",
    });
  }
  if (!input.allowedOrigins.includes(normalizeBrowserOrigin(page.url))) {
    throw new StructuredToolError({
      code: "action_denied",
      message: "The current page origin is not declared by this script",
    });
  }
  // Approval is for the script; every subsequent native mutation is guarded by
  // the driver against live policy, so the controller itself need not re-prompt.
  const controller = await deps.runtime.connectNativePage(page);
  const artifacts: BrowserExecuteResult["artifacts"] = [];
  try {
    const documentId = await readBrowserDocumentIdentity(controller);
    const approved = authorizeBrowserScript(
      input,
      {
        browserInstance: deps.browserInstance,
        documentId,
        ...(options.workflowKey === undefined ? {} : { workflowKey: options.workflowKey }),
        ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
      },
      deps.runtime.getConfig().security,
    );
    let artifactDirectory: string | undefined;
    const driver = new BrowserScriptPageDriver({
      controller,
      pageId: page.targetId,
      browserInstance: deps.browserInstance,
      allowedOrigins: input.allowedOrigins,
      capabilities: input.capabilities,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      guard: async (capability) => {
        if (ctx.signal?.aborted) {
          throw new BrowserScriptError("cancelled", "Browser execution cancelled");
        }
        if (!input.capabilities.includes(capability)) {
          throw new BrowserScriptError("capability_denied", "Helper capability was not declared");
        }
        const security = deps.runtime.getConfig().security;
        try {
          assertScriptDomains(input, security);
        } catch {
          throw new BrowserScriptError("domain_denied", "Allowed browser origins changed");
        }
        if (capability === "interact" || capability === "navigate") {
          if (
            security.actionPolicy === "deny" ||
            (security.actionPolicy === "confirm" && !approved.approved)
          ) {
            throw new BrowserScriptError(
              "action_denied",
              "Browser policy changed; execution stopped without replay",
            );
          }
        }
        try {
          await options.beforeAction?.();
        } catch (caught) {
          if (caught instanceof StructuredToolError) {
            throw new BrowserScriptError(
              caught.payload.code,
              "Workflow state changed; execution stopped",
            );
          }
          throw caught;
        }
      },
      observe: async (observationOptions) =>
        await observeBrowserPage({
          controller,
          page,
          browserInstance: deps.browserInstance,
          allowedOrigins: input.allowedOrigins,
          maxNodes: Math.min(60, deps.runtime.getConfig().security.maxSnapshotNodes),
          interactiveOnly: false,
          ...(observationOptions?.scope === undefined ? {} : { scope: observationOptions.scope }),
        }),
      resolveRef: async (ref, snapshotId) =>
        browserElementRefStore.getScopedRef({
          ref: ref as `@e${number}`,
          snapshotId,
          browserInstance: deps.browserInstance,
          pageId: page.targetId,
          documentId: await readBrowserDocumentIdentity(controller),
        }),
      capture: async (base64) => {
        if (artifacts.length >= 10 || base64.length > 32 * 1024 * 1024) {
          throw new BrowserScriptError("artifact_limit", "Screenshot budget exceeded");
        }
        artifactDirectory ??= await mkdtemp(join(tmpdir(), "roll-browser-execution-"));
        const id = randomUUID();
        const path = join(artifactDirectory, `${id}.png`);
        await writeFile(path, Buffer.from(base64, "base64"), { mode: 0o600, flag: "wx" });
        const artifact = { id, path, mimeType: "image/png" as const };
        artifacts.push(artifact);
        return artifact;
      },
    });
    const result = await deps.execute(input, {
      driver,
      artifacts,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    ctx.logger.info(
      `browser_execute ${result.executionId}: ${result.status}, ${result.metrics.helperCalls} helpers, ${Math.round(result.metrics.elapsedMs)}ms`,
    );
    return { result, executionDigest: approved.executionDigest };
  } finally {
    controller.close();
  }
}
