import { createHash } from "node:crypto";
import { StructuredToolError } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import {
  BrowserScriptPageDriver,
  BrowserScriptError,
  isUrlAllowedByDomainAllowlist,
  normalizeBrowserOrigin,
  readBrowserDocumentIdentity,
} from "@roll-agent/browser";
import type { NativeCdpFrameTree } from "@roll-agent/browser";
import { getRuntime, getBrowserInstancePoolOrUndefined } from "../runtime-holder.ts";
import { assertBrowserActionAllowed } from "../browser-security.ts";
import { browserElementRefStore } from "../element-ref-store.ts";
import { observeBrowserPage } from "../browser-observation.ts";
import { canonicalJson } from "../workflows/parameters.ts";
import { BrowserOperateInputSchema } from "./contracts.ts";
import type { BrowserOperateInput, BrowserOperateOutput } from "./contracts.ts";
import { createJevProvider, createSamplingProvider } from "./decisions.ts";
import type { DecisionProvider } from "./decisions.ts";
import { runBrowserGoal } from "./loop.ts";
import type { GoalDriver } from "./loop.ts";
import { runBrowserTask } from "./task-loop.ts";
import { inspectGoalControls } from "./observation.ts";
import { createDependencyObserver } from "./dependency-observation.ts";
import { attachTaskText } from "./task-observation.ts";
import { semanticGoalControl } from "./task-freshness.ts";
import { createRetryingGoalObserver } from "./observation-retry.ts";

export function permittedFrames(tree: NativeCdpFrameTree, origins: readonly string[]): Set<string> {
  const ids = new Set<string>();
  const visit = (node: NativeCdpFrameTree): void => {
    let origin: string;
    try {
      origin = new URL(node.frame.url).origin;
    } catch {
      return;
    }
    if (!origins.includes(origin)) return;
    ids.add(node.frame.id);
    for (const child of node.childFrames ?? []) visit(child);
  };
  visit(tree);
  return ids;
}

export function resolveOperateEngine(
  requested: BrowserOperateInput["engine"],
  env: NodeJS.ProcessEnv,
): NonNullable<BrowserOperateInput["engine"]> {
  const configured = env["BROWSER_OPERATE_ENGINE"] ?? "sampling";
  if (configured !== "sampling" && configured !== "jev") {
    throw new StructuredToolError({
      code: "configuration_error",
      message: `Invalid BROWSER_OPERATE_ENGINE: ${configured}`,
    });
  }
  if (requested !== undefined && requested !== configured) {
    throw new StructuredToolError({
      code: "invalid_input",
      message:
        "browser_operate.engine cannot override browser.operate.engine. Change Roll configuration instead",
    });
  }
  if (configured === "jev" && !env["TYPESAFE_API_KEY"]?.trim()) {
    throw new StructuredToolError({
      code: "configuration_error",
      message:
        "browser.operate.engine is jev, but TYPESAFE_API_KEY is missing. Configure agents.env.browser-use-agent.TYPESAFE_API_KEY before using fast mode",
    });
  }
  return configured;
}

