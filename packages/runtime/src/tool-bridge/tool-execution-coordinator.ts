import type { NormalizedToolResult } from "./normalize-result.ts";
import { TOOL_OUTCOME_KINDS, failedToolResult, readToolOutcome } from "./normalize-result.ts";

export const TOOL_RESOURCE_ACCESS_MODES = {
  read: "read",
  write: "write",
} as const;

export type ToolResourceAccessMode =
  (typeof TOOL_RESOURCE_ACCESS_MODES)[keyof typeof TOOL_RESOURCE_ACCESS_MODES];

export interface ToolResourceAccess {
  readonly key: string;
  readonly mode: ToolResourceAccessMode;
}

export const TOOL_RESOURCE_HINT_KINDS = {
  file: "file",
  browserSession: "browser-session",
  conversation: "conversation",
  custom: "custom",
} as const;

export type ToolResourceHintKind =
  (typeof TOOL_RESOURCE_HINT_KINDS)[keyof typeof TOOL_RESOURCE_HINT_KINDS];

export interface ToolResourceHint {
  /** Top-level tool input field containing one resource id or an array of ids. */
  readonly field: string;
  readonly kind: ToolResourceHintKind;
  readonly mode?: ToolResourceAccessMode;
  /** Required for `custom`; ignored for built-in kinds. */
  readonly namespace?: string;
}

export interface ToolExecutionPlan {
  readonly prepare?: (
    input: unknown,
  ) => NormalizedToolResult | undefined | Promise<NormalizedToolResult | undefined>;
  readonly resources: (input: unknown) => readonly ToolResourceAccess[];
}

interface PreparedToolCall {
  readonly toolId: string;
  readonly input: unknown;
  readonly batch: BatchState | undefined;
  readonly blocked: NormalizedToolResult | undefined;
}

interface BatchAdmission {
  readonly promise: Promise<void>;
  readonly release: () => void;
  released: boolean;
}

interface BatchState {
  readonly callId: string;
  readonly toolCallIds: Set<string>;
  readonly preparedToolCallIds: Set<string>;
  readonly completedToolCallIds: Set<string>;
  readonly admission: BatchAdmission;
  userRejected: boolean;
  cancelled: boolean;
  sealed: boolean;
}

export interface ToolBatchCall {
  readonly toolCallId: string;
  readonly toolId: string;
}

interface LockWaiter {
  readonly mode: ToolResourceAccessMode;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

interface LockState {
  readers: number;
  writer: boolean;
  readonly queue: LockWaiter[];
}

class ToolExecutionCancelledError extends Error {
  constructor() {
    super("tool execution cancelled");
    this.name = "ToolExecutionCancelledError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new ToolExecutionCancelledError();
}

function createBatchAdmission(): BatchAdmission {
  const deferred = Promise.withResolvers<void>();
  return {
    promise: deferred.promise,
    release: deferred.resolve,
    released: false,
  };
}

function waitForAdmission(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function normalizeResources(resources: readonly ToolResourceAccess[]): ToolResourceAccess[] {
  const byKey = new Map<string, ToolResourceAccessMode>();
  for (const resource of resources) {
    const key = resource.key.trim();
    if (key.length === 0) {
      continue;
    }
    const current = byKey.get(key);
    if (current === undefined || resource.mode === TOOL_RESOURCE_ACCESS_MODES.write) {
      byKey.set(key, resource.mode);
    }
  }
  return [...byKey]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, mode]) => ({ key, mode }));
}

class ResourceLockManager {
  private readonly locks = new Map<string, LockState>();

