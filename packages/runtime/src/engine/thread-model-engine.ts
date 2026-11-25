import { randomUUID } from "node:crypto";
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import {
  threadIdSchema,
  type ActiveThreadModel,
  type ActiveThreadModelV16,
  type LatestRuntimeMethodParams,
  type RuntimeModelCatalog,
  type RuntimeModelCatalogV16,
  type ThreadEffortCapability,
  type ThreadEffortLevel,
  type ThreadEffortSelection,
  type ThreadModelSelection,
  type ThreadModelStatus,
  type ThreadModelStatusV16,
  type ThreadModelTarget,
} from "@roll-agent/protocol";
import type { AgentSession } from "./agent-session.ts";
import type {
  ConversationEngine,
  ConversationEngineOptions,
  CreateSessionInput,
  EngineModelSwitch,
} from "./conversation-engine.ts";

export type ThreadModelHostCatalog = RuntimeModelCatalog | RuntimeModelCatalogV16;
export type ThreadModelEngineStatus = ThreadModelStatus | ThreadModelStatusV16;

export interface PreparedThreadEffort {
  readonly effort: ThreadEffortLevel;
  readonly effortCapability: ThreadEffortCapability;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly reasoning?: "summary" | "text";
}

export interface PreparedThreadModel extends EngineModelSwitch {
  readonly reasoning?: "summary" | "text";
  readonly effort?: ThreadEffortLevel;
  readonly effortCapability?: ThreadEffortCapability;
}

export interface ThreadModelValidationInput {
  readonly identity: ThreadModelHostCatalog["defaultModel"];
  readonly effort: ThreadEffortSelection;
  /** True when switching to a different model or across a configuration reload. */
  readonly requiresFullModelPrepare: boolean;
}

export type ValidatedThreadModelTarget = ThreadModelTarget;

/** Product configuration/provider construction belongs to the injecting host. */
export interface ThreadModelHost {
  catalog(): ThreadModelHostCatalog;
  validate?: ((input: ThreadModelValidationInput) => ValidatedThreadModelTarget) | undefined;
  prepareEffort?:
    | ((
        current: {
          readonly provider: string;
          readonly modelName: string;
          readonly model: LanguageModelV4;
        },
        effort: ThreadEffortLevel,
      ) => PreparedThreadEffort)
    | undefined;
  prepare(
    identity: ThreadModelHostCatalog["defaultModel"],
    signal: AbortSignal,
    effort?: ThreadEffortLevel,
  ): Promise<PreparedThreadModel>;
}

export type ThreadModelFailure = Extract<ThreadModelStatus, { status: "failed" }>["reason"];
type ThreadModelFailureV16 = Extract<ThreadModelStatusV16, { status: "failed" }>["reason"];
export type ThreadModelErrorReason =
  | "revision-conflict"
  | "config-changed"
  | "model-unavailable"
  | "effort-unsupported"
  | "compaction-effort-incompatible"
  | "unavailable";

export class ThreadModelError extends Error {
  readonly reason: ThreadModelErrorReason;
  constructor(reason: ThreadModelErrorReason, message?: string) {
    super(message ?? `Conversation model selection: ${reason}`);
    this.reason = reason;
  }
}

type SessionLifecycle = Pick<
  ConversationEngineOptions,
  "onBeforeModelUse" | "onSessionCloseRequested" | "onSessionClosed" | "disposeHostOnSessionClose"
>;
export interface ThreadModelEngineOptions {
  readonly initial: PreparedThreadModel;
  readonly host: ThreadModelHost;
  /** Every invocation must create an independently owned AgentHost/MCP connection scope. */
  readonly createEngine: (
    model: PreparedThreadModel,
    lifecycle: SessionLifecycle,
  ) => ConversationEngine;
}

interface AppliedModelState {
  readonly configRevision: string;
  readonly prepared: PreparedThreadModel;
}

