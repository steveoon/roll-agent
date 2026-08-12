import { createHash } from "node:crypto";
import {
  RUNTIME_ERROR_CODES_V13,
  RUNTIME_METHODS,
  RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES,
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS,
  compareRuntimeEventCursors,
  runtimeEventCursorDistance,
  type InitializeResult,
  type RuntimeEventCursor,
  type RuntimeEventEnvelope,
  type RuntimeEventId,
  type RuntimeInstanceId,
  type RuntimeMethodInputForVersion,
  type RuntimeMethodResultForVersion,
  type RuntimeProtocolVersion,
  type ThreadId,
} from "@roll-agent/protocol";

export const DEFAULT_RUNTIME_EVENT_RECOVERY_MAX_BUFFERED_EVENTS =
  RUNTIME_V13_MAX_DURABLE_EVENT_RECORDS;
export const DEFAULT_RUNTIME_EVENT_RECOVERY_MAX_BUFFERED_BYTES =
  RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES;

const RECOVERY_PHASES = {
  buffering: "buffering",
  draining: "draining",
  live: "live",
  failed: "failed",
  stopped: "stopped",
} as const;

const RECOVERY_MODES = {
  resumed: "resumed",
  snapshotResumed: "snapshot-resumed",
  snapshotOnly: "snapshot-only",
} as const;

export const RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS = {
  initial: "initial",
  runtimeRestarted: "runtime-restarted",
  cursorExpired: "cursor-expired",
  cursorGap: "cursor-gap",
  streamGap: "stream-gap",
  bufferOverflow: "buffer-overflow",
  cursorConflict: "cursor-conflict",
  protocolUnsupported: "protocol-unsupported",
} as const;

type RuntimeEventRecoveryPhase = (typeof RECOVERY_PHASES)[keyof typeof RECOVERY_PHASES];
export type RuntimeEventRecoveryMode = (typeof RECOVERY_MODES)[keyof typeof RECOVERY_MODES];
export type RuntimeEventRecoverySnapshotReason =
  (typeof RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS)[keyof typeof RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS];

export type RuntimeDurableEventEnvelope = Extract<
  RuntimeEventEnvelope,
  { readonly protocolVersion: "1.3" | "1.4"; readonly durability: "durable" }
>;
export type RuntimeEphemeralEventEnvelope = Extract<
  RuntimeEventEnvelope,
  { readonly protocolVersion: "1.3" | "1.4"; readonly durability: "ephemeral" }
>;
export type RuntimeEventRecoverySnapshot = RuntimeMethodResultForVersion<
  RuntimeProtocolVersion,
  typeof RUNTIME_METHODS.threadSnapshot
>;
type RuntimeEventsResumeInput = RuntimeMethodInputForVersion<
  "1.3",
  typeof RUNTIME_METHODS.runtimeEventsResume
>;
type RuntimeEventsResumeResult = RuntimeMethodResultForVersion<
  "1.3",
  typeof RUNTIME_METHODS.runtimeEventsResume
>;

export interface RuntimeEventRecoveryCheckpoint {
  readonly threadId: ThreadId;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly cursor: RuntimeEventCursor | null;
}

export interface RuntimeEventRecoverySnapshotContext {
  readonly reason: RuntimeEventRecoverySnapshotReason;
  readonly protocolVersion: RuntimeProtocolVersion;
  /** True only for the byte-bounded Protocol 1.3 checkpoint projection. */
  readonly recoveryProjection: boolean;
}

export interface RuntimeEventRecoveryErrorContext {
  readonly threadId: ThreadId;
  readonly phase: RuntimeEventRecoveryPhase;
}

export interface RuntimeEventRecoveryThreadOptions {
  readonly threadId: ThreadId;
  readonly checkpoint?: RuntimeEventRecoveryCheckpoint;
  readonly applySnapshot: (
    snapshot: RuntimeEventRecoverySnapshot,
    context: RuntimeEventRecoverySnapshotContext,
  ) => void | Promise<void>;
  readonly onDurableEvent: (
    event: RuntimeDurableEventEnvelope,
    checkpoint: RuntimeEventRecoveryCheckpoint,
  ) => void | Promise<void>;
  readonly onEphemeralEvent?: (event: RuntimeEphemeralEventEnvelope) => void;
  readonly onError?: (error: Error, context: RuntimeEventRecoveryErrorContext) => void;
}

