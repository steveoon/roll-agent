import { redactSecretText } from "../tool-bridge/tool-execution-record.ts";

const DISPLAY_LIMIT = 16_384;
const BATCH_CHARS = 128;
const BATCH_MS = 32;
const OMISSION_MARKER = "\n…（后续内容已省略）";

/** Keep the context of earlier chunks so a credential split across deltas is redacted as one value. */
export class ReasoningDisplayBuffer {
  private raw = "";
  private sent = "";
  private stopped = false;
  private lastScanLength = 0;
  private lastScanAt = 0;

  append(delta: string): string {
    if (this.stopped) return "";
    const available = DISPLAY_LIMIT - this.raw.length;
    this.raw += delta.slice(0, available);
    const truncated = delta.length > available;
    // The unfinished word could still become a token, a JWT or a secret assignment.
    if (!truncated && !/[\s。！？]/u.test(delta)) return "";
    const now = performance.now();
    // Pace full-prefix redaction for long, fast streams; the first words and
    // slow arrivals still display promptly. finish() flushes the final batch.
    if (
      !truncated &&
      this.raw.length > BATCH_CHARS &&
      this.raw.length - this.lastScanLength < BATCH_CHARS &&
      now - this.lastScanAt < BATCH_MS
    ) {
      return "";
    }
    this.lastScanLength = this.raw.length;
    this.lastScanAt = now;
    const safe = redactSecretText(this.raw);
    // A later delta can complete a PEM header or canonicalize the casing/spacing
    // of a Bearer prefix. Neither prefix is stable enough to send yet.
    const unstable = /(?:-----BEGIN[ A-Z0-9-]*|\bbearer\s+)$/iu.exec(safe);
    let boundary = unstable?.index ?? safe.length;
    while (boundary > this.sent.length && !/[\s。！？]/u.test(safe.charAt(boundary - 1))) {
      boundary--;
    }
    return this.advance(safe.slice(0, boundary), truncated);
  }

  finish(): string {
    return this.stopped ? "" : this.advance(redactSecretText(this.raw));
  }

  private advance(safe: string, truncated = false): string {
    const matches = safe.startsWith(this.sent);
    const delta = matches ? safe.slice(this.sent.length) : "";
    if (truncated || !matches) {
      this.stopped = true;
      return delta + OMISSION_MARKER;
    }
    this.sent = safe;
    return delta;
  }
}
