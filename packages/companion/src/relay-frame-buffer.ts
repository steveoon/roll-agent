import {
  RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES,
  type RuntimeEventEnvelope,
} from "@roll-agent/protocol";
import {
  projectRuntimeEventEnvelopeForRelayV11,
  relayInteractionCancelledSchemaV11,
  relayInteractionRequestSchemaV11,
  relayInteractionResolvedSchemaV11,
  relayRuntimeEventSchemaV11,
  type RelayMessageV11,
  type RelayRuntimeEventEnvelopeV11,
  type WorkspaceId,
  workspaceIdSchema,
} from "@roll-agent/relay-protocol";
import type { CompanionInteractionFrameDraftV11 } from "./interaction-broker.ts";

export const DEFAULT_COMPANION_RELAY_FRAME_MAX_EVENTS = 10_000;
export const DEFAULT_COMPANION_RELAY_FRAME_MAX_BYTES = RUNTIME_V13_DEFAULT_REPLAY_BUFFER_BYTES;

const DRAFT_VALIDATION_WORKSPACE_ID = workspaceIdSchema.parse(
  "00000000-0000-4000-8000-000000000000",
);

export interface BufferedRelayRuntimeEventV11 {
  readonly type: "runtime.event";
  readonly relaySequence: number;
  readonly event: RelayRuntimeEventEnvelopeV11;
}

export type BufferedRelayInteractionFrameV11 = CompanionInteractionFrameDraftV11 & {
  readonly relaySequence: number;
};

/**
 * A replayable Wire 1.1 frame with workspace routing deliberately omitted.
 * The owning bridge supplies the workspace only when materializing the frame.
 */
export type CompanionRelayFrameEntryV11 =
  | BufferedRelayRuntimeEventV11
  | BufferedRelayInteractionFrameV11;

export interface RelayFrameBufferGapV11 {
  readonly fromRelaySequence: number;
  readonly throughRelaySequence: number;
}

export interface CompanionRelayFrameReplayV11 {
  readonly frames: readonly CompanionRelayFrameEntryV11[];
  readonly gap: RelayFrameBufferGapV11 | undefined;
}

export interface CompanionRelayFrameBufferOptions {
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

interface StoredRelayFrameV11 {
  readonly frame: CompanionRelayFrameEntryV11;
  readonly bytes: number;
}

function parseInteractionFrameDraftV11(
  value: CompanionInteractionFrameDraftV11,
): CompanionInteractionFrameDraftV11 {
  if ("workspaceId" in value || "relaySequence" in value) {
    throw new Error("Buffered interaction drafts must not contain workspace routing fields");
  }
  const materialized = {
    ...value,
    workspaceId: DRAFT_VALIDATION_WORKSPACE_ID,
    relaySequence: 0,
  };
  if (value.type === "interaction.request") {
    const {
      workspaceId: _workspaceId,
      relaySequence: _relaySequence,
      ...draft
    } = relayInteractionRequestSchemaV11.parse(materialized);
    return draft;
  }
  if (value.type === "interaction.resolved") {
    const {
      workspaceId: _workspaceId,
      relaySequence: _relaySequence,
      ...draft
    } = relayInteractionResolvedSchemaV11.parse(materialized);
    return draft;
  }
  const {
    workspaceId: _workspaceId,
    relaySequence: _relaySequence,
    ...draft
  } = relayInteractionCancelledSchemaV11.parse(materialized);
  return draft;
}

/** Materializes and strictly validates an outbound replayable Wire 1.1 frame. */
export function materializeRelayFrameV11(
  workspaceId: WorkspaceId,
  entry: CompanionRelayFrameEntryV11,
): RelayMessageV11 {
  if (entry.type === "runtime.event") {
    return relayRuntimeEventSchemaV11.parse({ ...entry, workspaceId });
  }
  if (entry.type === "interaction.request") {
    return relayInteractionRequestSchemaV11.parse({ ...entry, workspaceId });
  }
  if (entry.type === "interaction.resolved") {
    return relayInteractionResolvedSchemaV11.parse({ ...entry, workspaceId });
  }
  return relayInteractionCancelledSchemaV11.parse({ ...entry, workspaceId });
}

/**
 * Per-workspace in-memory replay buffer for Wire 1.1 runtime and interaction frames.
 * It is intentionally independent from the frozen Wire 1.0 `CompanionEventBuffer`.
 */
export class CompanionRelayFrameBuffer {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly entries: StoredRelayFrameV11[] = [];
  private nextSequence = 0;
  private retainedBytes = 0;
  private droppedThroughSequence = -1;

  constructor(options: CompanionRelayFrameBufferOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_COMPANION_RELAY_FRAME_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_COMPANION_RELAY_FRAME_MAX_BYTES;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new Error("maxEvents must be a positive integer");
    }
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error("maxBytes must be a positive integer");
    }
  }

  appendRuntimeEvent(event: RuntimeEventEnvelope): CompanionRelayFrameEntryV11 | undefined {
    const projected = projectRuntimeEventEnvelopeForRelayV11(event);
    if (projected === undefined) {
      return undefined;
    }
    return this.append({
      type: "runtime.event",
      relaySequence: this.nextSequence,
      event: projected,
    });
  }

  appendInteraction(frame: CompanionInteractionFrameDraftV11): CompanionRelayFrameEntryV11 {
    const parsed = parseInteractionFrameDraftV11(frame);
    return this.append({ ...parsed, relaySequence: this.nextSequence });
  }

  replay(afterRelaySequence = -1): CompanionRelayFrameReplayV11 {
    if (!Number.isInteger(afterRelaySequence) || afterRelaySequence < -1) {
      throw new Error("afterRelaySequence must be an integer greater than or equal to -1");
    }
    const gap =
      afterRelaySequence < this.droppedThroughSequence
        ? {
            fromRelaySequence: afterRelaySequence + 1,
            throughRelaySequence: this.droppedThroughSequence,
          }
        : undefined;
    return {
      frames: this.entries
        .filter((entry) => entry.frame.relaySequence > afterRelaySequence)
        .map((entry) => entry.frame),
      gap,
    };
  }

  acknowledge(throughRelaySequence: number): void {
    if (!Number.isInteger(throughRelaySequence) || throughRelaySequence < -1) {
      throw new Error("throughRelaySequence must be an integer greater than or equal to -1");
    }
    if (throughRelaySequence > this.highestRelaySequence) {
      return;
    }
    while (
      this.entries[0] !== undefined &&
      this.entries[0].frame.relaySequence <= throughRelaySequence
    ) {
      this.dropOldest();
    }
  }

  get size(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  get highestRelaySequence(): number {
    return this.nextSequence - 1;
  }

  private append(frame: CompanionRelayFrameEntryV11): CompanionRelayFrameEntryV11 {
    const stored: StoredRelayFrameV11 = {
      frame,
      bytes: Buffer.byteLength(JSON.stringify(frame), "utf8"),
    };
    this.nextSequence += 1;
    this.entries.push(stored);
    this.retainedBytes += stored.bytes;
    this.enforceLimits();
    return frame;
  }

  private enforceLimits(): void {
    while (
      this.entries.length > this.maxEvents ||
      (this.retainedBytes > this.maxBytes && this.entries.length > 0)
    ) {
      this.dropOldest();
    }
  }

  private dropOldest(): void {
    const removed = this.entries.shift();
    if (removed === undefined) {
      return;
    }
    this.retainedBytes -= removed.bytes;
    this.droppedThroughSequence = Math.max(
      this.droppedThroughSequence,
      removed.frame.relaySequence,
    );
  }
}