interface ThreadContext {
  status: ThreadModelEngineStatus;
  appliedModel: AppliedModelState | undefined;
  reloadingPureDefault: boolean;
  engine: ConversationEngine | undefined;
  session: AgentSession | undefined;
  preparing: { readonly controller: AbortController; readonly settled: Promise<void> } | undefined;
  closing: boolean;
  failedSettlement: boolean;
}

export function isEffortAwareModelCatalog(
  catalog: ThreadModelHostCatalog,
): catalog is RuntimeModelCatalog {
  return (
    "defaultEffort" in catalog &&
    catalog.defaultEffort !== undefined &&
    catalog.items.every((item) => "effortCapability" in item && item.effortCapability !== undefined)
  );
}

function isThreadModelStatusV17(status: ThreadModelEngineStatus): status is ThreadModelStatus {
  return "effort" in status && "target" in status;
}

function isActiveThreadModelV17(
  active: ActiveThreadModel | ActiveThreadModelV16 | null,
): active is ActiveThreadModel {
  return active !== null && "effort" in active && "effortCapability" in active;
}

function toLegacyActiveModel(
  active: ActiveThreadModel | ActiveThreadModelV16 | null,
): ActiveThreadModelV16 | null {
  if (active === null) {
    return null;
  }
  return {
    provider: active.provider,
    model: active.model,
    reasoning: active.reasoning,
    ...(active.contextWindow === undefined ? {} : { contextWindow: active.contextWindow }),
  };
}

function findCatalogItem<TCatalog extends ThreadModelHostCatalog>(
  catalog: TCatalog,
  identity: ThreadModelHostCatalog["defaultModel"],
): TCatalog["items"][number] | undefined {
  return catalog.items.find(
    (item) => item.provider === identity.provider && item.model === identity.model,
  );
}

function defaultValidateTarget(
  catalog: RuntimeModelCatalog,
  input: ThreadModelValidationInput,
): ValidatedThreadModelTarget {
  const item = findCatalogItem(catalog, input.identity);
  if (!item?.available) {
    throw new ThreadModelError("model-unavailable");
  }
  const effectiveEffort =
    input.effort.mode === "default" ? catalog.defaultEffort : input.effort.level;
  const cap = item.effortCapability;
  if (input.effort.mode === "explicit" && (cap.kind === "fixed" || cap.kind === "unknown")) {
    throw new ThreadModelError("effort-unsupported");
  }
  if (cap.kind === "levels" && !cap.levels.includes(effectiveEffort)) {
    throw new ThreadModelError("effort-unsupported");
  }
  if (
    input.effort.mode === "explicit" &&
    cap.kind === "toggle" &&
    effectiveEffort !== cap.offLevel &&
    effectiveEffort !== cap.onLevel
  ) {
    throw new ThreadModelError("effort-unsupported");
  }
  return {
    provider: input.identity.provider,
    model: input.identity.model,
    effectiveEffort,
    effortCapability: cap,
  };
}

function projectUnverifiedTarget(
  catalog: RuntimeModelCatalog,
  selection: ThreadModelSelection,
  effort: ThreadEffortSelection,
): ThreadModelTarget {
  const identity =
    selection.mode === "default"
      ? catalog.defaultModel
      : { provider: selection.provider, model: selection.model };
  const item = findCatalogItem(catalog, identity);
  return {
    provider: identity.provider,
    model: identity.model,
    effectiveEffort: effort.mode === "default" ? catalog.defaultEffort : effort.level,
    effortCapability: item?.effortCapability ?? { kind: "unknown" },
  };
}

function toLegacyFailureReason(reason: ThreadModelFailure): ThreadModelFailureV16 {
  return reason === "effort-unsupported" ? "config-changed" : reason;
}