  async run<T>(
    resources: readonly ToolResourceAccess[],
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      for (const resource of normalizeResources(resources)) {
        releases.push(await this.acquire(resource, signal));
      }
      if (signal?.aborted) {
        throw new ToolExecutionCancelledError();
      }
      return await operation();
    } finally {
      for (const release of releases.reverse()) {
        release();
      }
    }
  }

  private acquire(
    resource: ToolResourceAccess,
    signal: AbortSignal | undefined,
  ): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new ToolExecutionCancelledError());
    }
    const state = this.locks.get(resource.key) ?? { readers: 0, writer: false, queue: [] };
    this.locks.set(resource.key, state);

    const queuedWriter = state.queue.some(
      (waiter) => waiter.mode === TOOL_RESOURCE_ACCESS_MODES.write,
    );
    const immediatelyAvailable =
      resource.mode === TOOL_RESOURCE_ACCESS_MODES.read
        ? !state.writer && !queuedWriter
        : !state.writer && state.readers === 0 && state.queue.length === 0;
    if (immediatelyAvailable) {
      this.grant(state, resource.mode);
      return Promise.resolve(() => this.release(resource.key, state, resource.mode));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = {
        mode: resource.mode,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          this.grant(state, resource.mode);
          resolve(() => this.release(resource.key, state, resource.mode));
        },
        reject,
        signal,
        onAbort: signal === undefined ? undefined : () => onAbort(),
      };
      const onAbort = (): void => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) {
          state.queue.splice(index, 1);
        }
        reject(new ToolExecutionCancelledError());
        this.drain(resource.key, state);
      };
      state.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private grant(state: LockState, mode: ToolResourceAccessMode): void {
    if (mode === TOOL_RESOURCE_ACCESS_MODES.read) {
      state.readers += 1;
    } else {
      state.writer = true;
    }
  }

  private release(key: string, state: LockState, mode: ToolResourceAccessMode): void {
    if (mode === TOOL_RESOURCE_ACCESS_MODES.read) {
      state.readers -= 1;
    } else {
      state.writer = false;
    }
    this.drain(key, state);
  }

  private drain(key: string, state: LockState): void {
    if (state.writer || state.readers > 0) {
      return;
    }
    while (state.queue[0]?.signal?.aborted) {
      const aborted = state.queue.shift();
      aborted?.reject(new ToolExecutionCancelledError());
    }
    const first = state.queue[0];
    if (first === undefined) {
      this.locks.delete(key);
      return;
    }
    if (first.mode === TOOL_RESOURCE_ACCESS_MODES.write) {
      state.queue.shift();
      first.resolve();
      return;
    }
    while (state.queue[0]?.mode === TOOL_RESOURCE_ACCESS_MODES.read) {
      state.queue.shift()?.resolve();
    }
  }
}

/**
 * Coordinates one AI SDK model-call batch in two phases:
 * 1. all preflight / policy / user approvals run serially while tool calls stream in;
 * 2. approved calls run concurrently, constrained only by resource read/write conflicts.
 */
export class ToolExecutionCoordinator {
  private readonly plans = new Map<string, ToolExecutionPlan>();
  private readonly prepared = new Map<string, PreparedToolCall>();
  private readonly batches = new Map<string, BatchState>();
  private readonly toolCallBatches = new Map<string, BatchState>();
  private readonly locks = new ResourceLockManager();
  private activeBatch: BatchState | undefined;
  private preparationTail: Promise<void> = Promise.resolve();

  register(toolId: string, plan: ToolExecutionPlan): void {
    this.plans.set(toolId, plan);
  }

  /** Returns the same normalized resource plan used by execution, without acquiring locks. */
  describeResources(toolId: string, input: unknown): readonly ToolResourceAccess[] {
    try {
      return [...(this.plans.get(toolId)?.resources(input) ?? [])];
    } catch {
      // Resource planning must never make event/ledger observation fail. The actual execute path
      // will still surface the planner error as a typed Tool outcome.
      return [];
    }
  }

  startBatch(callId: string): void {
    if (this.activeBatch && !this.activeBatch.sealed) {
      this.cancelBatch(this.activeBatch);
    }
    const batch: BatchState = {
      callId,
      toolCallIds: new Set<string>(),
      preparedToolCallIds: new Set<string>(),
      completedToolCallIds: new Set<string>(),
      admission: createBatchAdmission(),
      userRejected: false,
      cancelled: false,
      sealed: false,
    };
    this.batches.set(callId, batch);
    this.activeBatch = batch;
  }

