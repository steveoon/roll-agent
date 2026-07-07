const NEWLINE_BYTE = 0x0a;

export interface CapturedStream {
  readonly text: string;
  readonly totalBytes: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export class OutputSink {
  private readonly maxBytes: number;
  private readonly chunks: Buffer[] = [];
  private storedBytes = 0;
  private totalBytes = 0;
  private newlineCount = 0;
  private lastByte: number | undefined;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.totalBytes += chunk.length;
    for (const byte of chunk) {
      if (byte === NEWLINE_BYTE) {
        this.newlineCount += 1;
      }
    }
    this.lastByte = chunk[chunk.length - 1];

    const remaining = this.maxBytes - this.storedBytes;
    if (remaining <= 0) {
      return;
    }
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.storedBytes += chunk.length;
    } else {
      this.chunks.push(chunk.subarray(0, remaining));
      this.storedBytes += remaining;
    }
  }

  collect(): CapturedStream {
    const text = Buffer.concat(this.chunks, this.storedBytes).toString("utf8");
    return {
      text,
      totalBytes: this.totalBytes,
      totalLines: this.countLines(),
      truncated: this.storedBytes < this.totalBytes,
    };
  }

  private countLines(): number {
    if (this.totalBytes === 0) {
      return 0;
    }
    const trailingLine = this.lastByte === NEWLINE_BYTE ? 0 : 1;
    return this.newlineCount + trailingLine;
  }
}

export interface StreamBudget {
  readonly stdout: number;
  readonly stderr: number;
}

export function partitionModelBudget(total: number, stderrChars: number): StreamBudget {
  const stderrShare = Math.floor((total * 2) / 3);
  const stderr = Math.min(stderrChars, stderrShare);
  return { stdout: total - stderr, stderr };
}