function toFailedStatus(
  base: ThreadModelEngineStatus,
  reason: ThreadModelFailure,
): ThreadModelEngineStatus {
  if (isThreadModelStatusV17(base)) {
    return {
      threadId: base.threadId,
      revision: base.revision,
      selection: base.selection,
      effort: base.effort,
      target: base.target,
      configRevision: base.configRevision,
      active: base.active,
      status: "failed",
      reason,
    };
  }
  return {
    threadId: base.threadId,
    revision: base.revision,
    selection: base.selection,
    configRevision: base.configRevision,
    active: base.active,
    status: "failed",
    reason: toLegacyFailureReason(reason),
  };
}

function toAppliedStatusV17(
  base: ThreadModelStatus,
  target: ThreadModelTarget,
  active: ActiveThreadModel,
): ThreadModelStatus {
  return {
    threadId: base.threadId,
    revision: base.revision,
    selection: base.selection,
    effort: base.effort,
    target,
    configRevision: base.configRevision,
    status: "applied",
    active,
  };
}

function toAppliedStatusV16(
  base: ThreadModelStatusV16,
  active: ActiveThreadModelV16,
): ThreadModelStatusV16 {
  return {
    threadId: base.threadId,
    revision: base.revision,
    selection: base.selection,
    configRevision: base.configRevision,
    status: "applied",
    active,
  };
}

/** Protocol-host adapter: each attached session owns an Engine and its MCP Sampling scope.
 * Selection state is process-local and discarded on detach; CLI/scheduler use ConversationEngine.
 */
export class ThreadModelEngine {
  private host: ThreadModelHost;
  private initial: PreparedThreadModel;
  private readonly options: ThreadModelEngineOptions;
  private readonly contexts = new Map<string, ThreadContext>();
  private readonly opening = new Map<string, Promise<AgentSession>>();
  private readonly jobs = new Set<Promise<unknown>>();
  private isExternallyBusy: (id: string) => boolean = () => false;
  private closed = false;
  private disposal: Promise<void> | undefined;

  constructor(options: ThreadModelEngineOptions) {
    this.options = options;
    this.initial = options.initial;
    this.host = options.host;
  }

  setModelBusyCheck(check: (id: string) => boolean): void {
    this.isExternallyBusy = check;
  }
  supportsThreadEffort(): boolean {
    if (this.closed) {
      return false;
    }
    return isEffortAwareModelCatalog(this.host.catalog());
  }
  getModelCatalog(): ThreadModelHostCatalog {
    this.assertOpen();
    return this.host.catalog();
  }
  hasThreadReasoning(kind: "summary" | "text"): boolean {
    return [...this.contexts.values()].some(
      (context) => !context.closing && context.status.active?.reasoning === kind,
    );
  }

  getThreadModel(threadId: string): ThreadModelEngineStatus {
    this.assertOpen();
    const context = this.contexts.get(threadId);
    if (!context || context.closing) throw new ThreadModelError("unavailable");
    return context.status;
  }

  assertThreadModelReady(threadId: string): void {
    const context = this.contexts.get(threadId);
    if (this.closed || context?.closing || context?.status.status !== "applied") {
      throw new ThreadModelError("unavailable");
    }
  }

  async createSession(input: CreateSessionInput = {}): Promise<AgentSession> {
    const id = input.id ?? randomUUID();
    return this.open(id, (engine) => engine.createSession({ ...input, id }));
  }

  async resumeSession(id: string): Promise<AgentSession> {
    return this.open(id, (engine) => engine.resumeSession(id));
  }