export interface RuntimeEventRecoveryManagerOptions {
  readonly maxBufferedEvents?: number;
  readonly maxBufferedBytes?: number;
}

export type RuntimeEventRecoveryStartResult =
  | {
      readonly mode: "resumed" | "snapshot-resumed";
      readonly protocolVersion: DurableRecoveryProtocolVersion;
      readonly checkpoint: RuntimeEventRecoveryCheckpoint;
    }
  | {
      readonly mode: "snapshot-only";
      readonly protocolVersion: Exclude<RuntimeProtocolVersion, DurableRecoveryProtocolVersion>;
      readonly checkpoint: null;
    };

export type DurableRecoveryProtocolVersion = Extract<RuntimeProtocolVersion, "1.3" | "1.4">;

function supportsDurableRecovery(
  version: RuntimeProtocolVersion,
): version is DurableRecoveryProtocolVersion {
  return version === "1.3" || version === "1.4";
}

/**
 * Internal transport bridge supplied by RollNodeClient.
 *
 * It is exported because RuntimeEventRecoveryManager is public, but applications should normally
 * obtain a manager from RollNodeClient.createEventRecovery().
 */
export interface RuntimeEventRecoveryBridge {
  readonly getInitializationResult: () => InitializeResult;
  readonly requestSnapshot: (threadId: ThreadId) => Promise<RuntimeEventRecoverySnapshot>;
  readonly requestResume: (
    input: RuntimeEventsResumeInput,
    acceptResult: (result: RuntimeEventsResumeResult) => void,
  ) => Promise<RuntimeEventsResumeResult>;
}

interface SeenDurableEvent {
  readonly cursor: RuntimeEventCursor;
  readonly fingerprint: string;
}

interface ThreadRecoveryState {
  readonly options: RuntimeEventRecoveryThreadOptions;
  readonly runtimeInstanceId: RuntimeInstanceId;
  readonly buffer: RuntimeDurableEventEnvelope[];
  readonly bufferedByEventId: Map<RuntimeEventId, SeenDurableEvent>;
  readonly bufferedByCursor: Map<RuntimeEventCursor, RuntimeEventId>;
  readonly seenByEventId: Map<RuntimeEventId, SeenDurableEvent>;
  readonly seenByCursor: Map<RuntimeEventCursor, RuntimeEventId>;
  phase: RuntimeEventRecoveryPhase;
  checkpoint: RuntimeEventRecoveryCheckpoint;
  bufferBytes: number;
  integrityError: RuntimeEventStreamIntegrityError | undefined;
  liveDrain: Promise<void> | undefined;
}

export class RuntimeEventRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeEventRecoveryError";
  }
}

class RuntimeEventStreamIntegrityError extends RuntimeEventRecoveryError {
  readonly reason: RuntimeEventRecoverySnapshotReason;

  constructor(reason: RuntimeEventRecoverySnapshotReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeEventStreamIntegrityError";
    this.reason = reason;
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return normalized;
}

function eventFingerprint(event: RuntimeDurableEventEnvelope): string {
  // Runtime sequence is process-local; durable identity and content live in the remaining fields.
  return eventIdentity(event).fingerprint;
}

function eventIdentity(event: RuntimeDurableEventEnvelope): {
  readonly fingerprint: string;
  readonly bytes: number;
} {
  const serialized = JSON.stringify({ ...event, sequence: undefined });
  return {
    fingerprint: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function rollErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("data" in error) ||
    typeof error.data !== "object" ||
    error.data === null ||
    !("rollCode" in error.data) ||
    typeof error.data.rollCode !== "string"
  ) {
    return undefined;
  }
  return error.data.rollCode;
}

function cursorRpcFallbackReason(error: unknown): RuntimeEventRecoverySnapshotReason | undefined {
  const code = rollErrorCode(error);
  if (code === RUNTIME_ERROR_CODES_V13.eventCursorExpired) {
    return RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorExpired;
  }
  if (code === RUNTIME_ERROR_CODES_V13.eventCursorGap) {
    return RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorGap;
  }
  return undefined;
}

function snapshotEventCursor(snapshot: RuntimeEventRecoverySnapshot): RuntimeEventCursor | null {
  if (!("eventCursor" in snapshot)) {
    throw new RuntimeEventRecoveryError("Runtime Protocol 1.3 snapshot omitted eventCursor");
  }
  return snapshot.eventCursor;
}

function assertRecoveryProjection(snapshot: RuntimeEventRecoverySnapshot): void {
  if (!("recoveryProjection" in snapshot) || snapshot.recoveryProjection !== true) {
    throw new RuntimeEventRecoveryError(
      "Runtime Protocol 1.3 recovery Snapshot omitted the bounded recovery projection marker",
    );
  }
}

function safeCompareCursors(
  left: RuntimeEventCursor | null,
  right: RuntimeEventCursor | null,
): -1 | 0 | 1 {
  try {
    return compareRuntimeEventCursors(left, right);
  } catch (error: unknown) {
    throw new RuntimeEventStreamIntegrityError(
      RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
      "Runtime Event cursors are not comparable",
      { cause: error },
    );
  }
}

function safeCursorDistance(
  from: RuntimeEventCursor | null,
  to: RuntimeEventCursor | null,
): bigint {
  try {
    return runtimeEventCursorDistance(from, to);
  } catch (error: unknown) {
    throw new RuntimeEventStreamIntegrityError(
      RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
      "Runtime Event cursor distance is not comparable",
      { cause: error },
    );
  }
}

function isRecoverableDurableEvent(
  event: RuntimeEventEnvelope,
): event is RuntimeDurableEventEnvelope {
  return (
    (event.protocolVersion === "1.3" || event.protocolVersion === "1.4") &&
    event.durability === "durable"
  );
}

function isRecoverableEphemeralEvent(
  event: RuntimeEventEnvelope,
): event is RuntimeEphemeralEventEnvelope {
  return (
    (event.protocolVersion === "1.3" || event.protocolVersion === "1.4") &&
    event.durability === "ephemeral"
  );
}

/**
 * Reconciles persisted Runtime events with concurrent live notifications on one Client connection.
 * A claimed Thread never falls through to RollNodeClient.onEvent() before ordering and de-duplication.
 */
export class RuntimeEventRecoveryManager {
  private readonly bridge: RuntimeEventRecoveryBridge;
  private readonly maxBufferedEvents: number;
  private readonly maxBufferedBytes: number;
  private readonly states = new Map<ThreadId, ThreadRecoveryState>();
  private readonly checkpoints = new Map<ThreadId, RuntimeEventRecoveryCheckpoint>();
  private closed = false;

  constructor(
    bridge: RuntimeEventRecoveryBridge,
    options: RuntimeEventRecoveryManagerOptions = {},
  ) {
    this.bridge = bridge;
    this.maxBufferedEvents = positiveInteger(
      options.maxBufferedEvents,
      DEFAULT_RUNTIME_EVENT_RECOVERY_MAX_BUFFERED_EVENTS,
      "maxBufferedEvents",
    );
    this.maxBufferedBytes = positiveInteger(
      options.maxBufferedBytes,
      DEFAULT_RUNTIME_EVENT_RECOVERY_MAX_BUFFERED_BYTES,
      "maxBufferedBytes",
    );
  }

  isClosed(): boolean {
    return this.closed;
  }

  getCheckpoint(threadId: ThreadId): RuntimeEventRecoveryCheckpoint | undefined {
    return this.checkpoints.get(threadId);
  }

