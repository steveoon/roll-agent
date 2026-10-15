import type { SessionEvent } from "../types/events.ts";

type ActivityEvent = Extract<SessionEvent, { type: "tool-input-activity" }>;
type ActiveCall = ActivityEvent["calls"][number];
const SAFE_DISPLAY_NAME = /^[a-zA-Z0-9_.-]{1,160}$/;
const MAX_ACTIVE_CALLS = 128;

/** Ephemeral observation only: never collects JSON, parses arguments or grants execution. */
export class ToolInputActivityTracker {
  private readonly calls = new Map<string, ActiveCall>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    privateResolveName: (modelToolName: string) => string | undefined,
    privateEmit: (event: ActivityEvent) => void,
    intervalMs = 100,
  ) {
    this.resolveName = privateResolveName;
    this.emit = privateEmit;
    this.intervalMs = intervalMs;
  }
  private readonly resolveName: (modelToolName: string) => string | undefined;
  private readonly emit: (event: ActivityEvent) => void;
  private readonly intervalMs: number;

  start(id: string, modelToolName: string): void {
    if (this.disposed || this.calls.has(id) || this.calls.size >= MAX_ACTIVE_CALLS) return;
    const resolved = this.resolveName(modelToolName);
    const name = resolved !== undefined && SAFE_DISPLAY_NAME.test(resolved) ? resolved : undefined;
    const wasEmpty = this.calls.size === 0;
    this.calls.set(id, { toolCallId: id, ...(name === undefined ? {} : { name }) });
    if (wasEmpty) this.publish();
    else if (this.timer === undefined) {
      this.timer = setTimeout(() => this.publish(), this.intervalMs);
    }
  }

  delta(id: string): boolean {
    // Observed membership is already generating. No parameter body/counter is retained,
    // and an orphan delta does not invent a Tool identity or authorize any action.
    return !this.disposed && this.calls.has(id);
  }

  end(id: string): void {
    if (this.calls.delete(id)) this.publish();
  }

  clear(): void {
    const hadCalls = this.calls.size > 0;
    this.calls.clear();
    this.cancelTimer();
    if (hadCalls && !this.disposed) this.emit({ type: "tool-input-activity", calls: [] });
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(): void {
    this.cancelTimer();
    if (!this.disposed) this.emit({ type: "tool-input-activity", calls: [...this.calls.values()] });
  }
}