  async prepare(toolCallId: string, toolId: string, input: unknown): Promise<void> {
    // In AI SDK streaming, the upstream model-call-end hook can run before the downstream
    // toolApproval transform has drained every buffered tool call. sealBatch() therefore records
    // the complete call-id set so late prepare() calls still join the correct batch.
    const batch = this.toolCallBatches.get(toolCallId) ?? this.activeBatch;
    if (batch) {
      this.trackBatchCall(batch, toolCallId);
    }
    const previous = this.preparationTail;
    let release: (() => void) | undefined;
    this.preparationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const plan = this.plans.get(toolId);
      const blocked = batch?.cancelled
        ? failedToolResult(TOOL_OUTCOME_KINDS.cancelled, "工具批次已结束，本调用未执行")
        : batch?.userRejected
          ? failedToolResult(TOOL_OUTCOME_KINDS.cancelled, "同批次已有工具被用户拒绝，本调用未执行")
          : await this.prepareWithPlan(plan, input);
      if (blocked && readToolOutcome(blocked).kind === TOOL_OUTCOME_KINDS.userRejected) {
        if (batch) {
          batch.userRejected = true;
        }
      }
      if (batch?.cancelled !== true) {
        this.prepared.set(toolCallId, { toolId, input, batch, blocked });
      }
    } finally {
      if (batch) {
        batch.preparedToolCallIds.add(toolCallId);
        this.releaseBatchAdmissionIfReady(batch);
      }
      release?.();
    }
  }

  sealBatch(callId: string, calls: readonly ToolBatchCall[] = []): void {
    const batch = this.batches.get(callId);
    if (batch) {
      for (const call of calls) {
        if (!this.plans.has(call.toolId)) {
          continue;
        }
        this.trackBatchCall(batch, call.toolCallId);
      }
      batch.sealed = true;
      this.releaseBatchAdmissionIfReady(batch);
      if (batch.toolCallIds.size === 0) {
        this.batches.delete(callId);
      }
    }
    if (this.activeBatch?.callId === callId) {
      this.activeBatch = undefined;
    }
  }

  /** Clears incomplete batch bookkeeping when one Agent turn reaches a terminal state. */
  finishTurn(): void {
    for (const batch of this.batches.values()) {
      this.cancelBatch(batch);
    }
    this.prepared.clear();
    this.batches.clear();
    this.toolCallBatches.clear();
    this.activeBatch = undefined;
    this.preparationTail = Promise.resolve();
  }

  async execute(
    toolCallId: string,
    toolId: string,
    input: unknown,
    abortSignal: AbortSignal | undefined,
    operation: () => Promise<NormalizedToolResult>,
  ): Promise<NormalizedToolResult> {
    const batch = this.toolCallBatches.get(toolCallId) ?? this.activeBatch;
    if (batch) {
      this.trackBatchCall(batch, toolCallId);
    }
    let prepared: PreparedToolCall | undefined;

    try {
      if (batch) {
        await waitForAdmission(batch.admission.promise, abortSignal);
        if (batch.cancelled) {
          return failedToolResult(TOOL_OUTCOME_KINDS.cancelled, "工具批次已结束，本调用未执行");
        }
      }
      prepared = this.prepared.get(toolCallId);
      if (prepared === undefined) {
        if (batch) {
          return failedToolResult(
            TOOL_OUTCOME_KINDS.toolFailed,
            "工具批次准入状态不完整，本调用未执行",
          );
        }
        if (abortSignal?.aborted) {
          throw abortError(abortSignal);
        }
        const plan = this.plans.get(toolId);
        prepared = {
          toolId,
          input,
          batch: undefined,
          blocked: await this.prepareWithPlan(plan, input),
        };
      }
      if (prepared.blocked) {
        return prepared.blocked;
      }
      if (prepared.batch?.userRejected) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.cancelled,
          "同批次已有工具被用户拒绝，本调用未执行",
        );
      }
      if (abortSignal?.aborted) {
        throw abortError(abortSignal);
      }
      const plan = this.plans.get(toolId);
      const resources = plan?.resources(input) ?? [];
      return await this.locks.run(resources, abortSignal, operation);
    } catch (error) {
      if (abortSignal?.aborted) {
        throw abortError(abortSignal);
      }
      return error instanceof ToolExecutionCancelledError
        ? failedToolResult(TOOL_OUTCOME_KINDS.cancelled, "工具调用已取消", { raw: error })
        : failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, errorMessage(error), { raw: error });
    } finally {
      const owningBatch = prepared?.batch ?? batch;
      const currentPrepared = this.prepared.get(toolCallId);
      if (
        (prepared !== undefined && currentPrepared === prepared) ||
        (prepared === undefined &&
          owningBatch !== undefined &&
          currentPrepared?.batch === owningBatch)
      ) {
        this.prepared.delete(toolCallId);
      }
      this.completeBatchCall(owningBatch, toolCallId);
    }
  }

  private async prepareWithPlan(
    plan: ToolExecutionPlan | undefined,
    input: unknown,
  ): Promise<NormalizedToolResult | undefined> {
    try {
      return await plan?.prepare?.(input);
    } catch (error) {
      return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, errorMessage(error), { raw: error });
    }
  }

  private completeBatchCall(batch: BatchState | undefined, toolCallId: string): void {
    if (!batch) {
      return;
    }
    batch.completedToolCallIds.add(toolCallId);
    this.cleanupBatchIfComplete(batch);
  }

  private trackBatchCall(batch: BatchState, toolCallId: string): void {
    batch.toolCallIds.add(toolCallId);
    this.toolCallBatches.set(toolCallId, batch);
  }

  private releaseBatchAdmissionIfReady(batch: BatchState): void {
    if (!batch.admission.released) {
      if (!batch.sealed) {
        return;
      }
      if (
        !batch.cancelled &&
        [...batch.toolCallIds].some((toolCallId) => !batch.preparedToolCallIds.has(toolCallId))
      ) {
        return;
      }
      batch.admission.released = true;
      batch.admission.release();
    }
    this.cleanupBatchIfComplete(batch);
  }

  private cancelBatch(batch: BatchState): void {
    batch.cancelled = true;
    batch.sealed = true;
    this.releaseBatchAdmissionIfReady(batch);
  }

  private cleanupBatchIfComplete(batch: BatchState): void {
    if (!batch.admission.released || batch.completedToolCallIds.size < batch.toolCallIds.size) {
      return;
    }
    if (this.batches.get(batch.callId) === batch) {
      this.batches.delete(batch.callId);
    }
    for (const toolCallId of batch.toolCallIds) {
      if (this.toolCallBatches.get(toolCallId) === batch) {
        this.toolCallBatches.delete(toolCallId);
      }
      if (this.prepared.get(toolCallId)?.batch === batch) {
        this.prepared.delete(toolCallId);
      }
    }
  }
}

export async function executeCoordinatedTool(
  coordinator: ToolExecutionCoordinator | undefined,
  plan: ToolExecutionPlan,
  toolId: string,
  toolCallId: string,
  input: unknown,
  abortSignal: AbortSignal | undefined,
  operation: () => Promise<NormalizedToolResult>,
): Promise<NormalizedToolResult> {
  if (coordinator) {
    return coordinator.execute(toolCallId, toolId, input, abortSignal, operation);
  }
  try {
    if (abortSignal?.aborted) {
      throw abortError(abortSignal);
    }
    const blocked = await plan.prepare?.(input);
    if (blocked) {
      return blocked;
    }
    if (abortSignal?.aborted) {
      throw abortError(abortSignal);
    }
    return await operation();
  } catch (error) {
    if (abortSignal?.aborted) {
      throw abortError(abortSignal);
    }
    return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, errorMessage(error), { raw: error });
  }
}