  async resumeThread(
    options: RuntimeEventRecoveryThreadOptions,
  ): Promise<RuntimeEventRecoveryStartResult> {
    if (this.closed) {
      throw new RuntimeEventRecoveryError("Runtime Event recovery manager is closed");
    }
    if (this.states.has(options.threadId)) {
      throw new RuntimeEventRecoveryError(
        `Runtime Event recovery already owns Thread ${JSON.stringify(options.threadId)}`,
      );
    }
    if (options.checkpoint !== undefined && options.checkpoint.threadId !== options.threadId) {
      throw new RuntimeEventRecoveryError("Runtime Event checkpoint belongs to another Thread");
    }

    const initialization = this.bridge.getInitializationResult();
    if (!supportsDurableRecovery(initialization.protocolVersion)) {
      const snapshot = await this.bridge.requestSnapshot(options.threadId);
      await options.applySnapshot(snapshot, {
        reason: RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.protocolUnsupported,
        protocolVersion: initialization.protocolVersion,
        recoveryProjection:
          "recoveryProjection" in snapshot && snapshot.recoveryProjection === true,
      });
      return {
        mode: RECOVERY_MODES.snapshotOnly,
        protocolVersion: initialization.protocolVersion,
        checkpoint: null,
      };
    }

    const initialCheckpoint: RuntimeEventRecoveryCheckpoint = {
      threadId: options.threadId,
      runtimeInstanceId: initialization.runtimeInstanceId,
      cursor:
        options.checkpoint?.runtimeInstanceId === initialization.runtimeInstanceId
          ? options.checkpoint.cursor
          : null,
    };
    const state: ThreadRecoveryState = {
      options,
      runtimeInstanceId: initialization.runtimeInstanceId,
      buffer: [],
      bufferedByEventId: new Map(),
      bufferedByCursor: new Map(),
      seenByEventId: new Map(),
      seenByCursor: new Map(),
      phase: RECOVERY_PHASES.buffering,
      checkpoint: initialCheckpoint,
      bufferBytes: 0,
      integrityError: undefined,
      liveDrain: undefined,
    };
    this.states.set(options.threadId, state);
    this.checkpoints.set(options.threadId, initialCheckpoint);

    try {
      let mode: "resumed" | "snapshot-resumed";
      if (options.checkpoint === undefined) {
        await this.snapshotAndResume(state, RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.initial);
        mode = RECOVERY_MODES.snapshotResumed;
      } else if (options.checkpoint.runtimeInstanceId !== initialization.runtimeInstanceId) {
        await this.snapshotAndResume(
          state,
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.runtimeRestarted,
        );
        mode = RECOVERY_MODES.snapshotResumed;
      } else {
        try {
          await this.resumeFrom(state, options.checkpoint.cursor);
          mode = RECOVERY_MODES.resumed;
        } catch (error: unknown) {
          const fallbackReason =
            cursorRpcFallbackReason(error) ??
            (error instanceof RuntimeEventStreamIntegrityError ? error.reason : undefined);
          if (fallbackReason === undefined) {
            throw error;
          }
          await this.snapshotAndResume(state, fallbackReason);
          mode = RECOVERY_MODES.snapshotResumed;
        }
      }
      this.assertActive(state);
      state.phase = RECOVERY_PHASES.live;
      this.scheduleLiveDrain(state);
      return {
        mode,
        protocolVersion: initialization.protocolVersion,
        checkpoint: state.checkpoint,
      };
    } catch (error: unknown) {
      this.failState(state, asError(error));
      this.states.delete(options.threadId);
      throw error;
    }
  }

  stopThread(threadId: ThreadId): boolean {
    const state = this.states.get(threadId);
    if (state === undefined) {
      return false;
    }
    state.phase = RECOVERY_PHASES.stopped;
    this.states.delete(threadId);
    this.clearBuffer(state);
    return true;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const state of this.states.values()) {
      state.phase = RECOVERY_PHASES.stopped;
      this.clearBuffer(state);
    }
    this.states.clear();
  }