  async setThreadModel(
    params: LatestRuntimeMethodParams<"thread.model.set">,
  ): Promise<ThreadModelEngineStatus> {
    this.assertOpen();
    const context = this.contexts.get(params.threadId);
    if (!context?.session || context.closing) throw new ThreadModelError("unavailable");
    context.session.assertWritable();
    const catalog = this.host.catalog();
    if (catalog.configRevision !== params.configRevision) {
      throw new ThreadModelError("config-changed");
    }
    if (context.status.revision !== params.expectedRevision) {
      throw new ThreadModelError("revision-conflict");
    }

    let acceptedStatus: ThreadModelEngineStatus;
    if (!isEffortAwareModelCatalog(catalog)) {
      if (params.effort !== undefined || params.selection === undefined) {
        throw new ThreadModelError("effort-unsupported", "当前宿主不支持会话级推理强度控制");
      }
      const nextSelection = params.selection;
      const identity =
        nextSelection.mode === "default"
          ? catalog.defaultModel
          : { provider: nextSelection.provider, model: nextSelection.model };
      const item = findCatalogItem(catalog, identity);
      if (!item?.available) {
        throw new ThreadModelError("model-unavailable");
      }
      acceptedStatus = {
        ...this.initialStatusV16(params.threadId, {
          revision: randomUUID(),
          selection: nextSelection,
          configRevision: catalog.configRevision,
        }),
        active: toLegacyActiveModel(context.status.active),
      };
    } else {
      const nextSelection = params.selection ?? context.status.selection;
      const currentEffort: ThreadEffortSelection = isThreadModelStatusV17(context.status)
        ? context.status.effort
        : { mode: "default" };
      const nextEffort = params.effort ?? currentEffort;
      const identity =
        nextSelection.mode === "default"
          ? catalog.defaultModel
          : { provider: nextSelection.provider, model: nextSelection.model };
      const isSameAppliedModelInSnapshot =
        context.appliedModel !== undefined &&
        context.appliedModel.configRevision === catalog.configRevision &&
        context.appliedModel.prepared.provider === identity.provider &&
        context.appliedModel.prepared.modelName === identity.model;

      // Validate before allocating a revision or aborting an already-accepted pending change.
      const target = this.validateTarget(
        catalog,
        identity,
        nextEffort,
        !isSameAppliedModelInSnapshot,
      );

      const previousActive = isActiveThreadModelV17(context.status.active)
        ? context.status.active
        : context.appliedModel && context.session
          ? this.activeV17(context.appliedModel.prepared, context.session, catalog)
          : null;
      acceptedStatus = {
        ...this.initialStatusV17(params.threadId, {
          revision: randomUUID(),
          selection: nextSelection,
          effort: nextEffort,
          target,
          configRevision: catalog.configRevision,
        }),
        active: previousActive,
      };
    }

    context.preparing?.controller.abort();
    context.preparing = undefined;
    context.reloadingPureDefault = false;
    context.status = acceptedStatus;
    await this.apply(context);
    this.assertOpen();
    if (context.closing) throw new ThreadModelError("unavailable");
    return context.status.revision === acceptedStatus.revision ? context.status : acceptedStatus;
  }

  settleThreadModel(threadId: string): Promise<void> {
    const context = this.contexts.get(threadId);
    return context ? this.apply(context) : Promise.resolve();
  }

  failThreadModelSettlement(threadId: string): void {
    const context = this.contexts.get(threadId);
    if (!context) return;
    context.failedSettlement = true;
    context.preparing?.controller.abort();
    context.status = toFailedStatus(context.status, "settlement-failed");
  }

  closeModelSelections(): void {
    for (const context of this.contexts.values()) {
      context.closing = true;
      context.preparing?.controller.abort();
    }
  }

