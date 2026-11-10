import { randomUUID } from "node:crypto";
import {
  threadIdSchema,
  type RuntimeModelCatalog,
  type ThreadModelStatus,
  type LatestRuntimeMethodParams,
} from "@roll-agent/protocol";
import type { AgentSession } from "./agent-session.ts";
import type {
  ConversationEngine,
  ConversationEngineOptions,
  CreateSessionInput,
  EngineModelSwitch,
} from "./conversation-engine.ts";

export interface PreparedThreadModel extends EngineModelSwitch {
  readonly reasoning?: "summary" | "text";
}

/** Product configuration/provider construction belongs to the injecting host. */
export interface ThreadModelHost {
  catalog(): RuntimeModelCatalog;
  prepare(
    identity: RuntimeModelCatalog["defaultModel"],
    signal: AbortSignal,
  ): Promise<PreparedThreadModel>;
}

export type ThreadModelFailure = Extract<ThreadModelStatus, { status: "failed" }>["reason"];
export class ThreadModelError extends Error {
  readonly reason: "revision-conflict" | "config-changed" | "model-unavailable" | "unavailable";
  constructor(reason: ThreadModelError["reason"]) {
    super(`Conversation model selection: ${reason}`);
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

interface ThreadContext {
  status: ThreadModelStatus;
  engine: ConversationEngine | undefined;
  session: AgentSession | undefined;
  preparing: { readonly controller: AbortController; readonly settled: Promise<void> } | undefined;
  closing: boolean;
  failedSettlement: boolean;
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
  getModelCatalog(): RuntimeModelCatalog {
    this.assertOpen();
    return this.host.catalog();
  }
  hasThreadReasoning(kind: "summary" | "text"): boolean {
    return [...this.contexts.values()].some(
      (context) => !context.closing && context.status.active?.reasoning === kind,
    );
  }

  getThreadModel(threadId: string): ThreadModelStatus {
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
  ): Promise<ThreadModelStatus> {
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
    const identity = params.selection.mode === "default" ? catalog.defaultModel : params.selection;
    if (
      !catalog.items.some(
        (item) =>
          item.available && item.provider === identity.provider && item.model === identity.model,
      )
    ) {
      throw new ThreadModelError("model-unavailable");
    }
    const record = { revision: randomUUID(), selection: params.selection };
    context.preparing?.controller.abort();
    context.preparing = undefined;
    context.status = {
      ...this.initialStatus(params.threadId, record),
      active: context.status.active,
    };
    await this.apply(context);
    this.assertOpen();
    if (context.closing) throw new ThreadModelError("unavailable");
    return context.status;
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
    context.status = { ...context.status, status: "failed", reason: "settlement-failed" };
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
    const configRevision = host.catalog().configRevision;
    const contexts = [...this.contexts.values()];
    for (const context of contexts) {
      context.preparing?.controller.abort();
      context.preparing = undefined;
      context.status = {
        ...this.initialStatus(context.status.threadId, {
          revision: randomUUID(),
          selection: context.status.selection,
        }),
        active: context.status.active,
      };
    }
    await Promise.all(
      contexts.map(async (context) => {
        await this.opening.get(context.status.threadId);
        await this.apply(context);
      }),
    );
    // Explicit selections may disappear independently; default application is the reload contract.
    if (
      contexts.some(
        (context) =>
          !context.closing &&
          context.status.configRevision === configRevision &&
          context.status.selection.mode === "default" &&
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
        const record = { revision: randomUUID(), selection: { mode: "default" } as const };
        context = {
          status: this.initialStatus(id, record),
          engine: undefined,
          session: undefined,
          preparing: undefined,
          closing: false,
          failedSettlement: false,
        };
        this.contexts.set(id, context);
        const initial = this.initial;
        const engine = this.createChild(context, id);
        context.engine = engine;
        const session = await open(engine);
        this.assertOpen();
        context.session = session;
        if (context.status.revision === record.revision && context.status.status === "pending") {
          // The child already bootstrapped this prepared model and its Sampling scope.
          context.status = {
            ...context.status,
            status: "applied",
            active: this.active(initial, session),
          };
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

  private createChild(context: ThreadContext, id: string): ConversationEngine {
    return this.options.createEngine(this.initial, {
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

  private initialStatus(
    id: string,
    record: Pick<ThreadModelStatus, "revision" | "selection">,
  ): Extract<ThreadModelStatus, { status: "pending" }> {
    return {
      threadId: threadIdSchema.parse(id),
      revision: record.revision,
      selection: record.selection,
      configRevision: this.host.catalog().configRevision,
      status: "pending",
      active: null,
    };
  }

  private active(
    model: PreparedThreadModel,
    session: AgentSession,
  ): NonNullable<ThreadModelStatus["active"]> {
    const contextWindow = session.getContextWindow();
    return {
      provider: model.provider,
      model: model.modelName,
      reasoning: model.reasoning ?? null,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }

  private busy(context: ThreadContext): boolean {
    return this.isExternallyBusy(context.status.threadId) || !context.session?.canSwitchModel();
  }

  private async prepare(context: ThreadContext, signal: AbortSignal): Promise<PreparedThreadModel> {
    signal.throwIfAborted();
    const catalog = this.host.catalog();
    const selection = context.status.selection;
    const identity = selection.mode === "default" ? catalog.defaultModel : selection;
    if (
      !catalog.items.some(
        (item) =>
          item.available && item.provider === identity.provider && item.model === identity.model,
      )
    ) {
      throw new ThreadModelError("model-unavailable");
    }
    const prepared = await this.host.prepare(identity, signal);
    signal.throwIfAborted();
    if (catalog.configRevision !== this.host.catalog().configRevision) {
      throw new ThreadModelError("config-changed");
    }
    if (prepared.provider !== identity.provider || prepared.modelName !== identity.model) {
      throw new ThreadModelError("model-unavailable");
    }
    return prepared;
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
        const prepared = await this.prepare(context, preparing.signal);
        if (
          this.closed ||
          context.closing ||
          context.preparing?.controller !== preparing ||
          preparing.signal.aborted
        ) {
          return;
        }
        if (context.status.revision !== revision) return;
        if (this.host.catalog().configRevision !== configRevision) {
          context.status = { ...context.status, status: "failed", reason: "config-changed" };
          return;
        }
        if (this.busy(context)) return;
        context.session?.assertWritable();
        committing = true;
        context.engine?.switchModel(prepared, { persistHistoryLabel: false });
        if (context.session) {
          context.status = {
            ...context.status,
            status: "applied",
            active: this.active(prepared, context.session),
          };
        }
      } catch (error) {
        if (
          !this.closed &&
          !context.closing &&
          context.preparing?.controller === preparing &&
          !preparing.signal.aborted
        ) {
          const reason = committing ? "apply-failed" : modelFailure(error);
          context.status = { ...context.status, status: "failed", reason };
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
  if (
    error instanceof ThreadModelError &&
    (error.reason === "model-unavailable" || error.reason === "config-changed")
  ) {
    return error.reason;
  }
  return "prepare-failed";
}
