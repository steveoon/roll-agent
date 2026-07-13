import { truncateMiddle } from "../truncate.ts";

export interface DrainResult {
  readonly text: string;
  readonly omitted: number;
}

export class HeadTailBuffer {
  private head = "";
  private tailChunks: string[] = [];
  private tailLength = 0;
  private omittedMiddle = 0;
  private readonly headCapacity: number;
  private readonly tailCapacity: number;

  constructor(capacity: number) {
    this.headCapacity = Math.ceil(capacity / 2);
    this.tailCapacity = Math.max(capacity - this.headCapacity, 1);
  }

  append(text: string): void {
    if (text.length === 0) {
      return;
    }
    let rest = text;
    if (this.tailLength === 0 && this.head.length < this.headCapacity) {
      const take = this.headCapacity - this.head.length;
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest.length === 0) {
      return;
    }
    this.tailChunks.push(rest);
    this.tailLength += rest.length;
    this.trimTail();
  }

  private trimTail(): void {
    while (this.tailLength > this.tailCapacity && this.tailChunks.length > 1) {
      const oldest = this.tailChunks.shift() ?? "";
      this.tailLength -= oldest.length;
      this.omittedMiddle += oldest.length;
    }
    if (this.tailLength > this.tailCapacity && this.tailChunks.length === 1) {
      const only = this.tailChunks[0] ?? "";
      const kept = only.slice(only.length - this.tailCapacity);
      this.omittedMiddle += only.length - kept.length;
      this.tailChunks = [kept];
      this.tailLength = kept.length;
    }
  }

  hasPending(): boolean {
    return this.head.length > 0 || this.tailChunks.length > 0;
  }

  snapshot(maxChars: number): DrainResult {
    const tail = this.tailChunks.join("");
    const carriedOmitted = this.omittedMiddle;
    const raw =
      carriedOmitted > 0
        ? `${this.head}\n…${String(carriedOmitted)} chars truncated…\n${tail}`
        : this.head + tail;

    const cut = truncateMiddle(raw, maxChars);
    return { text: cut.text, omitted: carriedOmitted + cut.removed };
  }

  drain(maxChars: number): DrainResult {
    const result = this.snapshot(maxChars);
    this.head = "";
    this.tailChunks = [];
    this.tailLength = 0;
    this.omittedMiddle = 0;
    return result;
  }
}
