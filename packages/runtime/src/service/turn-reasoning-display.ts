import type { SessionEvent } from "../types/events.ts";
import { ReasoningDisplayBuffer } from "./reasoning-display-buffer.ts";

type Delta = Extract<SessionEvent, { type: "reasoning-delta" }>;
const MAX_OPEN_BLOCKS = 16;

/** Per-turn display state. Native block IDs can repeat between SDK steps or retries. */
export class TurnReasoningDisplay {
  private readonly blocks = new Map<string, { id: string; buffer: ReasoningDisplayBuffer }>();
  private overflowed = false;
  private nextId = 0;
  private readonly readDelta: (event: Delta) => string | undefined;
  private readonly publish: (id: string, delta: string) => void;
  private readonly preserveNativeId: boolean;

  constructor(
    readDelta: (event: Delta) => string | undefined,
    publish: (id: string, delta: string) => void,
    preserveNativeId = false,
  ) {
    this.readDelta = readDelta;
    this.publish = publish;
    this.preserveNativeId = preserveNativeId;
  }

  start(nativeId: string): void {
    this.blocks.delete(nativeId); // Discard an interrupted block that never received an end.
  }

  append(event: Delta): void {
    if (this.overflowed) return;
    const text = this.readDelta(event);
    if (!text) return;
    let block = this.blocks.get(event.reasoningId);
    if (!block) {
      if (this.blocks.size >= MAX_OPEN_BLOCKS) {
        this.blocks.clear();
        this.overflowed = true;
        return;
      }
      block = {
        id: this.preserveNativeId && event.reasoningId ? event.reasoningId : String(++this.nextId),
        buffer: new ReasoningDisplayBuffer(),
      };
      this.blocks.set(event.reasoningId, block);
    }
    const delta = block.buffer.append(text);
    if (delta) this.publish(block.id, delta);
  }

  end(nativeId: string): void {
    const block = this.blocks.get(nativeId);
    this.blocks.delete(nativeId);
    const delta = block?.buffer.finish();
    if (block && delta) this.publish(block.id, delta);
  }

  finish(): void {
    for (const id of this.blocks.keys()) this.end(id);
    this.reset();
  }

  reset(): void {
    this.blocks.clear();
    this.overflowed = false;
  }
}