  /** Called by Core after validating a reload; explicit policies are retained and revalidated. */
  async reloadModelHost(host: ThreadModelHost, initial: PreparedThreadModel): Promise<void> {
    this.assertOpen();
    this.host = host;
    this.initial = initial;
    const catalog = host.catalog();
    const configRevision = catalog.configRevision;
    const effortAware = isEffortAwareModelCatalog(catalog);
    const contexts = [...this.contexts.values()];
    for (const context of contexts) {
      context.preparing?.controller.abort();
      context.preparing = undefined;
      const selection = context.status.selection;
      const effort: ThreadEffortSelection = isThreadModelStatusV17(context.status)
        ? context.status.effort
        : { mode: "default" };
      context.reloadingPureDefault = selection.mode === "default" && effort.mode === "default";
      if (effortAware) {
        const retainedActive = isActiveThreadModelV17(context.status.active)
          ? context.status.active
          : context.appliedModel && context.session
            ? this.activeV17(context.appliedModel.prepared, context.session, catalog)
            : null;
        context.status = {
          ...this.initialStatusV17(context.status.threadId, {
            revision: randomUUID(),
            selection,
            effort,
            target: projectUnverifiedTarget(catalog, selection, effort),
            configRevision,
          }),
          active: retainedActive,
        };
      } else {
        const legacyBase: ThreadModelStatusV16 = {
          ...this.initialStatusV16(context.status.threadId, {
            revision: randomUUID(),
            selection,
            configRevision,
          }),
          active: toLegacyActiveModel(context.status.active),
        };
        context.status =
          effort.mode === "explicit" ? toFailedStatus(legacyBase, "config-changed") : legacyBase;
      }
    }
    await Promise.all(
      contexts.map(async (context) => {
        await this.opening.get(context.status.threadId);
        await this.apply(context);
      }),
    );
    // Explicit selections/efforts may fail independently; pure default application is the reload contract.
    if (
      contexts.some(
        (context) =>
          !context.closing &&
          context.status.configRevision === configRevision &&
          context.status.selection.mode === "default" &&
          (!isThreadModelStatusV17(context.status) || context.status.effort.mode === "default") &&
          context.status.status === "failed",
      )
    ) {
      throw new ThreadModelError("unavailable");
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    for (const context of this.contexts.values()) {
      context.closing = true;
      context.preparing?.controller.abort();
    }
    this.disposal = (async () => {
      // Abort child bootstrap before waiting for open(); it owns the host's shutdown signal.
      const closing = Promise.allSettled(
        [...this.contexts.values()].map((context) => context.engine?.dispose()),
      );
      await Promise.allSettled([...this.opening.values(), ...this.jobs]);
      const results = await closing;
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) {
        throw new AggregateError(errors, "Conversation model hosts failed to close");
      }
      this.contexts.clear();
    })();
    return this.disposal;
  }

  private open(
    id: string,
    open: (engine: ConversationEngine) => Promise<AgentSession>,
  ): Promise<AgentSession> {
    this.assertOpen();
    const pending = this.opening.get(id);
    if (pending) return pending;
    const live = this.contexts.get(id);
    if (live?.session) {
      if (live.closing) throw new ThreadModelError("unavailable");
      live.session.assertWritable();
      return Promise.resolve(live.session);
    }
    const job = (async () => {
      let context: ThreadContext | undefined;
      try {
        const initial = this.initial;
        const initialCatalog = this.host.catalog();
        const revision = randomUUID();
        let appliedInitial: PreparedThreadModel;
        let initialStatus: ThreadModelEngineStatus;
        let initialTarget: ThreadModelTarget | undefined;

        if (isEffortAwareModelCatalog(initialCatalog)) {
          const initialCapability = findCatalogItem(initialCatalog, {
            provider: initial.provider,
            model: initial.modelName,
          })?.effortCapability ??
            initial.effortCapability ?? { kind: "unknown" as const };
          const initialEffort = initial.effort ?? initialCatalog.defaultEffort;
          appliedInitial = {
            ...initial,
            effort: initialEffort,
            effortCapability: initialCapability,
          };
          initialTarget = {
            provider: initial.provider,
            model: initial.modelName,
            effectiveEffort: initialEffort,
            effortCapability: initialCapability,
          };
          initialStatus = this.initialStatusV17(id, {
            revision,
            selection: { mode: "default" },
            effort: { mode: "default" },
            target: initialTarget,
            configRevision: initialCatalog.configRevision,
          });
        } else {
          appliedInitial = initial;
          initialStatus = this.initialStatusV16(id, {
            revision,
            selection: { mode: "default" },
            configRevision: initialCatalog.configRevision,
          });
        }

        context = {
          status: initialStatus,
          appliedModel: undefined,
          reloadingPureDefault: false,
          engine: undefined,
          session: undefined,
          preparing: undefined,
          closing: false,
          failedSettlement: false,
        };
        this.contexts.set(id, context);
        const engine = this.createChild(context, appliedInitial, id);
        context.engine = engine;
        const session = await open(engine);
        this.assertOpen();
        context.session = session;
        context.appliedModel = {
          configRevision: initialCatalog.configRevision,
          prepared: appliedInitial,
        };
        if (context.status.revision === revision && context.status.status === "pending") {
          // The child already bootstrapped this prepared model and its Sampling scope.
          if (
            isThreadModelStatusV17(context.status) &&
            isEffortAwareModelCatalog(initialCatalog) &&
            initialTarget !== undefined
          ) {
            context.status = toAppliedStatusV17(
              context.status,
              initialTarget,
              this.activeV17(appliedInitial, session, initialCatalog),
            );
          } else if (!isThreadModelStatusV17(context.status)) {
            context.status = toAppliedStatusV16(
              context.status,
              this.activeV16(appliedInitial, session),
            );
          }
        } else {
          do {
            await this.apply(context);
          } while (
            !this.closed &&
            !context.closing &&
            context.status.status === "pending" &&
            !this.busy(context)
          );
        }
        this.assertOpen();
        if (context.closing || context.status.status === "pending") {
          throw new ThreadModelError("unavailable");
        }
        return session;
      } catch (error) {
        await context?.engine?.dispose();
        this.contexts.delete(id);
        throw error;
      }
    })().finally(() => this.opening.delete(id));
    this.opening.set(id, job);
    return job;
  }

