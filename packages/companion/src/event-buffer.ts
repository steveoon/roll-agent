import type { RuntimeEventEnvelope } from "@roll-agent/protocol";

export const DEFAULT_COMPANION_MAX_EVENTS = 10_000;
export const DEFAULT_COMPANION_MAX_BYTES = 16 * 1_024 * 1_024;

export interface BufferedRuntimeEvent {
  readonly relaySequence: number;
  readonly event: RuntimeEventEnvelope;
}

export interface EventBufferGap {
  readonly fromRelaySequence: number;
  readonly throughRelaySequence: number;
}

export interface EventBufferReplay {
  readonly events: readonly BufferedRuntimeEvent[];
  readonly gap: EventBufferGap | undefined;
}

export interface CompanionEventBufferOptions {
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

interface StoredEvent extends BufferedRuntimeEvent {
  readonly bytes: number;
}

export class CompanionEventBuffer {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly entries: StoredEvent[] = [];
  private nextSequence = 0;
  private retainedBytes = 0;
  private droppedThroughSequence = -1;

  constructor(options: CompanionEventBufferOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_COMPANION_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_COMPANION_MAX_BYTES;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new Error("maxEvents must be a positive integer");
    }
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error("maxBytes must be a positive integer");
    }
  }

  append(event: RuntimeEventEnvelope): BufferedRuntimeEvent {
    const stored: StoredEvent = {
      relaySequence: this.nextSequence,
      event,
      bytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
    };
    this.nextSequence += 1;
    this.entries.push(stored);
    this.retainedBytes += stored.bytes;
    this.enforceLimits();
    return { relaySequence: stored.relaySequence, event };
  }

  replay(afterRelaySequence = -1): EventBufferReplay {
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
      events: this.entries
        .filter((entry) => entry.relaySequence > afterRelaySequence)
        .map(({ relaySequence, event }) => ({ relaySequence, event })),
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
    while (this.entries[0] !== undefined && this.entries[0].relaySequence <= throughRelaySequence) {
      const removed = this.entries.shift();
      if (removed !== undefined) {
        this.retainedBytes -= removed.bytes;
        this.droppedThroughSequence = Math.max(this.droppedThroughSequence, removed.relaySequence);
      }
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

  private enforceLimits(): void {
    while (
      this.entries.length > this.maxEvents ||
      (this.retainedBytes > this.maxBytes && this.entries.length > 0)
    ) {
      const removed = this.entries.shift();
      if (removed !== undefined) {
        this.retainedBytes -= removed.bytes;
        this.droppedThroughSequence = removed.relaySequence;
      }
    }
  }
}