export async function operateBrowser(
  rawInput: BrowserOperateInput,
  ctx: AgentContext,
): Promise<BrowserOperateOutput> {
  const input = BrowserOperateInputSchema.parse(rawInput);
  if (input.readTask && input.formTask) {
    throw new StructuredToolError({
      code: "invalid_input",
      message: "Choose one delegation adapter: readTask or formTask",
    });
  }
  if ((input.readTask || input.formTask) && input.strategy !== "task") {
    throw new StructuredToolError({
      code: "invalid_input",
      message: "readTask/formTask requires strategy task",
    });
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(input.timeoutMs),
    ...(ctx.signal ? [ctx.signal] : []),
  ]);
  const engine = resolveOperateEngine(input.engine, process.env);
  const apiKey = process.env["TYPESAFE_API_KEY"]?.trim();
  const provider =
    engine === "sampling"
      ? createSamplingProvider(ctx)
      : createJevProvider({ apiKey: apiKey!, model: input.model ?? "jev-latest" });
  const runtime = getRuntime();
  const browserInstance = getBrowserInstancePoolOrUndefined()?.getBundle().id ?? "default";
  const assertDomains = (): void => {
    signal.throwIfAborted();
    if (
      input.allowedOrigins.some(
        (origin) =>
          !isUrlAllowedByDomainAllowlist(origin, runtime.getConfig().security.domainAllowlist),
      )
    ) {
      throw new BrowserScriptError(
        "domain_denied",
        "Goal origin is outside the live domain allowlist",
      );
    }
  };
  assertDomains();
  const page = (await runtime.listNativePages()).find(
    (candidate) => candidate.targetId === input.pageId,
  );
  if (!page) {
    throw new StructuredToolError({ code: "not_found", message: "Browser page no longer exists" });
  }
  if (!input.allowedOrigins.includes(normalizeBrowserOrigin(page.url))) {
    throw new StructuredToolError({
      code: "action_denied",
      message: "Page is outside the allowed goal origins",
    });
  }
  const controller = await runtime.connectNativePage(page);
  let driver: BrowserScriptPageDriver | undefined;
  try {
    const documentId = await readBrowserDocumentIdentity(controller);
    const { browserActionApproval, ...task } = input;
    const digest = createHash("sha256")
      .update(canonicalJson({ task, documentId, browserInstance }))
      .digest("hex");
    const approved = assertBrowserActionAllowed(ctx, runtime, {
      action: "browser_operate",
      target: `${browserInstance}:${page.targetId}:${digest}`,
      url: page.url,
      ...(browserActionApproval === undefined ? {} : { approval: browserActionApproval }),
    });
    // Native driver supplies its own per-dispatch guards, just as browser_execute does.
    // Preflight here also enforces the existing whole-task confirmation policy.
    const observeDependencies = createDependencyObserver(controller, input.allowedOrigins, signal);
    const observe = async (dependencyIdentities: readonly string[] = []) => {
      assertDomains();
      const tree = await controller.getFrameTree();
      const allowedFrameIds = permittedFrames(tree, input.allowedOrigins);
      if (!allowedFrameIds.has(tree.frame.id)) {
        throw new BrowserScriptError("domain_denied", "Page navigated outside goal origins");
      }
      const snapshot = await observeBrowserPage({
        controller,
        page,
        browserInstance,
        allowedOrigins: input.allowedOrigins,
        allowedFrameIds,
        maxNodes: Math.min(240, runtime.getConfig().security.maxSnapshotNodes),
        interactiveOnly: true,
      });
      assertDomains();
      const inspected = await inspectGoalControls(
        controller,
        snapshot,
        input.allowedOrigins,
        signal,
      );
      return input.strategy === "task"
        ? await observeDependencies(
            await attachTaskText(
              controller,
              inspected,
              input.allowedOrigins,
              signal,
              Boolean(input.readTask),
            ),
            dependencyIdentities,
          )
        : inspected;
    };
    // Retry only the loop's next complete observation. The native driver's
    // in-action snapshot/expect path keeps its original no-replay behavior.
    const observeGoal = createRetryingGoalObserver(observe, signal, () =>
      browserElementRefStore.clear(page.targetId),
    );
    driver = new BrowserScriptPageDriver({
      controller,
      pageId: page.targetId,
      browserInstance,
      allowedOrigins: input.allowedOrigins,
      capabilities: ["read", "interact"],
      signal,
      guard: async (capability) => {
        assertDomains();
        const policy = runtime.getConfig().security.actionPolicy;
        if (
          capability !== "read" &&
          (policy === "deny" || (policy === "confirm" && !approved.approvedByConfirmation))
        ) {
          throw new BrowserScriptError(
            "action_denied",
            "Browser policy changed; goal stopped without replay",
          );
        }
      },
      observe: () => observe(),
      resolveRef: async (ref, snapshotId) =>
        browserElementRefStore.getScopedRef({
          ref,
          snapshotId,
          browserInstance,
          pageId: page.targetId,
          documentId: await readBrowserDocumentIdentity(controller),
        }),
      capture: async () => {
        throw new BrowserScriptError("capability_denied", "Goal loop does not capture screenshots");
      },
    });
    const boundDriver = driver;
    let decisionCount = 0;
    const goalDriver: GoalDriver = {
      observe: observeGoal,
      invoke: (method, params) => boundDriver.invoke(method, params),
      actionExecuted: () => boundDriver.lastActionExecuted,
      checkTarget: async (snapshot, ref) => {
        assertDomains();
        if ((await readBrowserDocumentIdentity(controller)) !== snapshot.documentId) return false;
        const inspected = await inspectGoalControls(
          controller,
          { ...snapshot, refs: [ref] },
          input.allowedOrigins,
          signal,
        );
        const before = snapshot.controls?.[ref.ref];
        const after = inspected.controls?.[ref.ref];
        return Boolean(
          before &&
          after &&
          after.availability !== "unavailable" &&
          canonicalJson(semanticGoalControl(before)) === canonicalJson(semanticGoalControl(after)),
        );
      },
    };
    const choose: DecisionProvider = async (request, requestSignal) => {
      const result = await provider(request, requestSignal);
      ctx.logger.info(
        `browser_operate decision ${++decisionCount}: ${result.choices.operation ?? result.choices.status} ${result.choices.next ?? ""} (${Math.round(result.elapsedMs)}ms)`,
      );
      return result;
    };
    return input.strategy === "task"
      ? await runBrowserTask(input, goalDriver, choose, signal)
      : await runBrowserGoal(input, goalDriver, choose, signal);
  } finally {
    driver?.close();
    controller.close();
  }
}