  private createChild(
    context: ThreadContext,
    initial: PreparedThreadModel,
    id: string,
  ): ConversationEngine {
    return this.options.createEngine(initial, {
      onBeforeModelUse: () => this.assertThreadModelReady(id),
      onSessionCloseRequested: () => {
        context.closing = true;
        context.preparing?.controller.abort();
      },
      onSessionClosed: () => {
        if (this.contexts.get(id) === context) this.contexts.delete(id);
      },
      disposeHostOnSessionClose: true,
    });
  }

  private initialStatusV17(
    id: string,
    record: Pick<
      ThreadModelStatus,
      "revision" | "selection" | "effort" | "target" | "configRevision"
    >,
  ): Extract<ThreadModelStatus, { status: "pending" }> {
    return {
      threadId: threadIdSchema.parse(id),
      revision: record.revision,
      selection: record.selection,
      effort: record.effort,
      target: record.target,
      configRevision: record.configRevision,
      status: "pending",
      active: null,
    };
  }

  private initialStatusV16(
    id: string,
    record: Pick<ThreadModelStatusV16, "revision" | "selection" | "configRevision">,
  ): Extract<ThreadModelStatusV16, { status: "pending" }> {
    return {
      threadId: threadIdSchema.parse(id),
      revision: record.revision,
      selection: record.selection,
      configRevision: record.configRevision,
      status: "pending",
      active: null,
    };
  }