  /** @internal Called synchronously by RollNodeClient before raw onEvent() fanout. */
  acceptEvent(event: RuntimeEventEnvelope): boolean {
    const state = this.states.get(event.threadId);
    if (state === undefined) {
      return false;
    }
    if (state.phase === RECOVERY_PHASES.stopped || state.phase === RECOVERY_PHASES.failed) {
      return true;
    }
    if (event.runtimeInstanceId !== state.runtimeInstanceId) {
      this.markIntegrityFailure(
        state,
        new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
          "Runtime Event belongs to another Runtime instance",
        ),
      );
      return true;
    }
    if (isRecoverableEphemeralEvent(event)) {
      if (state.phase === RECOVERY_PHASES.live) {
        try {
          state.options.onEphemeralEvent?.(event);
        } catch {
          // Ephemeral observers cannot interrupt durable recovery or release a claimed Thread.
        }
      }
      return true;
    }
    if (!isRecoverableDurableEvent(event)) {
      this.markIntegrityFailure(
        state,
        new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
          "Claimed Thread received an event outside Runtime Protocol 1.3",
        ),
      );
      return true;
    }
    this.bufferDurableEvent(state, event);
    if (state.phase === RECOVERY_PHASES.live) {
      this.scheduleLiveDrain(state);
    }
    return true;
  }

  /** @internal Called when the owning RollNodeClient transport exits. */
  acceptClientExit(error: Error): void {
    for (const state of this.states.values()) {
      this.failState(state, error);
    }
  }

  private async snapshotAndResume(
    state: ThreadRecoveryState,
    initialReason: RuntimeEventRecoverySnapshotReason,
  ): Promise<void> {
    let reason = initialReason;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.assertActive(state);
      state.phase = RECOVERY_PHASES.buffering;
      const snapshot = await this.bridge.requestSnapshot(state.options.threadId);
      this.assertActive(state);
      assertRecoveryProjection(snapshot);
      await state.options.applySnapshot(snapshot, {
        reason,
        protocolVersion: this.bridge.getInitializationResult().protocolVersion,
        recoveryProjection: true,
      });
      this.assertActive(state);
      const cursor = snapshotEventCursor(snapshot);
      this.clearBuffer(state);
      state.seenByEventId.clear();
      state.seenByCursor.clear();
      state.checkpoint = {
        threadId: state.options.threadId,
        runtimeInstanceId: state.runtimeInstanceId,
        cursor,
      };
      this.checkpoints.set(state.options.threadId, state.checkpoint);
      try {
        await this.resumeFrom(state, cursor);
        return;
      } catch (error: unknown) {
        const nextReason =
          cursorRpcFallbackReason(error) ??
          (error instanceof RuntimeEventStreamIntegrityError ? error.reason : undefined);
        if (nextReason === undefined || attempt === 1) {
          throw error;
        }
        reason = nextReason;
      }
    }
    throw new RuntimeEventRecoveryError("Runtime Event recovery could not converge on a Snapshot");
  }

  private async resumeFrom(
    state: ThreadRecoveryState,
    afterCursor: RuntimeEventCursor | null,
  ): Promise<void> {
    this.assertActive(state);
    state.phase = RECOVERY_PHASES.buffering;
    state.integrityError = undefined;
    let acceptedBarrier: RuntimeEventsResumeResult | undefined;
    const result = await this.bridge.requestResume(
      { threadId: state.options.threadId, afterCursor },
      (accepted) => {
        acceptedBarrier = accepted;
      },
    );
    this.assertActive(state);
    const barrier = acceptedBarrier ?? result;
    state.phase = RECOVERY_PHASES.draining;
    this.throwIntegrityError(state);
    const firstBatch = this.takeBuffer(state);
    const deliverable = this.validateBarrier(firstBatch, afterCursor, barrier);
    await this.deliverBatch(state, deliverable, afterCursor);
    while (state.buffer.length > 0) {
      this.throwIntegrityError(state);
      const nextBatch = this.prepareBatch(state, this.takeBuffer(state));
      await this.deliverBatch(state, nextBatch, state.checkpoint.cursor);
    }
    this.throwIntegrityError(state);
  }

  private validateBarrier(
    batch: RuntimeDurableEventEnvelope[],
    afterCursor: RuntimeEventCursor | null,
    barrier: RuntimeEventsResumeResult,
  ): RuntimeDurableEventEnvelope[] {
    const prepared = this.prepareBatch(undefined, batch);
    const after = prepared.filter(
      (event) => afterCursor === null || safeCompareCursors(event.cursor, afterCursor) > 0,
    );
    const replayed =
      barrier.throughCursor === null
        ? []
        : after.filter((event) => safeCompareCursors(event.cursor, barrier.throughCursor!) <= 0);

    if (replayed.length !== barrier.replayedCount) {
      throw new RuntimeEventStreamIntegrityError(
        RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.streamGap,
        `Runtime Event replay announced ${String(barrier.replayedCount)} events but delivered ${String(
          replayed.length,
        )}`,
      );
    }
    if (barrier.replayedCount === 0) {
      if (safeCompareCursors(afterCursor, barrier.throughCursor) !== 0) {
        throw new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.streamGap,
          "Runtime Event replay returned an invalid empty barrier",
        );
      }
    } else {
      const lastReplay = replayed.at(-1);
      if (
        lastReplay === undefined ||
        barrier.throughCursor === null ||
        safeCompareCursors(lastReplay.cursor, barrier.throughCursor) !== 0
      ) {
        throw new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.streamGap,
          "Runtime Event replay did not reach its throughCursor barrier",
        );
      }
      if (
        safeCursorDistance(afterCursor, barrier.throughCursor) !== BigInt(barrier.replayedCount)
      ) {
        throw new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.streamGap,
          "Runtime Event replay barrier contains a cursor gap",
        );
      }
    }
    return after;
  }

  private prepareBatch(
    state: ThreadRecoveryState | undefined,
    batch: RuntimeDurableEventEnvelope[],
  ): RuntimeDurableEventEnvelope[] {
    batch.sort((left, right) => safeCompareCursors(left.cursor, right.cursor));
    if (state === undefined) {
      return batch;
    }
    return batch.filter((event) => {
      const seen = state.seenByEventId.get(event.eventId);
      if (seen !== undefined) {
        if (seen.cursor !== event.cursor || seen.fingerprint !== eventFingerprint(event)) {
          throw new RuntimeEventStreamIntegrityError(
            RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
            "Runtime Event reused an eventId with conflicting content",
          );
        }
        return false;
      }
      const seenAtCursor = state.seenByCursor.get(event.cursor);
      if (seenAtCursor !== undefined && seenAtCursor !== event.eventId) {
        throw new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
          "Runtime Event cursor was reused by another eventId",
        );
      }
      return true;
    });
  }

  private async deliverBatch(
    state: ThreadRecoveryState,
    batch: RuntimeDurableEventEnvelope[],
    startingCursor: RuntimeEventCursor | null,
  ): Promise<void> {
    let previousCursor = startingCursor;
    for (const event of batch) {
      this.assertActive(state);
      const distance = safeCursorDistance(previousCursor, event.cursor);
      if (distance <= 0n) {
        continue;
      }
      if (distance !== 1n) {
        throw new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.streamGap,
          "Runtime Event stream contains a cursor gap",
        );
      }
      const checkpoint: RuntimeEventRecoveryCheckpoint = {
        threadId: state.options.threadId,
        runtimeInstanceId: state.runtimeInstanceId,
        cursor: event.cursor,
      };
      await state.options.onDurableEvent(event, checkpoint);
      this.assertActive(state);
      state.checkpoint = checkpoint;
      this.checkpoints.set(state.options.threadId, checkpoint);
      this.rememberDelivered(state, event);
      previousCursor = event.cursor;
    }
  }

  private bufferDurableEvent(state: ThreadRecoveryState, event: RuntimeDurableEventEnvelope): void {
    const { fingerprint, bytes } = eventIdentity(event);
    const seen = state.seenByEventId.get(event.eventId);
    if (seen !== undefined) {
      if (seen.cursor !== event.cursor || seen.fingerprint !== fingerprint) {
        this.markIntegrityFailure(
          state,
          new RuntimeEventStreamIntegrityError(
            RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
            "Runtime Event reused a delivered eventId with conflicting content",
          ),
        );
      }
      return;
    }
    const buffered = state.bufferedByEventId.get(event.eventId);
    if (buffered !== undefined) {
      if (buffered.cursor !== event.cursor || buffered.fingerprint !== fingerprint) {
        this.markIntegrityFailure(
          state,
          new RuntimeEventStreamIntegrityError(
            RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
            "Runtime Event reused a buffered eventId with conflicting content",
          ),
        );
      }
      return;
    }
    const eventAtCursor =
      state.bufferedByCursor.get(event.cursor) ?? state.seenByCursor.get(event.cursor);
    if (eventAtCursor !== undefined && eventAtCursor !== event.eventId) {
      this.markIntegrityFailure(
        state,
        new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.cursorConflict,
          "Runtime Event cursor was reused by another eventId",
        ),
      );
      return;
    }
    if (
      state.buffer.length + 1 > this.maxBufferedEvents ||
      state.bufferBytes + bytes > this.maxBufferedBytes
    ) {
      this.clearBuffer(state);
      this.markIntegrityFailure(
        state,
        new RuntimeEventStreamIntegrityError(
          RUNTIME_EVENT_RECOVERY_SNAPSHOT_REASONS.bufferOverflow,
          "Runtime Event recovery buffer exceeded its bounded capacity",
        ),
      );
      return;
    }
    state.buffer.push(event);
    state.bufferBytes += bytes;
    state.bufferedByEventId.set(event.eventId, { cursor: event.cursor, fingerprint });
    state.bufferedByCursor.set(event.cursor, event.eventId);
  }

  private takeBuffer(state: ThreadRecoveryState): RuntimeDurableEventEnvelope[] {
    const batch = state.buffer.splice(0);
    state.bufferBytes = 0;
    state.bufferedByEventId.clear();
    state.bufferedByCursor.clear();
    return batch;
  }

  private clearBuffer(state: ThreadRecoveryState): void {
    state.buffer.splice(0);
    state.bufferBytes = 0;
    state.bufferedByEventId.clear();
    state.bufferedByCursor.clear();
    state.integrityError = undefined;
  }

  private rememberDelivered(state: ThreadRecoveryState, event: RuntimeDurableEventEnvelope): void {
    state.seenByEventId.set(event.eventId, {
      cursor: event.cursor,
      fingerprint: eventFingerprint(event),
    });
    state.seenByCursor.set(event.cursor, event.eventId);
    while (state.seenByEventId.size > this.maxBufferedEvents) {
      const oldestEventId = state.seenByEventId.keys().next().value;
      if (oldestEventId === undefined) {
        break;
      }
      const oldest = state.seenByEventId.get(oldestEventId);
      state.seenByEventId.delete(oldestEventId);
      if (oldest !== undefined) {
        state.seenByCursor.delete(oldest.cursor);
      }
    }
  }

  private markIntegrityFailure(
    state: ThreadRecoveryState,
    error: RuntimeEventStreamIntegrityError,
  ): void {
    state.integrityError ??= error;
    if (state.phase === RECOVERY_PHASES.live) {
      this.scheduleLiveDrain(state);
    }
  }

  private throwIntegrityError(state: ThreadRecoveryState): void {
    if (state.integrityError !== undefined) {
      throw state.integrityError;
    }
  }

  private scheduleLiveDrain(state: ThreadRecoveryState): void {
    if (
      state.liveDrain !== undefined ||
      state.phase !== RECOVERY_PHASES.live ||
      (state.buffer.length === 0 && state.integrityError === undefined)
    ) {
      return;
    }
    state.liveDrain = this.drainLive(state).finally(() => {
      state.liveDrain = undefined;
      if (state.phase === RECOVERY_PHASES.live) {
        this.scheduleLiveDrain(state);
      }
    });
  }

  private async drainLive(state: ThreadRecoveryState): Promise<void> {
    try {
      this.throwIntegrityError(state);
      while (state.buffer.length > 0) {
        const batch = this.prepareBatch(state, this.takeBuffer(state));
        await this.deliverBatch(state, batch, state.checkpoint.cursor);
        this.throwIntegrityError(state);
      }
    } catch (error: unknown) {
      if (error instanceof RuntimeEventStreamIntegrityError) {
        try {
          await this.snapshotAndResume(state, error.reason);
          this.assertActive(state);
          state.phase = RECOVERY_PHASES.live;
          return;
        } catch (recoveryError: unknown) {
          this.failState(state, asError(recoveryError));
          return;
        }
      }
      this.failState(state, asError(error));
    }
  }

  private assertActive(state: ThreadRecoveryState): void {
    if (
      this.closed ||
      this.states.get(state.options.threadId) !== state ||
      state.phase === RECOVERY_PHASES.stopped ||
      state.phase === RECOVERY_PHASES.failed
    ) {
      throw new RuntimeEventRecoveryError("Runtime Event recovery was stopped");
    }
  }

  private failState(state: ThreadRecoveryState, error: Error): void {
    if (state.phase === RECOVERY_PHASES.failed || state.phase === RECOVERY_PHASES.stopped) {
      return;
    }
    state.phase = RECOVERY_PHASES.failed;
    this.clearBuffer(state);
    try {
      state.options.onError?.(error, {
        threadId: state.options.threadId,
        phase: RECOVERY_PHASES.failed,
      });
    } catch {
      // Recovery error observers cannot release a failed claim or interrupt other Threads.
    }
  }
}