  private activeV16(model: PreparedThreadModel, session: AgentSession): ActiveThreadModelV16 {
    const contextWindow = session.getContextWindow();
    return {
      provider: model.provider,
      model: model.modelName,
      reasoning: model.reasoning ?? null,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }

  private activeV17(
    model: PreparedThreadModel,
    session: AgentSession,
    catalog: RuntimeModelCatalog,
  ): ActiveThreadModel {
    const effort = model.effort ?? catalog.defaultEffort;
    const effortCapability = model.effortCapability ??
      findCatalogItem(catalog, { provider: model.provider, model: model.modelName })
        ?.effortCapability ?? { kind: "unknown" as const };
    return {
      ...this.activeV16(model, session),
      effort,
      effortCapability,
    };
  }

  private busy(context: ThreadContext): boolean {
    return this.isExternallyBusy(context.status.threadId) || !context.session?.canSwitchModel();
  }

  private validateTarget(
    catalog: RuntimeModelCatalog,
    identity: RuntimeModelCatalog["defaultModel"],
    effort: ThreadEffortSelection,
    requiresFullModelPrepare: boolean,
  ): ValidatedThreadModelTarget {
    if (this.host.validate) {
      return this.host.validate({ identity, effort, requiresFullModelPrepare });
    }
    return defaultValidateTarget(catalog, { identity, effort, requiresFullModelPrepare });
  }

  private async prepare(context: ThreadContext, signal: AbortSignal): Promise<PreparedThreadModel> {
    signal.throwIfAborted();
    const host = this.host;
    const catalog = host.catalog();
    const selection = context.status.selection;
    const identity =
      selection.mode === "default"
        ? catalog.defaultModel
        : { provider: selection.provider, model: selection.model };

    if (!isEffortAwareModelCatalog(catalog)) {
      const item = findCatalogItem(catalog, identity);
      if (!item?.available) {
        throw new ThreadModelError("model-unavailable");
      }
      const prepared = await host.prepare(identity, signal);
      signal.throwIfAborted();
      if (catalog.configRevision !== this.host.catalog().configRevision) {
        throw new ThreadModelError("config-changed");
      }
      if (prepared.provider !== identity.provider || prepared.modelName !== identity.model) {
        throw new ThreadModelError("model-unavailable");
      }
      return prepared;
    }

    const effort: ThreadEffortSelection = isThreadModelStatusV17(context.status)
      ? context.status.effort
      : { mode: "default" };
    let validated: ValidatedThreadModelTarget;
    if (context.reloadingPureDefault) {
      const item = findCatalogItem(catalog, identity);
      if (!item?.available) {
        throw new ThreadModelError("model-unavailable");
      }
      validated = {
        provider: identity.provider,
        model: identity.model,
        effectiveEffort: catalog.defaultEffort,
        effortCapability: item.effortCapability,
      };
    } else {
      validated = this.validateTarget(catalog, identity, effort, true);
    }
    const prepared = await host.prepare(identity, signal, validated.effectiveEffort);
    signal.throwIfAborted();
    if (catalog.configRevision !== this.host.catalog().configRevision) {
      throw new ThreadModelError("config-changed");
    }
    if (prepared.provider !== identity.provider || prepared.modelName !== identity.model) {
      throw new ThreadModelError("model-unavailable");
    }
    return {
      ...prepared,
      effort: prepared.effort ?? validated.effectiveEffort,
      effortCapability: prepared.effortCapability ?? validated.effortCapability,
    };
  }

  private readyToCommit(
    context: ThreadContext,
    preparing: AbortController,
    revision: string,
    configRevision: string,
  ): boolean {
    if (
      this.closed ||
      context.closing ||
      context.preparing?.controller !== preparing ||
      preparing.signal.aborted ||
      context.status.revision !== revision
    ) {
      return false;
    }
    if (this.host.catalog().configRevision !== configRevision) {
      context.status = toFailedStatus(context.status, "config-changed");
      return false;
    }
    return !this.busy(context);
  }

  private apply(context: ThreadContext): Promise<void> {
    if (
      this.closed ||
      context.closing ||
      context.status.status !== "pending" ||
      this.busy(context)
    ) {
      return Promise.resolve();
    }
    if (context.preparing) return context.preparing.settled;
    if (context.failedSettlement) {
      this.failThreadModelSettlement(context.status.threadId);
      return Promise.resolve();
    }
    const preparing = new AbortController();
    const revision = context.status.revision;
    const configRevision = context.status.configRevision;
    const job = Promise.resolve().then(async () => {
      let committing = false;
      try {
        const host = this.host;
        const applied = context.appliedModel;
        const statusSnapshot = context.status;
        if (
          isThreadModelStatusV17(statusSnapshot) &&
          host.prepareEffort !== undefined &&
          applied !== undefined &&
          applied.configRevision === configRevision &&
          applied.prepared.provider === statusSnapshot.target.provider &&
          applied.prepared.modelName === statusSnapshot.target.model
        ) {
          if (!this.readyToCommit(context, preparing, revision, configRevision)) return;
          const currentCatalog = host.catalog();
          if (!isEffortAwareModelCatalog(currentCatalog)) {
            throw new ThreadModelError("config-changed");
          }
          const validated = this.validateTarget(
            currentCatalog,
            {
              provider: statusSnapshot.target.provider,
              model: statusSnapshot.target.model,
            },
            statusSnapshot.effort,
            false,
          );
          const effortUpdate = host.prepareEffort(applied.prepared, validated.effectiveEffort);
          if (!this.readyToCommit(context, preparing, revision, configRevision)) return;
          context.session?.assertWritable();
          committing = true;
          context.session?.setProviderOptions(effortUpdate.providerOptions);
          const {
            providerOptions: _oldProviderOptions,
            reasoning: _oldReasoning,
            ...preservedModelFields
          } = applied.prepared;
          const nextPrepared: PreparedThreadModel = {
            ...preservedModelFields,
            ...(effortUpdate.providerOptions
              ? { providerOptions: effortUpdate.providerOptions }
              : {}),
            ...(effortUpdate.reasoning ? { reasoning: effortUpdate.reasoning } : {}),
            effort: effortUpdate.effort,
            effortCapability: effortUpdate.effortCapability,
          };
          if (context.session && isThreadModelStatusV17(context.status)) {
            context.appliedModel = { configRevision, prepared: nextPrepared };
            context.status = toAppliedStatusV17(
              context.status,
              validated,
              this.activeV17(nextPrepared, context.session, currentCatalog),
            );
          }
          return;
        }

        const prepared = await this.prepare(context, preparing.signal);
        if (!this.readyToCommit(context, preparing, revision, configRevision)) return;
        context.session?.assertWritable();
        committing = true;
        context.engine?.switchModel(prepared, { persistHistoryLabel: false });
        if (context.session) {
          context.appliedModel = { configRevision, prepared };
          const currentCatalog = this.host.catalog();
          if (isThreadModelStatusV17(context.status) && isEffortAwareModelCatalog(currentCatalog)) {
            const target: ThreadModelTarget = {
              provider: prepared.provider,
              model: prepared.modelName,
              effectiveEffort: prepared.effort ?? currentCatalog.defaultEffort,
              effortCapability: prepared.effortCapability ?? context.status.target.effortCapability,
            };
            context.status = toAppliedStatusV17(
              context.status,
              target,
              this.activeV17(prepared, context.session, currentCatalog),
            );
          } else if (!isThreadModelStatusV17(context.status)) {
            context.status = toAppliedStatusV16(
              context.status,
              this.activeV16(prepared, context.session),
            );
          }
        }
      } catch (error) {
        if (
          !this.closed &&
          !context.closing &&
          context.preparing?.controller === preparing &&
          !preparing.signal.aborted
        ) {
          const reason = committing ? "apply-failed" : modelFailure(error);
          context.status = toFailedStatus(context.status, reason);
        }
      } finally {
        if (context.preparing?.controller === preparing) context.preparing = undefined;
      }
    });
    context.preparing = { controller: preparing, settled: job };
    this.jobs.add(job);
    job.finally(() => this.jobs.delete(job));
    return job;
  }

  private assertOpen(): void {
    if (this.closed) throw new ThreadModelError("unavailable");
  }
}

function modelFailure(error: unknown): ThreadModelFailure {
  if (error instanceof ThreadModelError) {
    if (error.reason === "model-unavailable" || error.reason === "config-changed") {
      return error.reason;
    }
    if (
      error.reason === "effort-unsupported" ||
      error.reason === "compaction-effort-incompatible"
    ) {
      return "effort-unsupported";
    }
  }
  return "prepare-failed";
}
